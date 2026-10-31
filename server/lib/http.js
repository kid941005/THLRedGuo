'use strict';
/** HTTP 层的小工具：JSON 响应与对外基址推导。 */

const { PORT, PUBLIC_BASE } = require('./config');

/** 统一 JSON 响应；已写过响应头时直接断开，避免二次写头抛错 */
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

/**
 * 推导客户端应使用的基址。
 * 部署在反向代理后面时优先用 PUBLIC_BASE 或 X-Forwarded-* 头，
 * 否则用请求自带的 Host —— 这样同一份镜像换 IP/域名都能直接用。
 */
function baseUrlOf(req) {
  if (PUBLIC_BASE) return PUBLIC_BASE;
  const proto =
    (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() ||
    (req.socket.encrypted ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${PORT}`;
  return `${proto}://${host}`;
}

module.exports = { sendJson, baseUrlOf };
