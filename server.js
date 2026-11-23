require('dotenv').config();

const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);
app.use(express.json({ limit: '1mb' }));

const PORT = Number(process.env.PORT || 3000);
const BIND_ADDRESS = process.env.BIND_ADDRESS || '127.0.0.1';
const DOMAIN = String(process.env.DOMAIN || '').trim();
const WS_PATH = process.env.WS_PATH || '/vless';
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || '';
const DEFAULT_LIMIT = Number(process.env.LIMIT_BYTES || 536870912000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'users.json');
const XRAY_CONFIG_FILE = path.join(DATA_DIR, 'xray-config.json');
const XRAY_PORT = Number(process.env.XRAY_PORT || 10000);
const XRAY_BIN = process.env.XRAY_BIN || 'xray';
const XRAY_STATS_ADDRESS = process.env.XRAY_STATS_ADDRESS || '127.0.0.1:10085';
const STATS_INTERVAL = Math.max(10, Number(process.env.STATS_INTERVAL || 30)) * 1000;
const sessions = new Map();
const loginAttempts = new Map();
let collecting = false;

if (!PANEL_PASSWORD || PANEL_PASSWORD.length < 16 || PANEL_PASSWORD === 'change-this-password') {
  console.error('Set a random PANEL_PASSWORD of at least 16 characters before starting.');
  process.exit(1);
}
if (!DOMAIN || !/^[a-z0-9.-]+$/i.test(DOMAIN)) {
  console.error('Set DOMAIN to the public hostname used for TLS.');
  process.exit(1);
}
if (!WS_PATH.startsWith('/') || WS_PATH.includes('?') || WS_PATH.includes('#') || WS_PATH.includes('..')) {
  console.error('WS_PATH must be a safe absolute URL path, e.g. /vless.');
  process.exit(1);
}
if (!Number.isSafeInteger(PORT) || PORT < 1 || PORT > 65535 || !Number.isSafeInteger(XRAY_PORT) || XRAY_PORT < 1 || XRAY_PORT > 65535) {
  console.error('PORT and XRAY_PORT must be valid TCP ports.');
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

let users = loadUsers().map(user => ({
  ...user,
  upload: bytes(user.upload),
  download: bytes(user.download),
  uploadOffset: bytes(user.uploadOffset),
  downloadOffset: bytes(user.downloadOffset),
  enabled: user.enabled !== false
}));

function atomicWrite(file, content) {
  const tempFile = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, content, { mode: 0o600 });
  fs.renameSync(tempFile, file);
}

function saveUsers() {
  atomicWrite(DATA_FILE, JSON.stringify(users, null, 2));
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
  const match = (req.headers.cookie || '').match(/(?:^|;\s*)session=([a-f0-9]+)/);
  if (!match) return null;
  const created = sessions.get(match[1]);
  if (!created || Date.now() - created > 24 * 60 * 60 * 1000) {
    sessions.delete(match[1]);
    return null;
  }
  return match[1];
}

