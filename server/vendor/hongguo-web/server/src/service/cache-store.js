'use strict';
// Local maintenance: one cache owner in the media process, shared by writers and readers.
const fs = require('fs');
const path = require('path');
const Config = require('../util/config');
const Log = require('../util/log');
const references = new Map();

function cacheDir() {
  return path.resolve(Log.env('HONGGUO_STREAM_CACHE', null) ||
    path.join(Config.str('runtime.data_dir', null) || 'server', 'stream-cache'));
}
function retain(file) {
  references.set(file, (references.get(file) || 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (references.get(file) || 1) - 1;
    if (count) references.set(file, count);
    else references.delete(file);
  };
}
function number(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
function policy() {
  return { ttlMin: number('CACHE_TTL_MIN', 180), maxMb: number('CACHE_MAX_MB', 2048),
    maxFiles: number('HONGGUO_CACHE_MAX_FILES', 0), graceMs: 60000 };
}
function entries() {
  fs.mkdirSync(cacheDir(), { recursive: true });
  const rows = [];
  for (const name of fs.readdirSync(cacheDir())) {
    // Temporary work directories, ciphertext and raw containers are never playable cache.
    if (!name.endsWith('.mp4') || name.endsWith('.raw.mp4')) continue;
    const file = path.join(cacheDir(), name);
    try {
      const st = fs.statSync(file);
      if (st.isFile()) rows.push({ file, size: st.size, mtime: st.mtimeMs });
    } catch (_) {}
  }
  return rows.sort((a, b) => a.mtime - b.mtime);
}
function sweep(overrides = {}) {
  const p = { ...policy(), ...overrides };
  const rows = entries();
  let bytes = rows.reduce((n, row) => n + row.size, 0);
  let files = rows.length;
  let removed = 0;
  const now = Date.now();
  for (const name of p.cleanup === false ? [] : fs.readdirSync(cacheDir())) {
    if (!/^\.work-[\w-]+$/.test(name) && !/\.(?:raw\.mp4|part|enc)$/.test(name)) continue;
    const target = path.join(cacheDir(), name);
    if (references.has(target)) continue;
    try {
      if (now - fs.statSync(target).mtimeMs > 86400000) fs.rmSync(target, { recursive: true, force: true });
    } catch (_) {}
  }
  for (const row of rows) {
    if (references.has(row.file) || now - row.mtime < p.graceMs) continue;
    const expired = p.ttlMin > 0 && now - row.mtime > p.ttlMin * 60000;
    const over = (p.maxMb > 0 && bytes > p.maxMb * 1048576) || (p.maxFiles > 0 && files > p.maxFiles);
    if (!expired && !over) continue;
    try { fs.unlinkSync(row.file); bytes -= row.size; files--; removed++; } catch (_) {}
  }
  return removed;
}
function summary() {
  const rows = entries();
  const p = policy();
  return { dir: cacheDir(), files: rows.length,
    mb: Math.round(rows.reduce((n, row) => n + row.size, 0) / 104857.6) / 10,
    ttl_min: p.ttlMin, max_mb: p.maxMb, max_files: p.maxFiles };
}
function start() {
  const run = () => { try { sweep(); } catch (e) { Log.warn('缓存清理失败: ' + e.message); } };
  run();
  const timer = setInterval(run, Math.max(1, number('CACHE_SWEEP_SEC', 300)) * 1000);
  timer.unref();
  return timer;
}
module.exports = { cacheDir, retain, sweep, summary, start };
