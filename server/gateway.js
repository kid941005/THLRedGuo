'use strict';
/**
 * Docker 网页版入口。
 *
 * 只做「装路由 + 启停生命周期」，具体能力都在 lib/ 里：
 *   lib/config.js    路径与环境变量（唯一取值处）
 *   lib/http.js      JSON 响应
 *   lib/upstream.js  内置服务守护、密钥托管、设备身份备份
 *   lib/proxy.js     /gw/* 反向代理
 *   lib/application.js 账号、个人数据与下载任务
 *
 * 对外只暴露一个端口：
 *   GET /                       网页界面
 *   ANY /gw/*                   反向代理到内置服务，并自动补 x-api-key
 *   GET /healthz                健康检查（内置服务未就绪时 503）
 *
 * 环境变量见 lib/config.js 与 server/README.md。
 */

const fs = require('fs');
const http = require('http');

const config = require('./lib/config');
const { sendJson } = require('./lib/http');
const upstream = require('./lib/upstream');
const { proxy } = require('./lib/proxy');
const { createApplication } = require('./lib/application');

const startedAt = Date.now();

/**
 * 内置网页界面：单文件，读一次后在内存里缓存。
 * 带 mtime 校验，改完文件不用重启也能生效（本地调试方便）。
 */
let webCache = { mtimeMs: 0, body: null };
function readWebIndex() {
  try {
    const st = fs.statSync(config.WEB_INDEX);
    if (webCache.body && webCache.mtimeMs === st.mtimeMs) return webCache.body;
    const body = fs.readFileSync(config.WEB_INDEX);
    webCache = { mtimeMs: st.mtimeMs, body };
    return body;
  } catch (e) {
    console.error('[gateway] 读取网页界面失败:', config.WEB_INDEX, e.message);
    return null;
  }
}

function serveWeb(req, res) {
  const body = readWebIndex();
  if (!body) {
    return sendJson(res, 500, { error: 'WEB_INDEX_MISSING', detail: '镜像里缺少 server/web/index.html' });
  }
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  if (req.method === 'HEAD') return res.end();
  res.end(body);
}

function healthPayload(provider) {
  const health = provider.getHealth ? provider.getHealth() : null;
  return {
    ok: provider.isReady() && provider.getKey() !== '',
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    upstream: config.UPSTREAM,
    has_key: provider.getKey() !== '',
    device_persisted: provider.devicePersisted(),
    playback_device_persisted: !!(health && health.playback_device_persisted),
    cache: health && health.cache ? health.cache : null,
  };
}

function indexPayload() {
  return {
    service: 'thlredguo-gateway',
    endpoints: {
      ui: '/',
      proxy: '/gw/{rank,episodes,search,prepare,stream,browse,latest}',
      health: '/healthz',
      login: '/api/auth/login',
      personal: '/api/{favorites,history,downloads}',
      admin: '/api/admin/summary',
    },
    hint: '用浏览器打开根路径，浏览、搜索和播放短剧。',
  };
}

function createGatewayServer({ provider = upstream, proxyRequest = proxy, application, dataDir = config.DATA_DIR, appOptions = {} } = {}) {
  let app = application;
  const getApplication = () => app || (app = createApplication({ dataDir, provider, upstreamUrl: config.UPSTREAM, ...appOptions }));
  const server = http.createServer(async (req, res) => {
    try {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'same-origin');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' http: https: data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      if ((req.url || '').length > 16384) return sendJson(res, 414, { error: 'URL_TOO_LONG' });
      const url = new URL(req.url || '/', 'http://gateway');
      const pathname = (req.url || '/').split('?')[0];

      if (url.pathname.startsWith('/api/')) return await getApplication().handle(req, res, url);

      if (pathname === '/healthz') {
        if (provider.refresh) await provider.refresh();
        const payload = healthPayload(provider);
        return sendJson(res, payload.ok ? 200 : 503, payload);
      }

      if (pathname.startsWith('/gw/')) {
        // Expose only browser data/media operations; internal key/admin/download APIs stay private.
        const allowed = new Set(['/rank', '/browse', '/latest', '/search', '/episodes', '/filters', '/prepare', '/stream', '/img', '/health']);
        if (!allowed.has(pathname.slice(3)) || !['GET', 'HEAD'].includes(req.method)) return sendJson(res, 404, { error: 'NOT_FOUND' });
        const application = getApplication();
        application.originCheck(req);
        application.accounts.authenticate(req);
        res.setHeader('Cache-Control', 'private, no-store');
        return proxyRequest(req, res, pathname.slice(3));
      }

      // 网页与 API 使用同一端口、同一来源。
      if (pathname === '/' || pathname === '/index.html') {
        return serveWeb(req, res);
      }

      if (pathname === '/api' || pathname === '/api/') {
        return sendJson(res, 200, indexPayload());
      }

      return sendJson(res, 404, { error: 'NOT_FOUND' });
    } catch (e) {
      if (!e.status) console.error('[gateway] request failed:', e.message);
      sendJson(res, e.status || 500, { error: e.status ? e.message : '服务暂不可用，请稍后重试' });
    }
  });
  server.application = getApplication;
  server.closeApplication = () => app ? app.close() : Promise.resolve();
  server.once('close', () => { server.closeApplication().catch(error => console.error('[gateway] close failed:', error.message)); });
  return server;
}

// ---------------------------------------------------------------- 启动

function start() {
  const server = createGatewayServer();
  const app = server.application();
  if (app.accounts.status().setupRequired) console.log('[gateway] 首次使用：从 /app/data/setup-token 读取初始化口令，在网页创建管理员（或配置 SETUP_TOKEN）。');
  upstream.restoreKeyBackup();
  upstream.start();

  server.listen(config.PORT, '0.0.0.0', () => {
    console.log(`[gateway] listening on 0.0.0.0:${config.PORT} → ${config.UPSTREAM}`);
    console.log(
      `[gateway] 流缓存目录 ${config.CACHE_DIR}（TTL ${config.CACHE_TTL_MIN}min / 上限 ${config.CACHE_MAX_MB}MB）`
    );
  });


  // -------------------------------------------------------------- 停机

  async function shutdown() {
    upstream.stop();
    await server.closeApplication();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  }

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, shutdown);
  }
  return server;
}

module.exports = { createGatewayServer, start };
if (require.main === module) start();
