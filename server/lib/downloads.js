'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { fail } = require('./accounts');
const { metadata, numericId } = require('./library');

function createDownloads(store, { dataDir, provider, upstreamUrl, maxBytes = 10 * 1073741824, concurrency = 2, fetcher = fetch, pollMs = 1500 } = {}) {
  const { db, transaction, audit } = store;
  const dir = path.join(dataDir, 'downloads');
  fs.mkdirSync(dir, { recursive: true });
  const active = new Map();
  let stopped = false, scheduled = false;
  function file(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) fail(400, '任务编号无效');
    return path.join(dir, id + '.mp4');
  }
  function snapshot(row) {
    return { id: row.id, user_id: row.user_id, series: JSON.parse(row.metadata), vid: row.vid, episode: row.episode, quality: row.quality,
      state: row.state, bytes: row.bytes, total: row.total, error: row.error, created_at: row.created_at, updated_at: row.updated_at };
  }
  function get(user, id) {
    const row = db.prepare('SELECT * FROM downloads WHERE id=?').get(id);
    if (!row || (row.user_id !== user.id && user.role !== 'admin')) fail(404, '任务不存在');
    return row;
  }
  async function upstream(route, signal) {
    const response = await fetcher(upstreamUrl + route, { headers: { 'x-api-key': provider.getKey() }, signal });
    return response;
  }
  async function upstreamJson(route, signal) {
    const response = await upstream(route, signal);
    if (!response.ok) { let message = ''; try { const body = await response.json(); message = body.detail || body.error || ''; } catch (_) {} fail(502, '取流服务请求失败 ' + response.status + (message ? '：' + message : '')); }
    return response.json();
  }
  async function enqueue(user, body) {
    const item = metadata(body.series);
    if (!Array.isArray(body.episodes) || !body.episodes.length || body.episodes.length > 200 || body.episodes.some(n => !Number.isInteger(n) || n < 1 || n > 10000)) fail(400, '每次请选择 1～200 集');
    const quality = body.quality || 'best';
    if (!/^(best|auto|\d{3,4}p?)$/.test(quality)) fail(400, '清晰度无效');
    const detail = await upstreamJson('/episodes?series_id=' + item.series_id, AbortSignal.timeout(30000));
    const wanted = new Set(body.episodes);
    const selected = (detail.episodes || []).filter(ep => wanted.has(Number(ep.index)) && /^\d{1,30}$/.test(String(ep.vid)));
    if (selected.length !== wanted.size) fail(400, '部分分集已不可用，请刷新分集后重试');
    const current = db.prepare('SELECT u.disabled FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=? AND s.hash=? AND s.expires_at>?').get(user.id, user.session_hash, Date.now());
    if (!current || current.disabled) fail(403, '账号不可用');
    const ids = transaction(() => {
      if (db.prepare('SELECT COUNT(*) AS count FROM downloads WHERE user_id=?').get(user.id).count + selected.length > 500 ||
          db.prepare('SELECT COUNT(*) AS count FROM downloads').get().count + selected.length > 5000) fail(409, '任务数量已达上限，请先删除旧任务');
      return selected.map(ep => {
        const existing = db.prepare('SELECT id FROM downloads WHERE user_id=? AND series_id=? AND vid=? AND quality=?').get(user.id, item.series_id, String(ep.vid), quality);
        if (existing) return existing.id;
        const id = crypto.randomUUID(), now = Date.now();
        db.prepare('INSERT INTO downloads(id,user_id,series_id,metadata,vid,episode,quality,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(id, user.id, item.series_id, JSON.stringify(item), String(ep.vid), Number(ep.index), quality, 'queued', now, now);
        return id;
      });
    });
    schedule(); return { ids };
  }
  function schedule() {
    if (scheduled || stopped) return;
    scheduled = true;
    setImmediate(() => { scheduled = false; pump(); });
  }
  function list(user, all = false) {
    const rows = all && user.role === 'admin' ? db.prepare('SELECT * FROM downloads ORDER BY created_at DESC LIMIT 5000').all() :
      db.prepare('SELECT * FROM downloads WHERE user_id=? ORDER BY created_at DESC LIMIT 500').all(user.id);
    return rows.map(snapshot);
  }
  const readyBytes = () => Number(db.prepare("SELECT COALESCE(SUM(bytes),0) AS bytes FROM downloads WHERE state='ready'").get().bytes);
  function usage() { return { bytes: readyBytes() + [...active.values()].reduce((sum, task) => sum + task.bytes, 0), maxBytes }; }
  async function run(row, task) {
    const signal = AbortSignal.any([task.controller.signal, AbortSignal.timeout(600000)]);
    const dest = file(row.id), temporary = dest + '.part';
    try {
      let first = true;
      for (;;) {
        signal.throwIfAborted();
        const prepared = await upstreamJson('/prepare?vid=' + row.vid + '&quality=' + encodeURIComponent(row.quality) + '&background=1' + (first ? '&retry=1' : ''), signal);
        first = false;
        if (prepared.state === 'failed') throw new Error(prepared.error || '媒体准备失败');
        if (prepared.state === 'ready') break;
        await new Promise((resolve, reject) => {
          const aborted = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted); reject(signal.reason); };
          const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, pollMs);
          signal.addEventListener('abort', aborted, { once: true });
          if (signal.aborted) aborted();
        });
      }
      const response = await upstream('/stream?vid=' + row.vid + '&quality=' + encodeURIComponent(row.quality), signal);
      if (response.status !== 200 || !response.body) throw new Error('媒体读取失败 HTTP ' + response.status);
      const total = Number(response.headers.get('content-length')) || 0;
      if (total > 512 * 1048576 || usage().bytes + total > maxBytes) { await response.body.cancel(); throw new Error('下载空间不足，请删除已完成任务后重试'); }
      db.prepare('UPDATE downloads SET total=? WHERE id=?').run(total, row.id);
      let savedAt = 0;
      const meter = new Transform({ transform(chunk, encoding, callback) {
        if (task.bytes + chunk.length > 512 * 1048576 || usage().bytes + chunk.length > maxBytes) { callback(new Error('下载空间不足')); return; }
        task.bytes += chunk.length;
        if (Date.now() - savedAt > 300) { savedAt = Date.now(); db.prepare('UPDATE downloads SET bytes=?,updated_at=? WHERE id=?').run(task.bytes, savedAt, row.id); }
        callback(null, chunk);
      } });
      await pipeline(response.body, meter, fs.createWriteStream(temporary, { flags: 'w', mode: 0o600 }), { signal });
      if (!task.bytes || (total && total !== task.bytes)) throw new Error('媒体文件不完整');
      signal.throwIfAborted();
      fs.renameSync(temporary, dest);
      db.prepare("UPDATE downloads SET state='ready',bytes=?,total=?,error='',updated_at=? WHERE id=? AND state='downloading'").run(task.bytes, task.bytes, Date.now(), row.id);
      task.bytes = 0;
    } catch (error) {
      db.prepare("UPDATE downloads SET state=?,bytes=0,error=?,updated_at=? WHERE id=? AND state='downloading'")
        .run(task.controller.signal.aborted ? (stopped ? 'queued' : 'cancelled') : 'failed', String(error.message || error).slice(0, 500), Date.now(), row.id);
      try { fs.unlinkSync(dest); } catch (_) {}
    } finally { try { fs.unlinkSync(temporary); } catch (_) {} }
  }
  function pump() {
    if (stopped) return;
    while (active.size < concurrency) {
      const row = db.prepare("SELECT d.* FROM downloads d JOIN users u ON u.id=d.user_id WHERE d.state='queued' AND u.disabled=0 ORDER BY d.created_at LIMIT 1").get();
      if (!row) break;
      db.prepare("UPDATE downloads SET state='downloading',bytes=0,total=0,error='',updated_at=? WHERE id=?").run(Date.now(), row.id);
      const task = { controller: new AbortController(), bytes: 0 };
      active.set(row.id, task);
      task.promise = run(row, task).finally(() => { active.delete(row.id); schedule(); });
    }
  }
  async function action(user, id, command) {
    const row = get(user, id), task = active.get(id);
    if (!['cancel', 'retry', 'delete'].includes(command)) fail(400, '任务操作无效');
    if (command === 'retry') {
      if (!['failed', 'cancelled'].includes(row.state)) fail(409, '任务不需要重试');
      db.prepare("UPDATE downloads SET state='queued',error='',bytes=0,total=0,updated_at=? WHERE id=?").run(Date.now(), id); schedule();
    } else {
      if (task) { task.controller.abort(); await task.promise; }
      if (command === 'delete') {
        // id was validated by file(); paths are always generated inside the download directory.
        try { fs.unlinkSync(file(id)); } catch (error) { if (error.code !== 'ENOENT') fail(409, '文件正在使用，请稍后重试'); }
        db.prepare('DELETE FROM downloads WHERE id=?').run(id);
      } else if (['queued', 'downloading'].includes(row.state)) {
        db.prepare("UPDATE downloads SET state='cancelled',error='',updated_at=? WHERE id=?").run(Date.now(), id);
      }
    }
    if (user.role === 'admin' && row.user_id !== user.id) audit(user.id, 'download-' + command, id);
    return { ok: true };
  }
  function readyFile(user, id) {
    const row = get(user, id), fullPath = file(id);
    if (row.state !== 'ready') fail(409, '下载尚未完成');
    if (!fs.existsSync(fullPath)) { db.prepare("UPDATE downloads SET state='failed',bytes=0,error='文件已丢失' WHERE id=?").run(id); fail(404, '文件已丢失，请重试任务'); }
    return { row, file: fullPath, name: JSON.parse(row.metadata).title + '_第' + row.episode + '集.mp4' };
  }
  function start() {
    stopped = false;
    db.exec("UPDATE downloads SET state='queued',bytes=0,total=0,error='' WHERE state='downloading'");
    for (const row of db.prepare('SELECT id,state FROM downloads').all()) {
      try { fs.unlinkSync(file(row.id) + '.part'); } catch (_) {}
      if (row.state === 'ready' && !fs.existsSync(file(row.id))) db.prepare("UPDATE downloads SET state='failed',bytes=0,error='文件已丢失' WHERE id=?").run(row.id);
    }
    schedule();
  }
  async function stop() { stopped = true; for (const task of active.values()) task.controller.abort(); await Promise.all([...active.values()].map(t => t.promise)); }
  function accountDisabled(userId) {
    db.prepare("UPDATE downloads SET state='cancelled',error='账号已停用' WHERE user_id=? AND state='queued'").run(userId);
    for (const [id, task] of active) { const row = db.prepare('SELECT user_id FROM downloads WHERE id=?').get(id); if (row?.user_id === userId) task.controller.abort(); }
  }
  return { start, stop, enqueue, list, get, action, usage, readyFile, accountDisabled };
}
module.exports = { createDownloads };
