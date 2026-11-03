'use strict';
// Run inside the deployed container. No identity rotation, raw responses or credentials are printed.
const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns').promises;
const https = require('node:https');
let version = 'unknown';
try { version = require('../../package.json').version; } catch (_) {}
const config = require('../lib/config');
const hosts = ['log5-applog-lf.fqnovel.com', 'api5-normal-sinfonlineb.fqnovel.com'];
async function network(host) {
  const result = { host };
  try { const address = await Promise.race([dns.lookup(host), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('DNS_TIMEOUT')), 8000); timer.unref(); })]); result.dns = { family: address.family, address: address.address }; }
  catch (error) { result.dns = { error: error.code || 'DNS_ERROR' }; return result; }
  return new Promise(resolve => {
    const started = Date.now();
    const request = https.get({ hostname: host, path: '/', headers: { 'user-agent': 'THLRedGuo-Diagnostics' } }, response => {
      // Root-path errors are expected: this checks DNS/TLS/HTTP, not signed business acceptance.
      result.http = { status: response.statusCode, tls: response.socket.authorized, elapsed_ms: Date.now() - started };
      response.destroy(); resolve(result);
    });
    const timer = setTimeout(() => request.destroy(Object.assign(new Error('timeout'), { code: 'NETWORK_TIMEOUT' })), 8000);
    request.once('close', () => clearTimeout(timer));
    request.once('error', error => { result.http = { error: error.code || 'NETWORK_ERROR', elapsed_ms: Date.now() - started }; resolve(result); });
  });
}
async function main() {
  const report = { version, node: process.version,
    note: 'Root HTTP status verifies connectivity only; it cannot establish why a playback business response is empty.', network: [] };
  let identity;
  try { identity = JSON.parse(fs.readFileSync(path.join(config.DATA_DIR, 'playback-device.json'), 'utf8')); } catch (_) {}
  report.playback_identity = { exists: !!identity, age_hours: identity && Number.isFinite(identity.created_at) ? Math.round((Date.now() - identity.created_at) / 360000) / 10 : null };
  for (const host of hosts) report.network.push(await network(host));
  const vid = process.argv[2];
  if (vid) {
    if (!/^[0-9]{1,30}$/.test(vid)) throw new Error('分集编号必须为 1～30 位数字');
    const before = process.cwd();
    try {
      process.chdir(config.VENDOR_ROOT);
      process.env.HONGGUO_DATA_DIR = config.DATA_DIR;
      const App = require('../vendor/hongguo-web/server/src/service/app-source');
      const started = Date.now();
      try { const track = await App.fetch(vid, 'best'); report.playback = { ok: true, definition: track.definition, encrypted: !!track.encrypt, elapsed_ms: Date.now() - started }; }
      catch (error) { report.playback = { ok: false, code: error.code || 'PLAYBACK_ERROR', message: /^PLAYBACK_/.test(error.code || '') ? error.message : '取流未成功，请结合容器日志排查', diagnostic: error.diagnostic || null, elapsed_ms: Date.now() - started }; }
    } finally { process.chdir(before); }
  }
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
