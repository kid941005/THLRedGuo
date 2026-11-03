'use strict';
/**
 * 反向代理：把 /gw/* 转给内置服务，并自动补上本地 api key。
 *
 * 客户端因此完全不需要知道密钥；密钥失效时在这里刷新一次并重放。
 */

const http = require('http');
const { UPSTREAM } = require('./config');
const upstream = require('./upstream');
const { sendJson } = require('./http');

/** 透传给客户端的上游响应头（白名单，避免 hop-by-hop 与编码问题） */
const PASS_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'cache-control',
  'last-modified',
  'content-encoding',
  'content-disposition',
];

function createProxy({ upstreamUrl = UPSTREAM, provider = upstream, timeoutMs = 180000 } = {}) {
  function proxy(req, res, subPath) {
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    delete headers['content-length'];
    // 不向上游要压缩：代理是字节透传，避免解压/编码头不一致
    delete headers['accept-encoding'];
    delete headers.authorization;
    delete headers.cookie;
    delete headers['x-api-key'];

    const key = provider.getKey();
    if (key) headers['x-api-key'] = key;

    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const upstreamReq = http.request(
      `${upstreamUrl}${subPath}${query}`,
      { method: req.method, headers, timeout: timeoutMs },
      (upstreamRes) => {
        // 密钥失效时先刷新再重放，必须发生在 writeHead 之前
        const canRetry =
          (req.method === 'GET' || req.method === 'HEAD') && !req.__keyRetried;
        if (upstreamRes.statusCode === 401 && canRetry) {
          req.__keyRetried = true;
          upstreamRes.resume();
          provider
            .ensureKey(true)
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
        upstreamRes.on('error', () => res.destroy());
        upstreamRes.on('aborted', () => res.destroy());
        for (const name of PASS_HEADERS) {
          if (upstreamRes.headers[name]) outHeaders[name] = upstreamRes.headers[name];
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

    // GET / HEAD 没有请求体：直接 end。401 重试时 req 已经读完，
    // 再对它 pipe 属于未定义行为，可能让上游请求一直不结束，只能等 代理超时。
    if (req.method === 'GET' || req.method === 'HEAD') {
      upstreamReq.end();
    } else {
      req.pipe(upstreamReq);
    }
  }

  return proxy;
}
const proxy = createProxy();
module.exports = { proxy, createProxy };
