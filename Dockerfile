FROM node:20-alpine

# Install build deps for better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js ./
COPY public/ ./public/

# Data directory (mount a volume here for persistence)
RUN mkdir -p /data
ENV DATA_DIR=/data

EXPOSE 3010

CMD ["node", "server.js"]
