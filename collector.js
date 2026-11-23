require('dotenv').config();

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const USAGE_FILE = path.join(DATA_DIR, 'usage.json');
const DEFAULT_INTERVAL = 30;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') console.error(error.message); return fallback; }
}

function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

async function runXrayStats(name) {
  const xray = process.env.XRAY_BIN || 'xray';
  const args = ['api', 'stats', '-s', process.env.XRAY_STATS_ADDRESS || '127.0.0.1:10085', '-name', name, '-reset=false'];
  return new Promise(resolve => {
    execFile(xray, args, { timeout: 10000 }, (error, stdout, stderr) => {
      if (error) return resolve({ value: 0, error: stderr.trim() || error.message });
      const match = stdout.match(/value:\s*([0-9]+)/);
      resolve({ value: match ? Number(match[1]) : 0 });
    });
  });
}

async function collect() {
  const users = readJson(USERS_FILE, []);
  const previous = readJson(USAGE_FILE, {});
  const usage = {};

  for (const user of users) {
    if (!user.name) continue;
    const down = await runXrayStats(`user>>>${user.name}>>>traffic>>>downlink`);
    const up = await runXrayStats(`user>>>${user.name}>>>traffic>>>uplink`);
    const download = down.value;
    const upload = up.value;

    const old = previous[user.id] || {};
    const cumulative = {
      upload: bytesOrZero(upload) + (old.uploadAdditional || 0),
      download: bytesOrZero(download) + (old.downloadAdditional || 0)
    };

    if (Number.isFinite(upload) && Number.isFinite(old.lastUpload) && upload < old.lastUpload) {
      cumulative.upload += old.lastUpload;
    }
    if (Number.isFinite(download) && Number.isFinite(old.lastDownload) && download < old.lastDownload) {
      cumulative.download += old.lastDownload;
    }

    usage[user.id] = {
      upload: cumulative.upload,
      download: cumulative.download,
      lastUpload: upload,
      lastDownload: download,
      updatedAt: new Date().toISOString()
    };

    user.upload = cumulative.upload;
    user.download = cumulative.download;
  }

  saveJson(USAGE_FILE, usage);
  saveJson(USERS_FILE, users);
  console.log(`[usage] collected ${users.length} user(s) at ${new Date().toISOString()}`);
}

function bytesOrZero(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

collect().catch(error => console.error('[usage] collection failed:', error));
setInterval(() => collect().catch(error => console.error('[usage] collection failed:', error)), Number(process.env.STATS_INTERVAL || DEFAULT_INTERVAL) * 1000);
