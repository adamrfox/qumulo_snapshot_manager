'use strict';

const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const fetch = require('node-fetch');
const https = require('https');
const path = require('path');
const fs = require('fs');

// ── DB setup ──────────────────────────────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'qsnapman.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT UNIQUE NOT NULL,
    password   TEXT NOT NULL,
    role       TEXT NOT NULL DEFAULT 'user',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS clusters (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    host       TEXT NOT NULL,
    port       INTEGER NOT NULL DEFAULT 8000,
    username   TEXT NOT NULL,
    password   TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS savings_cache (
    cluster_id  INTEGER NOT NULL,
    snapshot_id INTEGER NOT NULL,
    bytes       INTEGER,
    error       TEXT,
    updated_at  TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (cluster_id, snapshot_id)
  );

  CREATE TABLE IF NOT EXISTS savings_jobs (
    cluster_id  INTEGER PRIMARY KEY,
    status      TEXT NOT NULL DEFAULT 'idle',
    total       INTEGER DEFAULT 0,
    completed   INTEGER DEFAULT 0,
    started_at  TEXT,
    updated_at  TEXT DEFAULT (datetime('now'))
  );
`);

// Seed default admin
const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
if (userCount === 0) {
  const hash = bcrypt.hashSync('admin', 12);
  db.prepare("INSERT INTO users (username, password, role) VALUES ('admin', ?, 'admin')").run(hash);
  console.log('Created default admin user (password: admin) — change this immediately!');
}

// Reset any jobs that were running when the server last stopped
db.prepare("UPDATE savings_jobs SET status='idle', updated_at=datetime('now') WHERE status='running'").run();

// ── Qumulo API helpers ────────────────────────────────────────────────────────
const agentCache = new Map();
function getAgent(host) {
  if (!agentCache.has(host)) agentCache.set(host, new https.Agent({ rejectUnauthorized: false }));
  return agentCache.get(host);
}

const tokenCache = new Map();

async function qumuloLogin(cluster) {
  const url = `https://${cluster.host}:${cluster.port}/v1/session/login`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: cluster.username, password: cluster.password }),
    agent: getAgent(cluster.host)
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Qumulo login failed: ${res.status} ${txt}`);
  }
  const data = await res.json();
  return data.bearer_token;
}

async function getToken(cluster) {
  const cached = tokenCache.get(cluster.id);
  if (cached && cached.expires > Date.now()) return cached.token;
  const token = await qumuloLogin(cluster);
  tokenCache.set(cluster.id, { token, expires: Date.now() + 9 * 60 * 1000 });
  return token;
}

async function qumuloGet(cluster, apiPath) {
  const token = await getToken(cluster);
  const url = `https://${cluster.host}:${cluster.port}${apiPath}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, agent: getAgent(cluster.host) });
  if (!res.ok) {
    if (res.status === 401) {
      tokenCache.delete(cluster.id);
      const token2 = await getToken(cluster);
      const res2 = await fetch(url, { headers: { Authorization: `Bearer ${token2}` }, agent: getAgent(cluster.host) });
      if (!res2.ok) throw new Error(`Qumulo API error: ${res2.status}`);
      return res2.json();
    }
    throw new Error(`Qumulo API error: ${res.status}`);
  }
  return res.json();
}

