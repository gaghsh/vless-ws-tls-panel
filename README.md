# VLESS WS + TLS Panel

A small management panel for VLESS over WebSocket with TLS terminated by Caddy and Xray-core. The included installer targets a fresh Debian 12 or Ubuntu 22.04/24.04 server. Use it only on a server and domain you control.

## One-command server setup

Requirements: a fresh supported Debian/Ubuntu VPS, a domain whose `A`/`AAAA` record points to that VPS, and provider/network firewall access for TCP 80 and 443 (keep SSH open). From the repository directory on that VPS, run:

```bash
sudo bash install.sh vpn.example.com
```

The script installs Node.js, Caddy, and Xray from their upstream repositories/installers; creates a restricted service account; configures systemd services; requests TLS through Caddy; and prints a generated panel password. Save that password. To choose your own strong password, pass it as the second argument. The installer will not overwrite an existing `/etc/vless-panel.env`.

After DNS has propagated and Caddy has obtained a certificate, open `https://your-domain/`, log in, add a user, and import the copied VLESS link into a compatible client. The installer does not open firewall ports automatically because doing so can lock out remote administration; permit TCP 80 and 443 at your VPS provider and host firewall.

## What the installer configures

- Caddy terminates HTTPS on 80/443 and reverse-proxies the configured WebSocket path to Xray on localhost.
- The panel and Xray run as an unprivileged `vless-panel` account. Node binds to `127.0.0.1`; Xray's VLESS and Stats API listeners are also loopback-only.
- systemd keeps the panel and Xray running. A systemd path unit restarts Xray after user/config changes.
- The panel polls Xray's per-user traffic counters every 30 seconds. When the configured quota is reached, it disables the account in generated Xray configuration; pressing Reset clears its counters and re-enables it. As with any periodic poll, quota enforcement may overshoot by traffic transferred during one polling interval.

## Manual development

Use Node.js 18+, set a strong `PANEL_PASSWORD`, a real `DOMAIN`, and a persistent writable `DATA_DIR` in `.env`, then run `npm install && npm start`. For production, put it behind HTTPS and configure Xray and the reverse proxy as the installer does. The standalone `collector.js` is obsolete; usage collection runs in the panel process to avoid competing writers.

## Service operations

```bash
sudo systemctl status vless-panel vless-panel-xray caddy
sudo journalctl -u vless-panel -u vless-panel-xray -f
sudo systemctl restart vless-panel
```

Panel state and generated Xray configuration live in `/var/lib/vless-panel`; secrets are in `/etc/vless-panel.env`. Back up both securely. Never publish panel credentials, generated user links, or the data directory.

## Limitations and checks

The installer is not a hosting-provider control panel and does not guarantee availability: DNS, provider firewall, ports in use, repository availability, and local regulations can affect setup. Check `xray run -test -config /var/lib/vless-panel/xray-config.json` and the systemd/Caddy logs if service startup or TLS issuance fails. Keep the operating system and dependencies updated.
