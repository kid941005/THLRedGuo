'use strict';
// Local supervisor: readiness requires a recent live health probe and an internal key.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const config = require('./config');

function createSupervisor(options = {}) {
  const url = options.url || config.UPSTREAM;
  const timeoutMs = options.timeoutMs || 2000;
  const pollMs = options.pollMs || 5000;
  const staleMs = options.staleMs || 15000;
  const state = { child: null, key: '', ready: false, checkedAt: 0, health: null };
  let stopped = false, generation = 0, monitor, restarting, pending;
  let failures = 0, spawnedAt = 0;
  let delay = 3000;
  function json(route) {
    return new Promise((resolve, reject) => {
      const req = http.get(url + route, res => {
        let text = '';
        res.on('error', reject);
        res.on('aborted', () => reject(new Error('probe aborted')));
        res.on('data', chunk => { text += chunk; if (text.length > 65536) req.destroy(new Error('probe too large')); });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(text) }); } catch (e) { reject(e); }
        });
      });
      const timer = setTimeout(() => req.destroy(new Error('probe timeout')), timeoutMs);
      req.once('close', () => clearTimeout(timer));
      req.once('error', reject);
    });
  }
  function persisted() {
    try { const keys = JSON.parse(fs.readFileSync(config.KEY_BACKUP, 'utf8')); return typeof keys.device_id === 'string' && Array.isArray(keys.keys); }
    catch (_) { return false; }
  }
  async function refresh() {
    if (stopped) return false;
    if (pending) return pending;
    const epoch = generation;
    pending = (async () => {
      try {
        const health = await json('/health');
        const key = await json('/api-key');
        if (health.status !== 200 || health.body.ok !== true || key.status !== 200 || typeof key.body.api_key !== 'string' || !key.body.api_key) throw new Error('not ready');
        if (stopped || epoch !== generation) return false;
        state.ready = true; state.key = key.body.api_key; state.health = health.body;
        state.checkedAt = Date.now(); delay = 3000; failures = 0;
        return true;
      } catch (_) {
        if (epoch === generation) {
          state.ready = false; state.key = ''; state.health = null; failures++;
          if (state.child && failures >= 3 && Date.now() - (state.checkedAt || spawnedAt) > 30000) state.child.kill('SIGKILL');
        }
        return false;
      } finally { pending = null; }
    })();
    return pending;
  }
  function monitorStart() {
    if (monitor) return;
    stopped = false;
    refresh();
    monitor = setInterval(refresh, pollMs);
    monitor.unref();
  }
  function restoreKeyBackup() {
    // Migrate a pre-volume runtime once; all subsequent key writes go straight to the volume.
    if (!fs.existsSync(config.KEY_BACKUP) && fs.existsSync(config.VENDOR_KEY_FILE)) {
      fs.mkdirSync(config.DATA_DIR, { recursive: true });
      fs.copyFileSync(config.VENDOR_KEY_FILE, config.KEY_BACKUP);
    }
  }
  function start() {
    stopped = false;
    if (state.child) return state.child;
    if (!fs.existsSync(config.VENDOR_ENTRY)) throw new Error('Missing vendor entry');
    const child = spawn(process.execPath, [config.VENDOR_ENTRY], {
      cwd: config.VENDOR_ROOT,
      env: { ...process.env, PORT: String(config.HK_PORT), BIND_HOST: '127.0.0.1', HG_OPEN_BROWSER: '0',
        HONGGUO_KEY_FILE: config.KEY_BACKUP, HONGGUO_DATA_DIR: config.DATA_DIR,
        HONGGUO_STREAM_CACHE: config.CACHE_DIR, HONGGUO_DOWNLOAD_DIR: path.join(config.DATA_DIR, 'downloads') },
      stdio: 'inherit', windowsHide: true,
    });
    state.child = child;
    spawnedAt = Date.now(); failures = 0;
    child.once('error', e => console.error('[gateway] upstream process error:', e.message));
    child.once('close', code => {
      if (state.child !== child) return;
      state.child = null; state.ready = false; state.key = ''; state.health = null; generation++;
      if (stopped) return;
      console.error('[gateway] upstream exited:', code);
      const wait = delay; delay = Math.min(60000, delay * 2);
      restarting = setTimeout(() => { restarting = null; start(); }, wait);
      restarting.unref();
    });
    monitorStart();
    refresh();
    return child;
  }
  function stop() {
    stopped = true; generation++; state.ready = false; state.key = '';
    clearInterval(monitor); monitor = null;
    clearTimeout(restarting); restarting = null;
    if (state.child) state.child.kill('SIGTERM');
  }
  async function wait(timeout) {
    const until = Date.now() + timeout;
    while (!stopped && Date.now() < until) { if (await refresh()) return true; await new Promise(r => setTimeout(r, 200)); }
    return false;
  }
  return { start, stop, wait, refresh, startMonitor: monitorStart, restoreKeyBackup,
    ensureKey: async () => { await refresh(); return state.key; },
    getKey: () => state.key,
    isReady: () => !stopped && state.ready && !!state.key && Date.now() - state.checkedAt < staleMs,
    devicePersisted: persisted, getHealth: () => state.health };
}
module.exports = { ...createSupervisor(), createSupervisor };
