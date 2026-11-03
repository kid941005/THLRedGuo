'use strict';
/** HTTP 层的 JSON 响应工具。 */

/** 统一 JSON 响应；已写过响应头时直接断开，避免二次写头抛错 */
function sendJson(res, status, payload) {
  if (res.destroyed || res.writableEnded) return;
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

module.exports = { sendJson };
