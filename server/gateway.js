'use strict';
/**
 * 红果网关入口（THLRedGuo 数据源网关）
 *
 * 只做「装路由 + 启停生命周期」，具体能力都在 lib/ 里：
 *   lib/config.js    路径与环境变量（唯一取值处）
 *   lib/http.js      响应与基址推导
 *   lib/upstream.js  内置服务守护、密钥托管、设备身份备份
 *   lib/proxy.js     /gw/* 反向代理
 *   lib/cache.js     解密流缓存清理
 *
 * 对外只暴露一个端口：
 *   GET /sources/hongguo_gw.js  下发 CatPawOpen 数据源脚本（自动注入本机地址）
 *   ANY /gw/*                   反向代理到内置服务，并自动补 x-api-key
 *   GET /healthz                健康检查（内置服务未就绪时 503）
 *
 * 环境变量见 lib/config.js 与 server/README.md。
 */

const fs = require('fs');
const http = require('http');

const config = require('./lib/config');
const { sendJson, baseUrlOf } = require('./lib/http');
const upstream = require('./lib/upstream');
const cache = require('./lib/cache');
const { proxy } = require('./lib/proxy');

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

/**
 * 读取 spider 并注入基址。
 * 用 split/join 而不是 String.replace：replace 只替换第一次出现，
 * 且会被文件注释里的同名字样抢先命中。
 */
function readSpiderScript(base) {
  try {
    const raw = fs.readFileSync(config.SPIDER_FILE, 'utf8');
    return raw
      .split('__GATEWAY_BASE__')
      .join(base)
      .split('__GATEWAY_QUALITY__')
      .join(config.QUALITY);
  } catch (e) {
    // 读不到 spider 属于部署问题（镜像里漏了文件），打日志便于直接定位
    console.error('[gateway] 读取 spider 失败:', config.SPIDER_FILE, e.message);
    return null;
  }
}

function healthPayload() {
  return {
    ok: upstream.isReady(),
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    upstream: config.UPSTREAM,
    has_key: upstream.getKey() !== '',
    device_persisted: upstream.devicePersisted(),
    source: '/sources/hongguo_gw.js',
    cache: cache.summary(),
  };
}

function serveSpider(req, res) {
  const script = readSpiderScript(baseUrlOf(req));
  if (script === null) {
    return sendJson(res, 500, { error: 'SPIDER_MISSING' });
  }
  const body = Buffer.from(script, 'utf8');
  res.writeHead(200, {
    'content-type': 'application/javascript; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function indexPayload() {
  return {
    service: 'thlredguo-gateway',
    endpoints: {
      ui: '/',
      spider: '/sources/hongguo_gw.js',
      proxy: '/gw/{rank,episodes,search,stream,browse,latest,play}',
      health: '/healthz',
    },
    hint: '在 App 中：设置 → JS 数据源插件管理 → 网络订阅 / URL 导入插件 → 粘贴 spider 地址',
  };
}

const server = http.createServer((req, res) => {
  const pathname = (req.url || '/').split('?')[0];

  if (pathname === '/healthz') {
    // 内置服务不可用时返回 503：若一律 200，容器健康检查永远“通过”，故障发现不了
    return sendJson(res, upstream.isReady() ? 200 : 503, healthPayload());
  }

  if (pathname === '/sources/hongguo_gw.js' || pathname === '/sources/hongguo-gw.js') {
    return serveSpider(req, res);
  }

  if (pathname.startsWith('/gw/')) {
    return proxy(req, res, pathname.slice(3));
  }

  // 浏览器打开根路径给界面；脚本想要端点清单用 /api
  if (pathname === '/' || pathname === '/index.html') {
    return serveWeb(req, res);
  }

  if (pathname === '/api' || pathname === '/api/') {
    return sendJson(res, 200, indexPayload());
  }

  return sendJson(res, 404, { error: 'NOT_FOUND' });
});

// ---------------------------------------------------------------- 启动

upstream.restoreKeyBackup();
upstream.start();
upstream.wait(60000).then((ok) => {
  if (!ok) console.error('[gateway] 内置服务在 60s 内未就绪，代理请求将返回 502');
  upstream.ensureKey(false);
});

server.listen(config.PORT, '0.0.0.0', () => {
  console.log(`[gateway] listening on 0.0.0.0:${config.PORT} → ${config.UPSTREAM}`);
  console.log(
    `[gateway] 流缓存目录 ${config.CACHE_DIR}（TTL ${config.CACHE_TTL_MIN}min / 上限 ${config.CACHE_MAX_MB}MB）`
  );
});

cache.start();

// ---------------------------------------------------------------- 停机

function shutdown() {
  upstream.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, shutdown);
}
