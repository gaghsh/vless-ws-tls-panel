# VLESS WS + TLS Panel

A minimal Node.js panel for creating and managing a **VLESS over WebSocket with TLS** profile.

## Features

- Password-protected panel
- Create, enable, and disable VLESS users
- Generate a standard `vless://` link
- Base64 subscription output
- In-memory usage counters
- Optional Xray usage integration endpoint

## Run locally

```bash
npm install
cp .env.example .env
npm start
```

Open `http://localhost:3000`.

## Production

Set these environment variables:

- `PANEL_PASSWORD`: panel login password
- `DOMAIN`: public domain or hostname
- `UUID`: shared VLESS UUID
- `WS_PATH`: WebSocket path, for example `/vless`
- `LIMIT_BYTES`: default traffic limit per user
- `USAGE_TOKEN`: optional secret for usage update API

This project provides the control panel and link/subscription generator. Serve port 3000 behind Nginx/Caddy or a TLS reverse proxy, and run Xray-core with the matching WebSocket inbound. This is an implementation starting point, not a complete Xray installer.
