'use strict';
// Run inside the deployed container. No identity rotation, raw responses or credentials are printed.
const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns').promises;
const https = require('node:https');
const crypto = require('node:crypto');
let version = 'unknown';
try { version = require('../../package.json').version; } catch (_) {}
const config = require('../lib/config');
const hosts = ['log5-applog-lf.fqnovel.com', 'api5-normal-sinfonlineb.fqnovel.com', 'api5-normal-hl.fqnovel.com'];
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
  const report = { version, node: process.version, utc: new Date().toISOString(),
    proxy_environment_present: Object.fromEntries(['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NODE_USE_ENV_PROXY'].map(key=>[key,!!process.env[key]])),
    note: 'Root HTTP status verifies connectivity only; it cannot establish why a playback business response is empty.', network: [] };
  let identity;
  try { identity = JSON.parse(fs.readFileSync(path.join(config.DATA_DIR, 'playback-device.json'), 'utf8')); } catch (_) {}
  report.playback_identity = { exists: !!identity, age_hours: identity && Number.isFinite(identity.created_at) ? Math.round((Date.now() - identity.created_at) / 360000) / 10 : null };
  for (const [label,relative] of [['playback','../vendor/hongguo-web/server/src/core/playback-sign.js'],['catalog','../vendor/hongguo-web/server/src/service/client.js']]) {
    const bytes=fs.readFileSync(path.join(__dirname,relative));
    if(!report.source_fingerprints)report.source_fingerprints={}; report.source_fingerprints[label]=crypto.createHash('sha256').update(bytes).digest('hex').slice(0,16);
  }
  for (const host of hosts) report.network.push(await network(host));
  const args=process.argv.slice(2),vid=args.find(arg=>!arg.startsWith('--'));
  if(args.some(arg=>arg.startsWith('--')&&!['--catalog','--compare'].includes(arg)))throw new Error('未知诊断选项');
  if(args.includes('--compare')&&!vid)throw new Error('--compare 需要指定分集 vid');
  if (vid || args.includes('--catalog')) {
    if (vid && !/^[0-9]{1,30}$/.test(vid)) throw new Error('分集编号必须为 1～30 位数字');
    const before = process.cwd();
    try {
      process.chdir(config.VENDOR_ROOT);
      process.env.HONGGUO_DATA_DIR = config.DATA_DIR;
      process.env.HONGGUO_KEY_FILE = config.KEY_BACKUP;
      if(vid) {
        const App = require('../vendor/hongguo-web/server/src/service/app-source');
        const started = Date.now();
        try { const track = await App.fetch(vid, 'best'); report.playback = { ok: true, definition: track.definition, encrypted: !!track.encrypt, elapsed_ms: Date.now() - started }; }
        catch (error) { report.playback = { ok: false, code: error.code || 'PLAYBACK_ERROR', message: /^PLAYBACK_/.test(error.code || '') ? error.message : '取流未成功，请结合容器日志排查', diagnostic: error.diagnostic || null, elapsed_ms: Date.now() - started }; }
      }
      if(args.includes('--catalog')) {
        const Client=require('../vendor/hongguo-web/server/src/service/client'); report.catalog=[];
        for(const genre of ['short_play','comic_series','ai_series']) {
          const started=Date.now();
          try{const page=await Client.browsePage(genre,{limit:18},[],0);report.catalog.push({genre,ok:true,items:page.items.length,has_more:page.hasMore,elapsed_ms:Date.now()-started});}
          catch(error){report.catalog.push({genre,ok:false,code:error.code||'CATALOG_ERROR',diagnostic:error.diagnostic||null,elapsed_ms:Date.now()-started});}
        }
      }
    } finally { process.chdir(before); }
  }
  if(args.includes('--compare')) {
    const {compareIdentity,comparisonSummary}=require('../lib/diagnostic-identity');
    const temporary=await compareIdentity(__filename,vid);
    report.identity_comparison={ existing:report.playback, temporary, original_identity_replaced:false, conclusion:comparisonSummary(report.playback,temporary) };
  }
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
