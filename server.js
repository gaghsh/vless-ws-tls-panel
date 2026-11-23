require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

const PORT = Number(process.env.PORT || 3000);
const DOMAIN = String(process.env.DOMAIN || '').trim();
const WS_PATH = process.env.WS_PATH || '/vless';
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || '';
const USAGE_TOKEN = process.env.USAGE_TOKEN || '';
const DEFAULT_LIMIT = Number(process.env.LIMIT_BYTES || 536870912000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'users.json');
const XRAY_CONFIG_FILE = path.join(DATA_DIR, 'xray-config.json');
const XRAY_PORT = Number(process.env.XRAY_PORT || 10000);
const PANEL_PATH = '/' + String(process.env.PANEL_PATH || '').replace(/^\/+|\/+$/g, '');
const sessions = new Map();

if (!PANEL_PASSWORD || PANEL_PASSWORD === 'change-this-password') {
  console.error('Set a strong PANEL_PASSWORD environment variable before starting.');
  process.exit(1);
}
if (!DOMAIN) {
  console.error('Set DOMAIN to the public hostname used for TLS.');
  process.exit(1);
}
if (!WS_PATH.startsWith('/') || WS_PATH.includes('?') || WS_PATH.includes('#')) {
  console.error('WS_PATH must be an absolute URL path, e.g. /vless.');
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

function loadUsers() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not read users data:', error.message);
    return [];
  }
}

let users = loadUsers();

function saveUsers() {
  const tempFile = DATA_FILE + '.tmp';
  fs.writeFileSync(tempFile, JSON.stringify(users, null, 2), { mode: 0o600 });
  fs.renameSync(tempFile, DATA_FILE);
}

function bytes(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

function formatBytes(value) {
  const n = bytes(value);
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / 1024 ** i).toFixed(i ? 2 : 0)} ${units[i]}`;
}

function getSession(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/(?:^|;\s*)session=([a-f0-9]+)/);
  if (!match) return null;
  const created = sessions.get(match[1]);
  if (!created || Date.now() - created > 24 * 60 * 60 * 1000) {
    sessions.delete(match[1]);
    return null;
  }
  return match[1];
}

function isSecure(req) {
  return process.env.COOKIE_SECURE === 'true' || req.secure || req.headers['x-forwarded-proto'] === 'https';
}

function requireAuth(req, res, next) {
  if (getSession(req)) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

function vlessLink(user) {
  const host = encodeURIComponent(DOMAIN);
  const params = new URLSearchParams({ encryption: 'none', security: 'tls', type: 'ws', host: DOMAIN, path: WS_PATH });
  return `vless://${user.uuid}@${host}:443?${params.toString()}#${encodeURIComponent(user.name)}`;
}

function xrayConfig() {
  return {
    log: { loglevel: 'warning' },
    stats: {},
    api: { tag: 'api', services: ['StatsService'] },
    policy: { levels: { '0': { statsUserUplink: true, statsUserDownlink: true } }, system: { statsInboundUplink: true, statsInboundDownlink: true } },
    inbounds: [
      { listen: '127.0.0.1', port: XRAY_PORT, protocol: 'vless', settings: { clients: users.filter(u => u.enabled).map(u => ({ id: u.uuid, email: u.name })), decryption: 'none' }, streamSettings: { network: 'ws', security: 'none', wsSettings: { path: WS_PATH } }, tag: 'vless-ws' },
      { listen: '127.0.0.1', port: 10085, protocol: 'dokodemo-door', settings: { address: '127.0.0.1' }, tag: 'api-in' }
    ],
    outbounds: [{ protocol: 'freedom', tag: 'direct' }],
    routing: { rules: [{ type: 'field', inboundTag: ['api-in'], outboundTag: 'api' }] }
  };
}

function writeXrayConfig() {
  const temp = XRAY_CONFIG_FILE + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(xrayConfig(), null, 2), { mode: 0o600 });
  fs.renameSync(temp, XRAY_CONFIG_FILE);
}

function publicUser(user) {
  const total = bytes(user.upload) + bytes(user.download);
  return { ...user, link: vlessLink(user), total, totalHuman: formatBytes(total), uploadHuman: formatBytes(user.upload), downloadHuman: formatBytes(user.download), limitHuman: formatBytes(user.limit) };
}

