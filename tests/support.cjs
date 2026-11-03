'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const vendor = path.resolve(__dirname, '../server/vendor/hongguo-web/server/src');
function isolate() {
  const previous = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redguo-regression-'));
  process.chdir(dir);
  process.env.HONGGUO_DATA_DIR = dir;
  process.env.HONGGUO_STREAM_CACHE = path.join(dir, 'cache');
  process.env.HONGGUO_KEY_FILE = path.join(dir, 'apikeys.json');
  process.env.HG_THROTTLE_MS = '0';
  process.env.HG_TRANSCODE = '0';
  return { dir, cleanup() {
    process.chdir(previous);
    if (!path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unsafe test directory');
    fs.rmSync(dir, { recursive: true, force: true });
  } };
}
function request(server, url, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: url, headers, method }, res => {
      const chunks = [];
      res.on('error', reject);
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks), get body() { return this.bytes.toString(); } }));
    });
    req.on('error', reject); req.end();
  });
}
async function listen(server) { await new Promise(r => server.listen(0, '127.0.0.1', r)); return server; }
async function close(server) { if (server.closeAllConnections) server.closeAllConnections(); await new Promise(r => server.close(r)); }
const load = relative => require(path.join(vendor, relative));
module.exports = { isolate, request, listen, close, load };
