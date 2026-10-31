'use strict';
/**
 * 红果网关（THLRedGuo 数据源网关）
 *
 * 作用：
 *  1. 拉起内置的 hongguo-web 服务（第三方 MIT 组件，见 server/vendor/hongguo-web/LICENSE）；
 *  2. 对外只暴露一个端口：
 *     - GET /sources/hongguo_gw.js  下发 CatPawOpen 数据源脚本（自动注入本机地址）
 *     - ANY /gw/*                   反向代理到内置服务，并自动补 x-api-key
 *     - GET /healthz                健康检查
 *  3. 统一处理密钥：客户端不需要知道 api key，也不需要额外配置。
 *
 * 环境变量：
 *  PORT        对外端口，默认 8080
 *  HK_PORT     内置服务端口，默认 8000
 *  PUBLIC_BASE 对外基址（放在反向代理后面时填写，如 https://drama.example.com）
 *  HK_QUALITY  默认清晰度，默认 best
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 8080);
const HK_PORT = Number(process.env.HK_PORT || 8000);
const PUBLIC_BASE = (process.env.PUBLIC_BASE || '').replace(/\/+$/, '');
const UPSTREAM = `http://127.0.0.1:${HK_PORT}`;
const SPIDER_FILE = path.join(__dirname, '..', 'assets', 'sources', 'hongguo_gw.js');
const VENDOR_ENTRY = path.join(
  __dirname,
  'vendor',
  'hongguo-web',
  'server',
  'src',
  'main.js'
);

const startedAt = Date.now();
let apiKey = '';
let upstreamReady = false;

// 解密流缓存目录与清理参数
const CACHE_DIR = (() => {
  if (process.env.HONGGUO_STREAM_CACHE) return process.env.HONGGUO_STREAM_CACHE;
  const dataDir =
    process.env.HONGGUO_DATA_DIR ||
    path.join(__dirname, 'vendor', 'hongguo-web', 'data');
  return path.join(dataDir, 'stream-cache');
})();
const CACHE_TTL_MIN = Number(process.env.CACHE_TTL_MIN || 180);
const CACHE_MAX_MB = Number(process.env.CACHE_MAX_MB || 2048);
const CACHE_SWEEP_SEC = Number(process.env.CACHE_SWEEP_SEC || 300);
let cacheStats = { files: 0, mb: 0 };

/**
 * 解密流缓存清理：内置服务只写不删，长时间运行会把磁盘吃满。
 * 规则：先按 TTL 删过期文件，再按总容量从旧到新淘汰。
 */
async function sweepCache() {
  let names;
  try {
    await fs.promises.mkdir(CACHE_DIR, { recursive: true });
    names = await fs.promises.readdir(CACHE_DIR);
  } catch (_) {
    return;
  }
  const now = Date.now();
  const entries = [];
  let total = 0;
  for (const name of names) {
    const file = path.join(CACHE_DIR, name);
    try {
      const st = await fs.promises.stat(file);
      if (!st.isFile()) continue;
      entries.push({ file, mtime: st.mtimeMs, size: st.size });
      total += st.size;
    } catch (_) {}
  }
  entries.sort((a, b) => a.mtime - b.mtime);

  const ttlMs = CACHE_TTL_MIN * 60 * 1000;
  const maxBytes = CACHE_MAX_MB * 1024 * 1024;
  let removed = 0;

  let alive = entries.length;
  for (const entry of entries) {
    const expired = ttlMs > 0 && now - entry.mtime > ttlMs;
    const overCap = maxBytes > 0 && total > maxBytes;
    if (!expired && !overCap) break;
    try {
      await fs.promises.unlink(entry.file);
      total -= entry.size;
      alive--;
      removed++;
    } catch (_) {
      // 文件可能正被播放请求占用（Windows 下无法删除），保留计数，下轮再试
    }
  }

  cacheStats = { files: alive, mb: Math.round((total / 1048576) * 10) / 10 };
  if (removed > 0) {
    console.log(`[gateway] 清理流缓存 ${removed} 个文件，剩余 ${cacheStats.files} 个 / ${cacheStats.mb}MB`);
  }
}

// ---------------------------------------------------------------- 内置服务

function startUpstream() {
  if (!fs.existsSync(VENDOR_ENTRY)) {
    console.error('[gateway] 缺少内置服务入口:', VENDOR_ENTRY);
    process.exit(1);
  }
  const child = spawn(process.execPath, [VENDOR_ENTRY], {
    // 必须以 vendor 根目录为 cwd：内置服务用相对路径 server/config/ 读写配置，
    // 在 server/src 下启动会生成嵌套的 server/src/server/config 副本。
    cwd: path.resolve(path.dirname(VENDOR_ENTRY), '..', '..'),
    env: {
      ...process.env,
      PORT: String(HK_PORT),
      BIND_HOST: '127.0.0.1',
      // 容器内不弹浏览器；转码默认关闭（取流为纯解密，不需要 ffmpeg）
      HG_OPEN_BROWSER: '0',
      HG_TRANSCODE: process.env.HG_TRANSCODE || '0',
      // 设备身份与缓存落盘目录，务必挂卷持久化，否则重启后 device_id 变化更易被风控
      HONGGUO_DATA_DIR:
        process.env.HONGGUO_DATA_DIR ||
        path.join(__dirname, 'vendor', 'hongguo-web', 'data'),
    },
    stdio: 'inherit',
  });
  child.on('error', (e) => {
    console.error('[gateway] 内置服务启动失败:', e.message);
  });
  child.on('exit', (code) => {
    console.error('[gateway] 内置服务退出，code=', code);
    upstreamReady = false;
    apiKey = '';
    setTimeout(startUpstream, 3000);
  });
  return child;
}

