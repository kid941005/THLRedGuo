'use strict';
/**
 * 基于 node:http/https 的 HTTP 客户端。
 *
 * 关键行为：
 *  - 默认跟随重定向
 *  - 默认不自动压缩（不主动发 accept-encoding，交给对端决定）
 *  - 超时抛异常而非静默返回
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

/** 响应结果。 */
class Resp {
  constructor(status, body, headers) {
    this.status = status;
    this.body = body || Buffer.alloc(0);
    this.headers = headers || {};
  }

  text() { return this.body.toString(); }

  header(name) {
    const v = this.headers[String(name).toLowerCase()];
    if (v === undefined || v === null) return null;
    return Array.isArray(v) ? (v.length ? v[0] : null) : String(v);
  }

  ok() { return this.status >= 200 && this.status < 300; }
}

/**
 * 发起请求。
 * @param {object} req { method, url, headers, body, timeoutMs, followRedirect }
 * @returns {Promise<Resp>}
 */
function send(req) {
  const follow = req.followRedirect !== false;
  return sendOnce(req, follow ? 5 : 0);
}

function sendOnce(req, redirectsLeft) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(req.url);
    } catch (e) {
      reject(new Error('非法 URL: ' + req.url));
      return;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      reject(new Error('仅支持 http/https，当前协议不支持：' + req.url));
      return;
    }
    const mod = u.protocol === 'https:' ? https : http;
    const method = req.method || 'GET';
    const headers = Object.assign({}, req.headers || {});
    const body = req.body || null;
    const hasLen = Object.keys(headers).some((k) => k.toLowerCase() === 'content-length');
    if (body && !hasLen) headers['content-length'] = String(body.length);

    const r = mod.request(u, {
      method,
      headers,
      timeout: req.timeoutMs || 30000,
    }, (res) => {
      const chunks = [];
      let length = 0;
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('上游响应中断')));
      res.on('data', (c) => {
        length += c.length;
        if (length > (req.maxBytes || 16 * 1048576)) {
          res.destroy(new Error('接口响应超过限制'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const loc = res.headers.location;
        if (redirectsLeft > 0 && res.statusCode >= 300 && res.statusCode < 400 && loc) {
          let m = method;
          if (res.statusCode === 303 || (m === 'POST' && [301, 302].includes(res.statusCode))) m = 'GET';
          const nextUrl = new URL(loc, u).toString();
          const nh = Object.assign({}, headers);
          if (new URL(nextUrl).origin !== u.origin) {
            for (const k of Object.keys(nh)) if (['authorization', 'cookie', 'x-api-key'].includes(k.toLowerCase())) delete nh[k];
          }
          let nb = body;
          if (m === 'GET') {
            nb = null;
            for (const k of Object.keys(nh)) {
              const kl = k.toLowerCase();
              if (kl === 'content-length' || kl === 'content-type') delete nh[k];
            }
          }
          resolve(sendOnce({ ...req, method: m, url: nextUrl, body: nb, headers: nh }, redirectsLeft - 1));
          return;
        }
        resolve(new Resp(res.statusCode, buf, res.headers));
      });
    });
    r.on('timeout', () => r.destroy(new Error('请求超时')));
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

/** Media downloads stream to disk, reject partial/empty bodies and enforce a total deadline. */
async function downloadFile(options, dest, redirects = 5) {
  const deadline = options.deadline || Date.now() + (options.timeoutMs || 120000);
  if (Date.now() >= deadline) throw new Error('媒体下载超时');
  const url = new URL(options.url);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('非法媒体协议');
  const response = await new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).get(url, { headers: options.headers || {} }, resolve);
    const timer = setTimeout(() => req.destroy(new Error('媒体下载超时')), Math.max(1, deadline - Date.now()));
    req.once('close', () => clearTimeout(timer));
    req.once('error', reject);
  });
  response.on('error', () => {});
  if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
    response.resume();
    if (redirects <= 0) throw new Error('媒体重定向过多');
    return downloadFile({ ...options, deadline, url: new URL(response.headers.location, url).href }, dest, redirects - 1);
  }
  if (response.statusCode !== 200) {
    response.resume();
    throw new Error('下载失败 HTTP ' + response.statusCode);
  }
  let bytes = 0;
  const limit = options.maxBytes || 512 * 1048576;
  const counter = new Transform({ transform(chunk, encoding, callback) {
    bytes += chunk.length;
    callback(bytes > limit ? new Error('媒体文件超过容量限制') : null, chunk);
  } });
  await pipeline(response, counter, fs.createWriteStream(dest, { flags: 'wx' }));
  const length = Number(response.headers['content-length']);
  if (!bytes || (Number.isFinite(length) && length !== bytes)) throw new Error('媒体下载不完整');
  return bytes;
}

/** 解码查询片段；非法百分号转义时原样返回（Node 内置 decodeURIComponent 会抛错）。 */
function urldecode(s) {
  try {
    return decodeURIComponent(String(s).replace(/\+/g, ' '));
  } catch (e) {
    return String(s);
  }
}

/**
 * 解析查询串为对象。
 * 用 Node 内置 URLSearchParams 完成解码，再按出现顺序覆盖写入，
 * 从而保持「重复键取最后一个」的既有语义。
 */
function parseQuery(qs) {
  const out = {};
  if (qs === null || qs === undefined || qs === '') return out;
  for (const [k, v] of new URLSearchParams(String(qs))) out[k] = v;
  return out;
}

/** 把多行文本按逗号切分成去空白列表；null/空返回 null。 */
function splitCsv(v) {
  if (v === null || v === undefined || v === '') return null;
  const out = [];
  for (const s of String(v).split(',')) {
    const t = s.trim();
    if (t !== '') out.push(t);
  }
  return out;
}

module.exports = { Resp, send, downloadFile, urldecode, parseQuery, splitCsv };
