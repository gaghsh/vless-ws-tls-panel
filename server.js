require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

const PORT = Number(process.env.PORT || 3000);
const DOMAIN = process.env.DOMAIN || 'example.com';
const WS_PATH = process.env.WS_PATH || '/vless';
const UUID = process.env.UUID || '11111111-1111-1111-1111-111111111111';
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || 'change-this-password';
const USAGE_TOKEN = process.env.USAGE_TOKEN || '';
const DEFAULT_LIMIT = Number(process.env.LIMIT_BYTES || 536870912000);
const DATA_FILE = path.join(__dirname, 'data.json');

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (_) {
    return [];
  }
}

function saveUsers(users) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(users, null, 2));
}

let users = loadUsers();

function safeText(value, max = 100) {
  return String(value || '').trim().slice(0, max);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i ? 2 : 0)} ${units[i]}`;
}

function makeSessionCookie() {
  return crypto.randomBytes(24).toString('hex');
}

const sessions = new Map();

function authorized(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(?:^|;\s*)session=([^;]+)/);
  return Boolean(match && sessions.has(match[1]));
}

function requireAuth(req, res, next) {
  if (authorized(req)) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

function vlessLink(user) {
  const name = encodeURIComponent(user.name);
  const host = encodeURIComponent(DOMAIN);
  const pathValue = encodeURIComponent(WS_PATH);
  return `vless://${user.uuid}@${host}:443?encryption=none&security=tls&type=ws&host=${host}&path=${pathValue}#${name}`;
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/api/login', (req, res) => {
  if (safeText(req.body.password, 200) !== PANEL_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  const token = makeSessionCookie();
  sessions.set(token, Date.now());
  res.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);
  res.json({ ok: true });
});

app.post('/api/logout', requireAuth, (_req, res) => {
  const match = (_req.headers.cookie || '').match(?:^|;\s*)session=([^;]+)/);
  if (match) sessions.delete(match[1]);
  res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/session', (req, res) => res.json({ authenticated: authorized(req) }));

app.get('/api/users', requireAuth, (_req, res) => {
  res.json(users.map(user => ({
    ...user,
    link: vlessLink(user),
    uploadHuman: formatBytes(user.upload || 0),
    downloadHuman: formatBytes(user.download || 0),
    totalHuman: formatBytes((user.upload || 0) + (user.download || 0)),
    limitHuman: formatBytes(user.limit || 0)
  })));
});

app.post('/api/users', requireAuth, (req, res) => {
  const name = safeText(req.body.name, 50);
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (users.some(user => user.name.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ error: 'User already exists' });
  }

  const limit = Number(req.body.limit || DEFAULT_LIMIT);
  const user = {
    id: crypto.randomUUID(),
    name,
    uuid: UUID,
    enabled: true,
    upload: 0,
    download: 0,
    limit: Number.isFinite(limit) && limit >= 0 ? limit : DEFAULT_LIMIT,
    createdAt: new Date().toISOString()
  };

  users.push(user);
  saveUsers(users);
  res.status(201).json({ ...user, link: vlessLink(user) });
});

app.patch('/api/users/:id', requireAuth, (req, res) => {
  const user = users.find(item => item.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (typeof req.body.enabled === 'boolean') user.enabled = req.body.enabled;
  if (req.body.limit !== undefined) {
    const limit = Number(req.body.limit);
    if (!Number.isFinite(limit) || limit < 0) {
      return res.status(400).json({ error: 'Invalid limit' });
    }
    user.limit = limit;
  }

  saveUsers(users);
  res.json({ ...user, link: vlessLink(user) });
});

app.delete('/api/users/:id', requireAuth, (req, res) => {
  const before = users.length;
  users = users.filter(user => user.id !== req.params.id);
  if (users.length === before) return res.status(404).json({ error: 'User not found' });
  saveUsers(users);
  res.json({ ok: true });
});

app.post('/api/users/:id/reset', requireAuth, (req, res) => {
  const user = users.find(item => item.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.upload = 0;
  user.download = 0;
  saveUsers(users);
  res.json({ ok: true });
});

app.post('/api/usage', (req, res) => {
  if (USAGE_TOKEN && req.headers['x-usage-token'] !== USAGE_TOKEN) {
    return res.status(401).json({ error: 'Invalid usage token' });
  }

  const user = users.find(item => item.id === req.body.id || item.name === req.body.name);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const upload = Number(req.body.upload || 0);
  const download = Number(req.body.download || 0);
  if (!Number.isFinite(upload) || !Number.isFinite(download) || upload < 0 || download < 0) {
    return res.status(400).json({ error: 'Invalid usage values' });
  }

  user.upload = upload;
  user.download = download;
  saveUsers(users);
  res.json({ ok: true });
});

app.get('/api/subscription', (req, res) => {
  const links = users
    .filter(user => user.enabled)
    .map(vlessLink)
    .join('\n');
  res.type('text/plain').send(Buffer.from(links).toString('base64'));
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`VLESS panel listening on port ${PORT}`);
});