async function qumuloDelete(cluster, apiPath) {
  const token = await getToken(cluster);
  const url = `https://${cluster.host}:${cluster.port}${apiPath}`;
  const res = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` }, agent: getAgent(cluster.host) });
  if (!res.ok) throw new Error(`Qumulo DELETE error: ${res.status}`);
  return {};
}

// ── Savings job runner ────────────────────────────────────────────────────────
const cancelFlags = new Map();

const upsertCache  = db.prepare(`
  INSERT INTO savings_cache (cluster_id, snapshot_id, bytes, error, updated_at)
  VALUES (?, ?, ?, ?, datetime('now'))
  ON CONFLICT(cluster_id, snapshot_id) DO UPDATE SET
    bytes=excluded.bytes, error=excluded.error, updated_at=excluded.updated_at`);

const updateJob    = db.prepare(`
  INSERT INTO savings_jobs (cluster_id, status, total, completed, started_at, updated_at)
  VALUES (?, ?, ?, 0, datetime('now'), datetime('now'))
  ON CONFLICT(cluster_id) DO UPDATE SET
    status=excluded.status, total=excluded.total, completed=0,
    started_at=datetime('now'), updated_at=datetime('now')`);

const incrementJob = db.prepare(`
  UPDATE savings_jobs SET completed=completed+1, updated_at=datetime('now') WHERE cluster_id=?`);

const finishJob    = db.prepare(`
  UPDATE savings_jobs SET status=?, updated_at=datetime('now') WHERE cluster_id=?`);

async function runSavingsJob(cluster, snapshotIds) {
  const clusterId = cluster.id;
  cancelFlags.set(clusterId, false);
  updateJob.run(clusterId, 'running', snapshotIds.length);
  console.log(`[savings] Job started for cluster ${clusterId} — ${snapshotIds.length} snapshots`);

  let completed = 0;
  for (const snapId of snapshotIds) {
    if (cancelFlags.get(clusterId)) {
      console.log(`[savings] Job cancelled for cluster ${clusterId} at ${completed}/${snapshotIds.length}`);
      finishJob.run('cancelled', clusterId);
      return;
    }
    try {
      // Always get a fresh token — handles expiry mid-job
      const token = await getToken(cluster);
      const url = `https://${cluster.host}:${cluster.port}/v1/snapshots/calculate-used-capacity`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify([snapId]),
        agent: getAgent(cluster.host)
      });
      if (!res.ok) {
        // On 401, force token refresh and retry once
        if (res.status === 401) {
          tokenCache.delete(clusterId);
          const token2 = await getToken(cluster);
          const res2 = await fetch(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token2}`, 'Content-Type': 'application/json' },
            body: JSON.stringify([snapId]),
            agent: getAgent(cluster.host)
          });
          if (res2.ok) {
            const data2 = await res2.json();
            upsertCache.run(clusterId, snapId, parseInt(data2.bytes) || 0, null);
          } else {
            const txt2 = await res2.text();
            console.error(`[savings] Retry failed for snapshot ${snapId}: ${res2.status} ${txt2}`);
            upsertCache.run(clusterId, snapId, null, `Qumulo API: ${res2.status} ${txt2}`);
          }
        } else {
          const txt = await res.text();
          console.error(`[savings] Error for snapshot ${snapId}: ${res.status} ${txt}`);
          upsertCache.run(clusterId, snapId, null, `Qumulo API: ${res.status} ${txt}`);
        }
      } else {
        const data = await res.json();
        upsertCache.run(clusterId, snapId, parseInt(data.bytes) || 0, null);
      }
    } catch (e) {
      console.error(`[savings] Exception for snapshot ${snapId}:`, e.message);
      upsertCache.run(clusterId, snapId, null, e.message);
    }
    completed++;
    incrementJob.run(clusterId);
    if (completed % 100 === 0) {
      console.log(`[savings] Cluster ${clusterId}: ${completed}/${snapshotIds.length} complete`);
    }
  }

  finishJob.run('complete', clusterId);
  console.log(`[savings] Job complete for cluster ${clusterId}`);
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: DATA_DIR }),
  secret: process.env.SESSION_SECRET || 'qsnapman-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.status(401).json({ error: 'Not authenticated' });
}
function requireAdmin(req, res, next) {
  if (req.session && req.session.role === 'admin') return next();
  res.status(403).json({ error: 'Admin required' });
}

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'Invalid username or password' });
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role;
  res.json({ username: user.username, role: user.role });
});

app.post('/api/auth/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  res.json({ username: req.session.username, role: req.session.role });
});

// ── Users ─────────────────────────────────────────────────────────────────────
app.get('/api/users', requireAuth, requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT id, username, role, created_at FROM users ORDER BY id').all());
});

app.post('/api/users', requireAuth, requireAdmin, (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  const userRole = ['admin','user'].includes(role) ? role : 'user';
  try {
    const result = db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)').run(username, bcrypt.hashSync(password, 12), userRole);
    res.json({ id: result.lastInsertRowid, username, role: userRole });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username already exists' });
    throw e;
  }
});

app.delete('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.session.userId) return res.status(400).json({ error: 'Cannot delete yourself' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.put('/api/users/:id/password', requireAuth, requireAdmin, (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'password required' });
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(bcrypt.hashSync(password, 12), parseInt(req.params.id));
  res.json({ ok: true });
});

app.put('/api/auth/password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!bcrypt.compareSync(currentPassword, user.password)) return res.status(401).json({ error: 'Current password incorrect' });
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 12), req.session.userId);
  res.json({ ok: true });
});

// ── Clusters ──────────────────────────────────────────────────────────────────
app.get('/api/clusters', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT id, name, host, port, username, created_at FROM clusters ORDER BY name').all());
});

app.post('/api/clusters', requireAuth, requireAdmin, (req, res) => {
  const { name, host, port, username, password } = req.body;
  if (!name || !host || !username || !password) return res.status(400).json({ error: 'name, host, username, password required' });
  const result = db.prepare('INSERT INTO clusters (name, host, port, username, password) VALUES (?, ?, ?, ?, ?)').run(
    name, host, parseInt(port) || 8000, username, password);
  res.json({ id: result.lastInsertRowid, name, host, port: parseInt(port) || 8000, username });
});

app.put('/api/clusters/:id', requireAuth, requireAdmin, (req, res) => {
  const { name, host, port, username, password } = req.body;
  const id = parseInt(req.params.id);
  if (password) {
    db.prepare('UPDATE clusters SET name=?, host=?, port=?, username=?, password=? WHERE id=?').run(name, host, parseInt(port)||8000, username, password, id);
  } else {
    db.prepare('UPDATE clusters SET name=?, host=?, port=?, username=? WHERE id=?').run(name, host, parseInt(port)||8000, username, id);
  }
  tokenCache.delete(id);
  res.json({ ok: true });
});

app.delete('/api/clusters/:id', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  db.prepare('DELETE FROM clusters WHERE id = ?').run(id);
  db.prepare('DELETE FROM savings_cache WHERE cluster_id = ?').run(id);
  db.prepare('DELETE FROM savings_jobs WHERE cluster_id = ?').run(id);
  tokenCache.delete(id);
  res.json({ ok: true });
});

app.post('/api/clusters/:id/test', requireAuth, async (req, res) => {
  const cluster = db.prepare('SELECT * FROM clusters WHERE id = ?').get(parseInt(req.params.id));
  if (!cluster) return res.status(404).json({ error: 'Cluster not found' });
  try {
    tokenCache.delete(cluster.id);
    await getToken(cluster);
    res.json({ ok: true, message: 'Connection successful' });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ── Snapshots ─────────────────────────────────────────────────────────────────
app.get('/api/clusters/:id/snapshots', requireAuth, async (req, res) => {
  const cluster = db.prepare('SELECT * FROM clusters WHERE id = ?').get(parseInt(req.params.id));
  if (!cluster) return res.status(404).json({ error: 'Cluster not found' });
  try {
    let snapEntries = [];
    let lockMap = {};

    try {
      const v4Data = await qumuloGet(cluster, '/v4/snapshots/status/');
      snapEntries = v4Data.entries || [];
    } catch {
      const v3Data = await qumuloGet(cluster, '/v3/snapshots/?filter=all');
      snapEntries = v3Data.entries || [];
      const BATCH = 20;
      for (let i = 0; i < snapEntries.length; i += BATCH) {
        const batch = snapEntries.slice(i, i + BATCH);
        const results = await Promise.allSettled(batch.map(s => qumuloGet(cluster, `/v3/snapshots/status/${s.id}`)));
        results.forEach((r, idx) => { if (r.status === 'fulfilled') lockMap[batch[idx].id] = r.value.lock_key ?? null; });
      }
    }

    const capacityData = await qumuloGet(cluster, '/v1/snapshots/capacity-used-per-snapshot/');
    const capacityMap = {};
    for (const entry of (capacityData.entries || [])) {
      capacityMap[entry.id] = entry.capacity_used_bytes ?? entry.capacity_used ?? null;
    }

    const entries = snapEntries.map(s => ({
      ...s,
      size:     capacityMap[s.id] ?? null,
      lock_key: s.lock_key ?? lockMap[s.id] ?? null,
      owners:   s.owners ?? []
    }));

    res.json({ entries });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.delete('/api/clusters/:id/snapshots/:snapId', requireAuth, requireAdmin, async (req, res) => {
  const cluster = db.prepare('SELECT * FROM clusters WHERE id = ?').get(parseInt(req.params.id));
  if (!cluster) return res.status(404).json({ error: 'Cluster not found' });
  try {
    await qumuloDelete(cluster, `/v1/snapshots/${req.params.snapId}`);
    db.prepare('DELETE FROM savings_cache WHERE cluster_id=? AND snapshot_id=?').run(cluster.id, parseInt(req.params.snapId));
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ── Savings job API ───────────────────────────────────────────────────────────

// Get current job status + all cached results
app.get('/api/clusters/:id/savings/status', requireAuth, (req, res) => {
  const clusterId = parseInt(req.params.id);
  const job = db.prepare('SELECT * FROM savings_jobs WHERE cluster_id = ?').get(clusterId)
    || { cluster_id: clusterId, status: 'idle', total: 0, completed: 0 };
  const cached = db.prepare('SELECT snapshot_id, bytes, error FROM savings_cache WHERE cluster_id = ?').all(clusterId);
  res.json({ job, cached });
});

// Start a job — body: { snapshot_ids: [...] } in desired processing order
app.post('/api/clusters/:id/savings/start', requireAuth, async (req, res) => {
  const clusterId = parseInt(req.params.id);
  const cluster = db.prepare('SELECT * FROM clusters WHERE id = ?').get(clusterId);
  if (!cluster) return res.status(404).json({ error: 'Cluster not found' });

  const existing = db.prepare('SELECT status FROM savings_jobs WHERE cluster_id = ?').get(clusterId);
  if (existing && existing.status === 'running') return res.status(409).json({ error: 'Job already running' });

  const { snapshot_ids } = req.body;
  if (!Array.isArray(snapshot_ids) || snapshot_ids.length === 0)
    return res.status(400).json({ error: 'snapshot_ids array required' });

  // Respond immediately, job runs in background
  res.json({ ok: true, total: snapshot_ids.length });

  runSavingsJob(cluster, snapshot_ids).catch(e => {
    console.error(`[savings] Job error for cluster ${clusterId}:`, e.message);
    finishJob.run('error', clusterId);
  });
});

// Cancel a running job
app.post('/api/clusters/:id/savings/cancel', requireAuth, (req, res) => {
  cancelFlags.set(parseInt(req.params.id), true);
  res.json({ ok: true });
});

// Clear cached results (only when not running)
app.delete('/api/clusters/:id/savings/cache', requireAuth, (req, res) => {
  const clusterId = parseInt(req.params.id);
  const job = db.prepare('SELECT status FROM savings_jobs WHERE cluster_id = ?').get(clusterId);
  if (job && job.status === 'running') return res.status(409).json({ error: 'Cannot clear cache while job is running' });
  db.prepare('DELETE FROM savings_cache WHERE cluster_id = ?').run(clusterId);
  db.prepare('DELETE FROM savings_jobs WHERE cluster_id = ?').run(clusterId);
  res.json({ ok: true });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3010;
app.listen(PORT, () => console.log(`QSnapMan running on http://0.0.0.0:${PORT}`));