app.get('/health', (_req, res) => res.json({ ok: true }));
app.post('/api/login', (req, res) => {
  const password = String(req.body?.password || '');
  const expected = Buffer.from(PANEL_PASSWORD);
  const received = Buffer.from(password);
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
    return res.status(401).json({ error: 'رمز ورود نادرست است' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now());
  res.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${isSecure(req) ? '; Secure' : ''}`);
  res.json({ ok: true });
});
app.post('/api/logout', requireAuth, (req, res) => {
  sessions.delete(getSession(req));
  res.setHeader('Set-Cookie', `session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${isSecure(req) ? '; Secure' : ''}`);
  res.json({ ok: true });
});
app.get('/api/session', (req, res) => res.json({ authenticated: Boolean(getSession(req)) }));

app.get('/api/users', requireAuth, (_req, res) => res.json(users.map(publicUser)));
app.post('/api/users', requireAuth, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 50);
  if (!name) return res.status(400).json({ error: 'نام کاربر لازم است' });
  if (users.some(u => u.name.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: 'این نام قبلاً ثبت شده است' });
  const requestedLimit = Number(req.body?.limit);
  const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? requestedLimit : DEFAULT_LIMIT;
  const user = { id: crypto.randomUUID(), name, uuid: crypto.randomUUID(), enabled: true, upload: 0, download: 0, limit, createdAt: new Date().toISOString() };
  users.push(user);
  saveUsers();
  writeXrayConfig();
  res.status(201).json(publicUser(user));
});
app.patch('/api/users/:id', requireAuth, (req, res) => {
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'کاربر پیدا نشد' });
  if (typeof req.body?.enabled === 'boolean') user.enabled = req.body.enabled;
  if (req.body?.limit !== undefined) {
    const limit = Number(req.body.limit);
    if (!Number.isSafeInteger(limit) || limit < 0) return res.status(400).json({ error: 'محدودیت نامعتبر است' });
    user.limit = limit;
  }
  saveUsers();
  writeXrayConfig();
  res.json(publicUser(user));
});
app.delete('/api/users/:id', requireAuth, (req, res) => {
  const previous = users.length;
  users = users.filter(u => u.id !== req.params.id);
  if (users.length === previous) return res.status(404).json({ error: 'کاربر پیدا نشد' });
  saveUsers();
  writeXrayConfig();
  res.json({ ok: true });
});
app.post('/api/users/:id/reset', requireAuth, (req, res) => {
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'کاربر پیدا نشد' });
  user.upload = 0;
  user.download = 0;
  saveUsers();
  res.json({ ok: true });
});

// Authenticated usage-ingest endpoint for an Xray stats collector or trusted monitoring agent.
// Values are cumulative byte counters. Configure a long random USAGE_TOKEN outside the repository.
app.post('/api/usage', (req, res) => {
  if (!USAGE_TOKEN || req.get('x-usage-token') !== USAGE_TOKEN) return res.status(401).json({ error: 'Invalid usage token' });
  const user = users.find(u => u.id === req.body?.id || u.uuid === req.body?.uuid);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (req.body?.upload === undefined || req.body?.download === undefined) return res.status(400).json({ error: 'upload and download are required' });
  user.upload = bytes(req.body.upload);
  user.download = bytes(req.body.download);
  saveUsers();
  res.json({ ok: true });
});

app.get('/api/subscription', requireAuth, (req, res) => {
  const links = users.filter(u => u.enabled).map(vlessLink).join('\n');
  res.setHeader('Cache-Control', 'no-store');
  res.type('text/plain').send(Buffer.from(links).toString('base64'));
});
app.get('/api/xray-config', requireAuth, (_req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="config.json"');
  res.json(xrayConfig());
});

app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', dotfiles: 'deny' }));
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'خطای داخلی سرور' });
});

writeXrayConfig();
app.listen(PORT, '0.0.0.0', () => console.log(`VLESS WS + TLS panel listening on ${PORT}; Xray config: ${XRAY_CONFIG_FILE}`));