function httpJson(url, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: headers || {}, timeout: 8000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ status: res.statusCode, json: JSON.parse(text) });
        } catch (e) {
          resolve({ status: res.statusCode, json: null, text });
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.on('error', reject);
  });
}

async function waitForUpstream(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { status } = await httpJson(`${UPSTREAM}/health`);
      if (status === 200) {
        upstreamReady = true;
        return true;
      }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 800));
  }
  return false;
}

async function ensureKey(force) {
  if (apiKey && !force) return apiKey;
  try {
    const { json } = await httpJson(`${UPSTREAM}/api-key`);
    if (json && typeof json.api_key === 'string' && json.api_key) {
      apiKey = json.api_key;
    }
  } catch (_) {}
  return apiKey;
}

// ---------------------------------------------------------------- 工具

function baseUrlOf(req) {
  if (PUBLIC_BASE) return PUBLIC_BASE;
  const proto =
    (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() ||
    (req.socket.encrypted ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${PORT}`;
  return `${proto}://${host}`;
}

function sendJson(res, status, payload) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readSpiderScript(base) {
  try {
    const raw = fs.readFileSync(SPIDER_FILE, 'utf8');
    const fallback = process.env.HK_QUALITY || 'best';
    return raw
      .split('__GATEWAY_BASE__').join(base)
      .split('__GATEWAY_QUALITY__').join(fallback);
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------- 代理

function proxy(req, res, subPath) {
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  delete headers['content-length'];
  // 不向上游要压缩：代理是字节透传，避免解压/编码头不一致
  delete headers['accept-encoding'];
  if (apiKey) headers['x-api-key'] = apiKey;

  const target = `${UPSTREAM}${subPath}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
  const upstreamReq = http.request(
    target,
    { method: req.method, headers, timeout: 120000 },
    (upstreamRes) => {
      // 密钥失效时先刷新再重放，必须发生在 writeHead 之前
      const canRetry =
        (req.method === 'GET' || req.method === 'HEAD') && !req.__keyRetried;
      if (upstreamRes.statusCode === 401 && canRetry) {
        req.__keyRetried = true;
        upstreamRes.resume();
        ensureKey(true)
          .then(() => proxy(req, res, subPath))
          .catch(() => {
            if (!res.headersSent) {
              sendJson(res, 502, { error: 'API_KEY_REFRESH_FAILED' });
            } else {
              res.destroy();
            }
          });
        return;
      }

      const outHeaders = {};
      for (const key of [
        'content-type',
        'content-length',
        'content-range',
        'accept-ranges',
        'cache-control',
        'last-modified',
        'content-encoding',
      ]) {
        if (upstreamRes.headers[key]) outHeaders[key] = upstreamRes.headers[key];
      }
      res.writeHead(upstreamRes.statusCode || 502, outHeaders);
      upstreamRes.pipe(res);
    }
  );
  upstreamReq.on('timeout', () => {
    upstreamReq.destroy(new Error('upstream timeout'));
  });
  upstreamReq.on('error', (e) => {
    if (!res.headersSent) {
      sendJson(res, 502, { error: 'UPSTREAM_UNAVAILABLE', detail: e.message });
    } else {
      res.destroy();
    }
  });
  // 播放器拖动进度 / 切集时会主动断开，及时释放上游连接
  res.on('close', () => {
    if (!res.writableEnded) upstreamReq.destroy();
  });
  req.pipe(upstreamReq);
}

// ---------------------------------------------------------------- 启动

startUpstream();
waitForUpstream(60000).then((ok) => {
  if (!ok) console.error('[gateway] 内置服务在 60s 内未就绪，代理请求将返回 502');
  ensureKey(false);
});

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  const pathname = url.split('?')[0];

  if (pathname === '/healthz') {
    return sendJson(res, 200, {
      ok: upstreamReady,
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
      upstream: UPSTREAM,
      has_key: apiKey !== '',
      source: '/sources/hongguo_gw.js',
      cache: { dir: CACHE_DIR, ...cacheStats, ttl_min: CACHE_TTL_MIN, max_mb: CACHE_MAX_MB },
    });
  }

  if (pathname === '/sources/hongguo_gw.js' || pathname === '/sources/hongguo-gw.js') {
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
    return res.end(body);
  }

  if (pathname.startsWith('/gw/')) {
    return proxy(req, res, pathname.slice(3));
  }

  if (pathname === '/' || pathname === '/index.html') {
    return sendJson(res, 200, {
      service: 'thlredguo-gateway',
      endpoints: {
        spider: '/sources/hongguo_gw.js',
        proxy: '/gw/{rank,episodes,search,stream,browse,latest,play}',
        health: '/healthz',
      },
      hint: '在 App 中：设置 → JS 数据源插件管理 → 网络订阅 / URL 导入插件 → 粘贴 spider 地址',
    });
  }

  sendJson(res, 404, { error: 'NOT_FOUND' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[gateway] listening on 0.0.0.0:${PORT} → ${UPSTREAM}`);
  console.log(`[gateway] 流缓存目录 ${CACHE_DIR}（TTL ${CACHE_TTL_MIN}min / 上限 ${CACHE_MAX_MB}MB）`);
});

// 定期清理解密流缓存，避免长期运行把磁盘吃满
sweepCache();
const sweeper = setInterval(sweepCache, Math.max(30, CACHE_SWEEP_SEC) * 1000);
if (typeof sweeper.unref === 'function') sweeper.unref();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  });
}
