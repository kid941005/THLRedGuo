'use strict';
/**
 * HTTP 响应辅助：统一 JSON 响应、静态文件、Range 串流。
 *
 * Node 的 http 模块把一次请求拆成 (req, res)：
 *   req = http.IncomingMessage，res = http.ServerResponse。
 * 因此所有辅助函数签名统一为 (req, res, ...)。
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const Json = require('../util/json');

/** 一次性写完响应（JSON / 文本 / 字节）。 */
function send(req, res, status, body, headers) {
  const buf = Buffer.isBuffer(body)
    ? body
    : Buffer.from(body === null || body === undefined ? '' : String(body));
  const out = {};
  if (headers) {
    for (const k of Object.keys(headers)) {
      if (headers[k] !== null && headers[k] !== undefined) out[k] = String(headers[k]);
    }
  }
  const hasLen = Object.keys(out).some((k) => k.toLowerCase() === 'content-length');
  if (!hasLen) out['Content-Length'] = String(buf.length);
  res.writeHead(status, out);
  res.end(buf);
}

/** JSON 响应。 */
function json(req, res, status, obj) {
  send(req, res, status, Buffer.from(Json.stringify(obj)),
    headers('application/json; charset=utf-8', null));
}

/** 统一响应头（默认 JSON + 全量 CORS）。 */
function headers(contentType, cacheControl) {
  const h = {};
  h['Content-Type'] = contentType;
  h['Access-Control-Allow-Origin'] = '*';
  if (cacheControl !== null && cacheControl !== undefined) h['Cache-Control'] = cacheControl;
  return h;
}

/** 错误响应：{ detail } 或 { detail, extraKey: extraVal }。 */
function fail(req, res, status, detail, extraKey, extraVal) {
  const m = Json.obj();
  m.detail = detail;
  if (extraKey !== null && extraKey !== undefined) m[extraKey] = extraVal;
  json(req, res, status, m);
}

// ==================== 静态文件 ====================

const MIME = {};
MIME['.html'] = 'text/html; charset=utf-8';
MIME['.js'] = 'application/javascript; charset=utf-8';
MIME['.css'] = 'text/css; charset=utf-8';
MIME['.json'] = 'application/json; charset=utf-8';
MIME['.svg'] = 'image/svg+xml';
MIME['.png'] = 'image/png';
MIME['.ico'] = 'image/x-icon';
MIME['.mp4'] = 'video/mp4';

/** 内联 favicon（SVG）。省掉一个二进制资源。 */
const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
  + '<rect width="64" height="64" rx="14" fill="#e11d48"/>'
  + '<text x="32" y="44" font-size="34" font-family="sans-serif" font-weight="bold"'
  + ' text-anchor="middle" fill="#fff">红</text></svg>';

/** 判断是否前端静态资源路径。 */
function isStaticPath(pathname) {
  if (pathname === '/' || pathname === '/ui' || pathname === '/ui/') return true;
  return /\.(html|js|mjs|css|svg|png|jpg|jpeg|gif|ico|webp|woff2?|ttf|map)$/i.test(pathname);
}

/** 静态文件服务（含 SPA 回退与目录穿越防护）。 */
async function serveStatic(req, res, pathname, webDir) {
  if (pathname === '/favicon.ico' || pathname === '/favicon.svg') {
    send(req, res, 200, Buffer.from(FAVICON_SVG),
      headers('image/svg+xml; charset=utf-8', 'max-age=604800'));
    return;
  }
  let rel = pathname;
  if (rel === '/ui' || rel === '/ui/') rel = '/index.html';
  if (rel === '/') rel = '/index.html';

  const rootBase = webDir === null || webDir === undefined
    ? path.join(process.cwd(), 'web')
    : webDir;
  const root = path.resolve(rootBase).normalize();
  const file = path.resolve(root, '.' + normalizePosix(rel)).normalize();
  if (file !== root && !file.startsWith(root + path.sep)) {
    fail(req, res, 403, 'forbidden');
    return;
  }
  try {
    const data = await fsp.readFile(file);
    const ext = extOf(path.basename(file));
    send(req, res, 200, data, headers(MIME[ext] || 'application/octet-stream', null));
  } catch (e) {
    // SPA 回退：无扩展名的路径一律回落到 index.html
    if (extOf(path.basename(file)) === '') {
      try {
        const data = await fsp.readFile(path.join(root, 'index.html'));
        send(req, res, 200, data, headers(MIME['.html'], null));
        return;
      } catch (e2) {
        // 落到 404
      }
    }
    fail(req, res, 404, 'not found');
  }
}

/** 取小写扩展名（含点）；等价 Node 的 path.extname。 */
function extOf(name) {
  return path.extname(String(name)).toLowerCase();
}

/** 规范化 POSIX 路径（等价 path.posix.normalize，并保证返回绝对形式）。 */
function normalizePosix(p) {
  const s = String(p);
  const norm = path.posix.normalize(s.startsWith('/') ? s : '/' + s);
  // 去掉尾部斜杠（保留根路径 '/'），与旧实现一致
  return norm.length > 1 && norm.endsWith('/') ? norm.slice(0, -1) : norm;
}

// ==================== 视频串流（支持 Range） ====================

/**
 * 已解密视频串流：支持 Range 拖动，<video> 用 ?api_key= 传密钥。
 *
 * @param file 已解密后的文件路径
 * @param vid 集号（用于内联文件名）
 * @param filename 建议文件名（中文需 RFC 5987 编码）
 */
async function streamFile(req, res, file, vid, filename, disposition = 'inline') {
  const release = require('./cache-store').retain(file);
  let fd;
  try {
    fd = await fsp.open(file, 'r');
    const size = (await fd.stat()).size;
    const range = parseByteRange(req.headers && req.headers.range, size);
    if (range === false) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + size, 'Content-Length': '0' });
      res.end();
      return;
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    const headers = {
      'Content-Type': 'video/mp4', 'Content-Length': String(Math.max(0, end - start + 1)),
      'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*',
      'Content-Disposition': (disposition === 'attachment' ? 'attachment' : 'inline') + '; filename="media.mp4"; filename*=UTF-8\'\'' + encodeURIComponent(String(filename)),
      'Access-Control-Expose-Headers': 'content-range, accept-ranges, content-length',
    };
    if (range) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === 'HEAD' || size === 0) { res.end(); return; }
    const stream = fd.createReadStream({ start, end, autoClose: false });
    await new Promise((resolve, reject) => {
      const closed = () => { stream.destroy(); resolve(); };
      res.once('close', closed);
      stream.once('error', reject);
      res.once('finish', resolve);
      stream.pipe(res);
    });
  } catch (e) {
    if (res.headersSent) res.destroy();
    else fail(req, res, e.code === 'ENOENT' ? 404 : 500, '媒体文件暂不可用');
  } finally {
    if (fd) await fd.close().catch(() => {});
    release();
  }
}

function parseByteRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(value).trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) return false;
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return false;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

module.exports = {
  send, json, headers, fail,
  isStaticPath, serveStatic, streamFile,
  // 以下为内部工具，导出便于自检/复用
  MIME, FAVICON_SVG, extOf, normalizePosix, parseByteRange,
};
