# QSnapMan — Qumulo Snapshot Manager

A self-hosted web application for managing snapshots across one or more Qumulo clusters. Provides a clean, sortable, filterable snapshot inventory with space usage, deletion savings estimates, and one-click deletion.

## Features

- **Multi-cluster support** — add any number of Qumulo clusters, switch between them with one click
- **Snapshot table** — name, ID, created date, expiry, space consumed, and estimated savings if deleted
- **Sortable columns** — click any column header to sort ascending/descending
- **Filter by name** — live filter as you type
- **Deletion savings estimate** — calls the Qumulo API to estimate how much space would be freed
- **Delete snapshot** — with confirmation dialog showing the savings estimate
- **SSL bypass** — uses `rejectUnauthorized: false` so self-signed or no-cert clusters work fine
- **User authentication** — session-based login, bcrypt-hashed passwords in SQLite
- **User management** — admin users can create/delete accounts and reset passwords
- **Containerized** — Dockerfile + docker-compose for easy deployment

## Quick Start (Docker Compose)

```bash
# 1. Clone / copy files into a directory
mkdir qsnapman && cd qsnapman
# copy files here

# 2. Edit docker-compose.yml — change SESSION_SECRET to something random

# 3. Build and start
docker compose up -d --build

# 4. Open http://your-host:3010
# Default login: admin / admin   ← change this immediately!
```

## Running Without Docker

```bash
npm install
node server.js
# App runs on http://localhost:3010
```

Environment variables:
| Variable         | Default                       | Description                     |
|-----------------|-------------------------------|----------------------------------|
| `PORT`          | `3010`                        | HTTP port to listen on          |
| `DATA_DIR`      | `./data`                      | Where SQLite databases are stored|
| `SESSION_SECRET`| `qsnapman-dev-secret-change-me`| Express session signing secret  |

## Data Persistence

All data (user accounts, cluster connections, sessions) is stored in SQLite at `$DATA_DIR/qsnapman.db`. When using Docker, the `qsnapman-data` volume is mounted at `/data`. Back up that volume to preserve your configuration.

## Qumulo API Details

QSnapMan uses the Qumulo REST API v3:

| Action                  | Endpoint                                               |
|-------------------------|--------------------------------------------------------|
| Login / get token       | `POST /v1/session/login`                               |
| List snapshots          | `GET /v3/snapshots/`                                   |
| Estimate deletion savings| `POST /v3/snapshots/{id}/estimate-deletion-savings/`  |
| Delete snapshot         | `DELETE /v3/snapshots/{id}/`                           |

The API user needs sufficient permissions to list and delete snapshots. A read-only account works for browsing (deletion will fail gracefully).

Bearer tokens are cached for 9 minutes and automatically refreshed. A 401 response triggers an immediate token refresh and retry.

## Security Notes

- Change the default `admin` password immediately after first login
- Set `SESSION_SECRET` to a long random string in production (e.g., `openssl rand -hex 32`)
- Cluster passwords are stored in plaintext in the SQLite database — ensure the `DATA_DIR` is appropriately protected
- The SSL bypass (`rejectUnauthorized: false`) applies only to Qumulo API calls, not to the web app itself
- Sessions expire after 8 hours of inactivity

## Adding Clusters

1. Go to **Clusters** in the top nav
2. Click **+ Add Cluster**
3. Enter the display name, host/IP, API port (default 8000), and credentials
4. Use **Test** to verify connectivity before saving

## Nginx Reverse Proxy (optional)

```nginx
server {
    listen 80;
    server_name qsnapman.internal;
    location / {
        proxy_pass http://localhost:3010;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```
