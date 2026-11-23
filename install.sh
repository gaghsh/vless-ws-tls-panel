#!/usr/bin/env bash
set -Eeuo pipefail

# Supported target: fresh Debian 12 / Ubuntu 22.04 or 24.04 server with a public IPv4/IPv6.
# Run from the checked-out project directory: sudo bash install.sh your.domain [panel-password]
if [[ $EUID -ne 0 ]]; then echo 'Run as root, e.g. sudo bash install.sh vpn.example.com' >&2; exit 1; fi
if [[ $# -lt 1 || $# -gt 2 ]]; then echo 'Usage: sudo bash install.sh DOMAIN [PANEL_PASSWORD]' >&2; exit 2; fi
DOMAIN="$1"
PANEL_PASSWORD="${2:-$(openssl rand -hex 24 2>/dev/null || true)}"
if [[ ! "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]]; then echo 'Invalid domain name.' >&2; exit 2; fi
if [[ ${#PANEL_PASSWORD} -lt 16 || "$PANEL_PASSWORD" == *$'\n'* ]]; then echo 'Panel password must be at least 16 characters and contain no newline.' >&2; exit 2; fi
if [[ ! -f package.json || ! -f server.js || ! -d public ]]; then echo 'Run this script from the project root.' >&2; exit 2; fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg openssl debian-keyring debian-archive-keyring apt-transport-https

# Install a supported Node.js LTS if the distro version is too old.
if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 18 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# Install Caddy from its official Debian package repository.
install -d -m 0755 /etc/apt/keyrings
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /etc/apt/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' -o /etc/apt/sources.list.d/caddy-stable.list
chmod o+r /etc/apt/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy

# Install Xray-core using the upstream installer. The app does not expose its API port publicly.
bash -c "$(curl -fsSL https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install
XRAY_BIN="$(command -v xray || true)"
if [[ -z "$XRAY_BIN" ]]; then echo 'Xray installation failed: xray binary not found.' >&2; exit 1; fi

id -u vless-panel >/dev/null 2>&1 || useradd --system --home-dir /var/lib/vless-panel --create-home --shell /usr/sbin/nologin vless-panel
install -d -o vless-panel -g vless-panel -m 0750 /var/lib/vless-panel
install -d -o root -g root -m 0755 /opt/vless-panel
cp -a package.json package-lock.json index.js server.js public /opt/vless-panel/ 2>/dev/null || cp -a package.json index.js server.js public /opt/vless-panel/
chown -R root:root /opt/vless-panel
cd /opt/vless-panel
npm install --omit=dev

if [[ -e /etc/vless-panel.env ]]; then
  echo '/etc/vless-panel.env already exists; refusing to overwrite it. Back it up and remove it to reinstall.' >&2
  exit 1
fi
USAGE_TOKEN="$(openssl rand -hex 32)"
umask 077
cat > /etc/vless-panel.env <<EOF
PORT=3000
BIND_ADDRESS=127.0.0.1
PANEL_PASSWORD=${PANEL_PASSWORD}
DOMAIN=${DOMAIN}
WS_PATH=/vless
XRAY_PORT=10000
XRAY_BIN=${XRAY_BIN}
XRAY_STATS_ADDRESS=127.0.0.1:10085
STATS_INTERVAL=30
COOKIE_SECURE=true
LIMIT_BYTES=536870912000
DATA_DIR=/var/lib/vless-panel
EOF
chown root:vless-panel /etc/vless-panel.env
chmod 0640 /etc/vless-panel.env

cat > /etc/systemd/system/vless-panel.service <<'EOF'
[Unit]
Description=VLESS management panel
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=vless-panel
Group=vless-panel
WorkingDirectory=/opt/vless-panel
EnvironmentFile=/etc/vless-panel.env
ExecStart=/usr/bin/node /opt/vless-panel/index.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/vless-panel
ProtectHome=true
[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/vless-panel-xray.service <<EOF
[Unit]
Description=Xray service for VLESS panel
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=vless-panel
Group=vless-panel
ExecStartPre=${XRAY_BIN} run -test -config /var/lib/vless-panel/xray-config.json
ExecStart=${XRAY_BIN} run -config /var/lib/vless-panel/xray-config.json
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadOnlyPaths=/var/lib/vless-panel/xray-config.json
ProtectHome=true
[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/vless-panel-xray-reload.path <<'EOF'
[Unit]
Description=Watch generated Xray configuration
[Path]
PathChanged=/var/lib/vless-panel/xray-config.json
Unit=vless-panel-xray-reload.service
[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/vless-panel-xray-reload.service <<'EOF'
[Unit]
Description=Restart Xray after panel config changes
[Service]
Type=oneshot
ExecStart=/bin/systemctl restart vless-panel-xray.service
EOF

cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
  @vless path /vless*
  reverse_proxy @vless 127.0.0.1:10000
  reverse_proxy 127.0.0.1:3000
}
EOF

systemctl daemon-reload
systemctl enable --now vless-panel.service
# Wait for the app's first config write, then validate/start Xray and monitor future updates.
for _ in $(seq 1 30); do [[ -s /var/lib/vless-panel/xray-config.json ]] && break; sleep 1; done
if [[ ! -s /var/lib/vless-panel/xray-config.json ]]; then echo 'Panel did not generate Xray configuration.' >&2; journalctl -u vless-panel.service -n 50 --no-pager; exit 1; fi
systemctl enable --now vless-panel-xray.service vless-panel-xray-reload.path
systemctl enable --now caddy
systemctl reload caddy

cat <<EOF

Installation complete.
Panel: https://${DOMAIN}/
Panel password: ${PANEL_PASSWORD}

IMPORTANT: Point the domain A/AAAA records to this server and allow inbound TCP ports 80 and 443 (plus SSH) in your provider firewall. Do not expose ports 3000, 10000, or 10085. Caddy will obtain the TLS certificate automatically after DNS and firewall are correct.

Services: systemctl status vless-panel vless-panel-xray caddy
Logs: journalctl -u vless-panel -u vless-panel-xray -f
EOF