function requireAuth(req, res, next) {
  if (getSession(req)) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

function vlessLink(user) {
  const params = new URLSearchParams({ encryption: 'none', security: 'tls', type: 'ws', host: DOMAIN, path: WS_PATH });
  return `vless://${user.uuid}@${encodeURIComponent(DOMAIN)}:443?${params.toString()}#${encodeURIComponent(user.name)}`;
}

function xrayConfig() {
  return {
    log: { loglevel: 'warning' },
    stats: {},
    api: { tag: 'api', services: ['StatsService'] },
    policy: {
      levels: { '0': { statsUserUplink: true, statsUserDownlink: true } },
      system: { statsInboundUplink: true, statsInboundDownlink: true }
    },
    inbounds: [
      {
        listen: '127.0.0.1', port: XRAY_PORT, protocol: 'vless',
        settings: { clients: users.filter(user => user.enabled).map(user => ({ id: user.uuid, email: user.name })), decryption: 'none' },
        streamSettings: { network: 'ws', security: 'none', wsSettings: { path: WS_PATH } }, tag: 'vless-ws'
      },
      { listen: '127.0.0.1', port: 10085, protocol: 'dokodemo-door', settings: { address: '127.0.0.1' }, tag: 'api-in' }
    ],
    outbounds: [{ protocol: 'freedom', tag: 'direct' }],
    routing: { rules: [{ type: 'field', inboundTag: ['api-in'], outboundTag: 'api' }] }
  };
}

function writeXrayConfig() {
  atomicWrite(XRAY_CONFIG_FILE, JSON.stringify(xrayConfig(), null, 2));
}

function totalBytes(user) {
  return bytes(user.upload) + bytes(user.download);
}

function publicUser(user) {
  const total = totalBytes(user);
  return {
    ...user, link: vlessLink(user), total, totalHuman: formatBytes(total),
    uploadHuman: formatBytes(user.upload), downloadHuman: formatBytes(user.download), limitHuman: formatBytes(user.limit)
  };
}

function readXrayCounter(name) {
  return new Promise(resolve => {
    execFile(XRAY_BIN, ['api', 'stats', '-s', XRAY_STATS_ADDRESS, '-name', name, '-reset=false'], { timeout: 10000 }, (error, stdout, stderr) => {
      if (error) return resolve({ ok: false, error: (stderr || error.message).trim() });
      const match = stdout.match(/value:\s*(\d+)/i);
      if (!match) return resolve({ ok: false, error: `Could not parse Xray stats response for ${name}` });
      const value = Number(match[1]);
      resolve(Number.isSafeInteger(value) ? { ok: true, value } : { ok: false, error: 'Xray counter is outside safe integer range' });
    });
  });
}

async function collectUsage() {
  if (collecting || !users.length) return;
  collecting = true;
  let changed = false;
  let countersSucceeded = 0;
  try {
    for (const user of users) {
      const [down, up] = await Promise.all([
        readXrayCounter(`user>>>${user.name}>>>traffic>>>downlink`),
        readXrayCounter(`user>>>${user.name}>>>traffic>>>uplink`)
      ]);
      if (!down.ok || !up.ok) continue;
      countersSucceeded += 1;

      if (Number.isSafeInteger(user.lastRawDownload) && down.value < user.lastRawDownload) user.downloadOffset = bytes(user.downloadOffset) + user.lastRawDownload;
      if (Number.isSafeInteger(user.lastRawUpload) && up.value < user.lastRawUpload) user.uploadOffset = bytes(user.uploadOffset) + user.lastRawUpload;
      user.lastRawDownload = down.value;
      user.lastRawUpload = up.value;
      user.download = bytes(user.downloadOffset) + down.value;
      user.upload = bytes(user.uploadOffset) + up.value;
      user.usageUpdatedAt = new Date().toISOString();
      changed = true;

      if (user.enabled && bytes(user.limit) > 0 && totalBytes(user) >= bytes(user.limit)) {
        user.enabled = false;
        user.limitReached = true;
        console.log(`[quota] disabled user ${user.name}: traffic limit reached`);
        writeXrayConfig();
      }
    }
    if (changed) saveUsers();
    if (users.length && !countersSucceeded) console.warn('[usage] Xray stats unavailable; preserving previous counters');
  } catch (error) {
    console.error('[usage] collection failed:', error.message);
  } finally {
    collecting = false;
  }
}

app.get('/health', (_req, res) => res.json({ ok: true }));
app.post('/api/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const attempt = loginAttempts.get(ip) || { count: 0, since: now };
  if (now - attempt.since > 10 * 60 * 1000) { attempt.count = 0; attempt.since = now; }
  if (attempt.count >= 10) return res.status(429).json({ error: 'تعداد تلاش زیاد است؛ چند دقیقه دیگر دوباره امتحان کنید.' });
  const password = String(req.body?.password || '');
  const expected = Buffer.from(PANEL_PASSWORD);
  const received = Buffer.from(password);
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
    attempt.count += 1;
    loginAttempts.set(ip, attempt);
    return res.status(401).json({ error: 'رمز ورود نادرست است' });
  }
  loginAttempts.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, now);
  const secure = process.env.COOKIE_SECURE !== 'false';
  res.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${secure ? '; Secure' : ''}`);
  res.json({ ok: true });
});
app.post('/api/logout', requireAuth, (req, res) => {
  sessions.delete(getSession(req));
  res.setHeader('Set-Cookie', `session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${process.env.COOKIE_SECURE !== 'false' ? '; Secure' : ''}`);
  res.json({ ok: true });
});
app.get('/api/session', (req, res) => res.json({ authenticated: Boolean(getSession(req)) }));

app.get('/api/users', requireAuth, (_req, res) => res.json(users.map(publicUser)));
app.post('/api/users', requireAuth, (req, res) => {
  const name = String(req.body?.name || '').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 50);
  if (!name) return res.status(400).json({ error: 'نام کاربر لازم است' });
  if (users.some(user => user.name.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: 'این نام قبلاً ثبت شده است' });
  const requestedLimit = Number(req.body?.limit);
  const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? requestedLimit : DEFAULT_LIMIT;
  const user = {
    id: crypto.randomUUID(), name, uuid: crypto.randomUUID(), enabled: true,
    upload: 0, download: 0, uploadOffset: 0, downloadOffset: 0, limit,
    createdAt: new Date().toISOString()
  };
  users.push(user);
  saveUsers();
  writeXrayConfig();
  res.status(201).json(publicUser(user));
});
app.patch('/api/users/:id', requireAuth, (req, res) => {
  const user = users.find(item => item.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'کاربر پیدا نشد' });
  if (typeof req.body?.enabled === 'boolean') {
    if (req.body.enabled && user.limitReached) return res.status(409).json({ error: 'حجم کاربر تمام شده؛ ابتدا مصرف را ریست کنید.' });
    user.enabled = req.body.enabled;
  }
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
  const previousLength = users.length;
  users = users.filter(user => user.id !== req.params.id);
  if (users.length === previousLength) return res.status(404).json({ error: 'کاربر پیدا نشد' });
  saveUsers();
  writeXrayConfig();
  res.json({ ok: true });
});
app.post('/api/users/:id/reset', requireAuth, (req, res) => {
  const user = users.find(item => item.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'کاربر پیدا نشد' });
  user.upload = 0; user.download = 0; user.uploadOffset = 0; user.downloadOffset = 0;
  user.lastRawUpload = 0; user.lastRawDownload = 0; user.limitReached = false; user.enabled = true;
  saveUsers();
  writeXrayConfig();
  res.json({ ok: true });
});

app.get('/api/subscription', requireAuth, (_req, res) => {
  const links = users.filter(user => user.enabled).map(vlessLink).join('\n');
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
app.listen(PORT, BIND_ADDRESS, () => {
  console.log(`VLESS WS + TLS panel listening on ${BIND_ADDRESS}:${PORT}`);
  collectUsage();
  setInterval(collectUsage, STATS_INTERVAL);
});
