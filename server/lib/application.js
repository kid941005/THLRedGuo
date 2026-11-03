'use strict';
const path = require('node:path');
const { openDatabase } = require('./database');
const { createAccounts, fail, publicUser } = require('./accounts');
const { createLibrary } = require('./library');
const { createDownloads } = require('./downloads');
const { serveZip } = require('./zip');
const { sendJson } = require('./http');
const Res = require('../vendor/hongguo-web/server/src/service/res');

async function readBody(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) fail(415, '请求需使用 JSON');
  let bytes = 0, chunks = [];
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 128 * 1024) fail(413, '请求内容过大'); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch (_) { fail(400, 'JSON 请求无效'); }
}
function originCheck(req, publicOrigin) {
  if (req.headers['sec-fetch-site'] === 'cross-site') fail(403, '不允许跨站请求');
  const origin = req.headers.origin;
  if (origin) {
    let expected;
    try { expected = publicOrigin || new URL((req.socket.encrypted ? 'https://' : 'http://') + req.headers.host).origin; } catch (_) { fail(403, '请求来源无效'); }
    if (origin !== expected) fail(403, '请求来源不匹配');
  }
}
function createApplication({ dataDir, provider, upstreamUrl, secureCookies = process.env.COOKIE_SECURE === '1',
  publicOrigin = process.env.PUBLIC_ORIGIN || '', setupToken, fetcher, downloadMaxBytes = (Number(process.env.DOWNLOAD_MAX_MB) || 10240) * 1048576,
  downloadConcurrency = Math.max(1, Math.min(4, Number(process.env.DOWNLOAD_CONCURRENCY) || 2)), pollMs } = {}) {
  if (publicOrigin) { const url = new URL(publicOrigin); if (!['http:', 'https:'].includes(url.protocol) || url.origin !== publicOrigin) throw new Error('PUBLIC_ORIGIN 必须是无路径的完整来源'); }
  if (!Number.isFinite(downloadMaxBytes) || downloadMaxBytes <= 0) throw new Error('DOWNLOAD_MAX_MB 必须为正数');
  const store = openDatabase(dataDir), { db } = store;
  const accounts = createAccounts(store, { dataDir, secureCookies, setupToken });
  const library = createLibrary(store);
  const downloads = createDownloads(store, { dataDir, provider, upstreamUrl, maxBytes: downloadMaxBytes, concurrency: downloadConcurrency, fetcher, pollMs });
  downloads.start();
  let closed = false;
  async function handle(req, res, url) {
    const route = url.pathname, method = req.method;
    if (!route.startsWith('/api/')) return false;
    const reply = value => { sendJson(res, 200, value); return true; };
    if (!['GET', 'HEAD'].includes(method)) originCheck(req, publicOrigin);
    if (method === 'GET' && route === '/api/auth/status') return reply(accounts.status());
    if (method === 'POST' && route === '/api/auth/setup') return reply(await accounts.setup(req, res, await readBody(req)));
    if (method === 'POST' && route === '/api/auth/login') return reply(await accounts.login(req, res, await readBody(req)));
    const user = accounts.authenticate(req);
    async function readInput() { const value = await readBody(req); accounts.authenticate(req); return value; }
    if (!['GET', 'HEAD'].includes(method)) accounts.csrf(req, user);
    if (method === 'GET' && route === '/api/auth/me') return reply({ user: publicUser(user), csrf: user.csrf });
    if (method === 'POST' && route === '/api/auth/logout') { accounts.logout(res, user); return reply({ ok: true }); }
    if (method === 'POST' && route === '/api/auth/password') return reply(await accounts.changePassword(req, res, user, await readInput()));
    if (method === 'PUT' && route === '/api/preferences') {
      const body = await readInput(); if (typeof body.autoplay !== 'boolean') fail(400, '自动连播设置无效');
      db.prepare('UPDATE users SET autoplay=? WHERE id=?').run(Number(body.autoplay), user.id); return reply({ ok: true });
    }
    if (method === 'GET' && route === '/api/favorites') return reply({ items: library.favorites(user) });
    if (method === 'PUT' && route === '/api/favorites') { const body = await readInput(); library.favorite(user, body.series, body.status); return reply({ ok: true }); }
    if (method === 'DELETE' && route.startsWith('/api/favorites/')) { library.removeFavorite(user, route.slice(15)); return reply({ ok: true }); }
    if (method === 'GET' && route === '/api/history') return reply({ items: library.history(user) });
    if (method === 'DELETE' && (route === '/api/history' || route.startsWith('/api/history/'))) { library.removeHistory(user, route === '/api/history' ? null : route.slice(13)); return reply({ ok: true }); }
    if (method === 'GET' && route.startsWith('/api/library/')) return reply(library.detail(user, route.slice(13)));
    if (method === 'POST' && route === '/api/playback/start') return reply(library.begin(user, await readInput()));
    if (method === 'PUT' && route === '/api/progress') return reply(library.progress(user, await readInput()));
    if (method === 'GET' && route === '/api/downloads') return reply({ items: downloads.list(user), usage: downloads.usage() });
    if (method === 'POST' && route === '/api/downloads') return reply(await downloads.enqueue(user, await readInput()));
    if (method === 'GET' && route === '/api/downloads/archive') {
      const ids = [...new Set((url.searchParams.get('ids') || '').split(',').filter(Boolean))];
      if (!ids.length || ids.length > 100) fail(400, '合并下载每次请选择 1～100 个已完成任务');
      const entries = ids.map(id => { const ready = downloads.readyFile(user, id); return { file: ready.file, name: ready.row.episode + '_' + id.slice(0, 8) + '_' + ready.name }; });
      await serveZip(req, res, entries); return true;
    }
    const downloadMatch = /^\/api\/downloads\/([a-f0-9-]{36})(?:\/(file))?$/.exec(route);
    if (downloadMatch) {
      const id = downloadMatch[1];
      if (downloadMatch[2] && ['GET', 'HEAD'].includes(method)) {
        const ready = downloads.readyFile(user, id);
        res.setHeader('Cache-Control', 'private, no-store');
        await Res.streamFile(req, res, ready.file, ready.row.vid, ready.name, 'attachment'); return true;
      }
      if (method === 'POST' && !downloadMatch[2]) { const body = await readInput(); return reply(await downloads.action(user, id, body.command)); }
    }
    if (route.startsWith('/api/admin/')) {
      accounts.admin(user);
      if (method === 'GET' && route === '/api/admin/summary') return reply({
        users: db.prepare('SELECT COUNT(*) AS count FROM users').get().count,
        activeSessions: db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE expires_at>?').get(Date.now()).count,
        tasks: db.prepare('SELECT state,COUNT(*) AS count FROM downloads GROUP BY state').all(), usage: downloads.usage(),
        upstream: { ready: provider.isReady(), cache: provider.getHealth?.()?.cache || null },
        audit: db.prepare('SELECT a.*,u.username FROM audit a LEFT JOIN users u ON u.id=a.actor ORDER BY a.id DESC LIMIT 100').all(),
      });
      if (method === 'GET' && route === '/api/admin/users') return reply({ items: db.prepare('SELECT * FROM users ORDER BY created_at').all().map(publicUser) });
      if (method === 'POST' && route === '/api/admin/users') return reply(await accounts.addUser(user, await readInput()));
      const match = /^\/api\/admin\/users\/([a-f0-9-]{36})$/.exec(route);
      if (method === 'PATCH' && match) {
        const updated = await accounts.updateUser(user, match[1], await readInput());
        if (updated.disabled) downloads.accountDisabled(updated.id);
        return reply(updated);
      }
      if (method === 'GET' && route === '/api/admin/downloads') return reply({ items: downloads.list(user, true), usage: downloads.usage() });
    }
    fail(404, '接口不存在');
  }
  return { handle, accounts, downloads, store, originCheck: req => originCheck(req, publicOrigin),
    async close() { if (closed) return; closed = true; await downloads.stop(); store.close(); } };
}
module.exports = { createApplication };
