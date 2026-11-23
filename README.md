# VLESS WS + TLS Panel

A small Node.js panel that manages VLESS users and generates an Xray configuration for **VLESS over WebSocket**. TLS is terminated by a reverse proxy such as Caddy; Xray listens on localhost only.

## Run

1. Install Node.js 18+ and Xray-core on a server you administer.
2. `npm install`
3. Copy `.env.example` to `.env`; set a strong `PANEL_PASSWORD`, your public `DOMAIN`, and a separate random `USAGE_TOKEN`.
4. `npm start`
5. The panel listens on `PORT` (default 3000). The generated Xray configuration is written to `data/xray-config.json`.

Keep `data/` private and persistent. Never commit `.env`, usage tokens, or generated Xray configuration. Put the panel behind HTTPS and restrict access to its admin URL.

## Xray and TLS

The panel writes an Xray VLESS+WS configuration with per-user UUIDs. Xray listens on `127.0.0.1:10000` by default, with WebSocket path from `WS_PATH`. Configure your TLS reverse proxy to terminate TLS for `DOMAIN` and forward that WebSocket path to `http://127.0.0.1:10000`. Validate the generated file with `xray run -test -config data/xray-config.json`, then restart Xray after adding, disabling, or deleting a user so the changed client list is loaded.

This app deliberately does not install binaries or run privileged system commands. Configure and supervise Xray and the TLS reverse proxy through your server's normal service manager.

## Traffic usage

Xray usage statistics are enabled in the generated config. The panel's `/api/usage` endpoint accepts cumulative `upload` and `download` byte counters for a user, identified by `id` or `uuid`, with `x-usage-token: $USAGE_TOKEN`. An external trusted collector must read the Xray Stats API and POST those counters; this repository does not yet include or automatically run that collector. Until connected, the panel's usage numbers remain zero. Limits are displayed but are not enforced by Xray.

## API summary

- `POST /api/login`, `POST /api/logout`
- `GET /api/users`; `POST /api/users`; `PATCH /api/users/:id`; `DELETE /api/users/:id`
- `POST /api/users/:id/reset`
- `GET /api/subscription` (authenticated, base64-encoded links)
- `GET /api/xray-config` (authenticated)
- `POST /api/usage` (requires `USAGE_TOKEN`)
