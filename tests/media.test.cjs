'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { isolate, load, listen, request, close } = require('./support.cjs');
const isolated = isolate();
after(() => isolated.cleanup());
const Stream = load('service/stream');
const Cache = load('service/cache-store');
const Http = load('util/http');
const App = load('service/app-source');
const Res = load('service/res');
const Fixture = load('mp4-fixture');
const Mp4 = load('core/mp4');
const Spade = load('core/spade');
function fixture() {
  const bytes = Fixture.buildMinimalEncryptedMp4();
  const track = Mp4.analyzeEncryptedTracks(bytes).tracks[0];
  for (const [i, plain] of Fixture.plainSamples().entries()) {
    const cipher = crypto.createCipheriv('aes-128-ctr', Buffer.from(Spade.TRUTH[0][1], 'hex'), Mp4.ivToCounter(track.ivs[i]));
    Buffer.concat([cipher.update(plain), cipher.final()]).copy(bytes, track.offsets[i]);
  }
  return bytes;
}
function mockDownload(t, getTrack, body = fixture()) {
  const oldFetch = App.fetch, oldDownload = Http.downloadFile;
  App.fetch = getTrack;
  Http.downloadFile = async (_, dest) => { fs.writeFileSync(dest, body); return body.length; };
  t.after(() => { App.fetch = oldFetch; Http.downloadFile = oldDownload; });
}
const valid = { url: 'https://fixture.fqnovelvod.com/media.mp4', encrypt: true, spadeA: Buffer.from(Spade.TRUTH[0][0], 'hex').toString('base64') };

test('bad spade does not publish ciphertext; retry downloads and decrypts afresh', async t => {
  let calls = 0;
  mockDownload(t, async () => ({ ...valid, spadeA: ++calls === 1 ? 'AAAA' : valid.spadeA }));
  await assert.rejects(Stream.ensureDecrypted('456', 'best'), /spade/);
  assert.equal(Stream.cachedPath('456', 'best'), null);
  assert.equal(fs.readdirSync(Cache.cacheDir()).filter(n => n.startsWith('.work-')).length, 0);
  const file = await Stream.ensureDecrypted('456', 'best');
  assert.equal(calls, 2);
  const bytes = fs.readFileSync(file);
  assert.ok(bytes.includes(Fixture.plainSamples()[0]));
  assert.ok(!bytes.includes(fixture().subarray(fixture().indexOf(Buffer.from('mdat')) + 4)));
});

test('same episode concurrent requests share one operation, raw and v1 cache are ignored', async t => {
  let calls = 0, release;
  const gate = new Promise(r => { release = r; });
  mockDownload(t, async () => { calls++; await gate; return valid; });
  fs.writeFileSync(path.join(Cache.cacheDir(), '789_best.play.mp4'), 'old-corrupt-cache');
  fs.writeFileSync(Stream.cachePaths('789', 'best').raw, 'ciphertext');
  const first = Stream.ensureDecrypted('789', 'best');
  const second = Stream.ensureDecrypted('789', 'best');
  await new Promise(r => setImmediate(r));
  assert.equal(Stream.cachedPath('789', 'best'), null);
  release();
  assert.equal(await first, await second);
  assert.equal(calls, 1);
});

test('invalid plaintext media is rejected and work directory is cleaned', async t => {
  mockDownload(t, async () => ({ ...valid, encrypt: false }), Buffer.from('<html>upstream error</html>'));
  await assert.rejects(Stream.ensureDecrypted('790', 'best'));
  assert.equal(Stream.cachedPath('790', 'best'), null);
});

test('missing encryption key never publishes a CENC container as plaintext', async t => {
  mockDownload(t, async () => ({ ...valid, encrypt: false }));
  await assert.rejects(Stream.ensureDecrypted('792', 'best'), /加密信令/);
  assert.equal(Stream.cachedPath('792', 'best'), null);
});

test('cache cleanup respects live readers/work and evicts released files', () => {
  const active = path.join(Cache.cacheDir(), '999_v2_best.mp4');
  fs.writeFileSync(active, Buffer.alloc(2 * 1048576));
  const old = new Date(Date.now() - 2 * 86400000);
  fs.utimesSync(active, old, old);
  const release = Cache.retain(active);
  const work = fs.mkdtempSync(path.join(Cache.cacheDir(), '.work-'));
  fs.writeFileSync(path.join(work, 'active.raw.mp4'), 'writing');
  fs.utimesSync(work, old, old);
  const releaseWork = Cache.retain(work);
  Cache.sweep({ maxMb: 1, ttlMin: 0, graceMs: 0 });
  assert.ok(fs.existsSync(active)); assert.ok(fs.existsSync(work));
  release(); releaseWork();
  Cache.sweep({ maxMb: 1, ttlMin: 0, graceMs: 0 });
  assert.equal(fs.existsSync(active), false); assert.equal(fs.existsSync(work), false);
});

test('prepare reports pending/failed without waiting, explicit retry can recover', async t => {
  let fail = true, release;
  const gate = new Promise(r => { release = r; });
  mockDownload(t, async () => { await gate; if (fail) throw new Error('fixture refusal'); return valid; });
  assert.equal(Stream.prepare('791', 'best').state, 'preparing');
  release();
  for (let i = 0; i < 100 && Stream.prepare('791', 'best').state === 'preparing'; i++) await new Promise(r => setTimeout(r, 5));
  assert.match(Stream.prepare('791', 'best').error, /fixture refusal/);
  fail = false;
  assert.equal(Stream.prepare('791', 'best', true).state, 'preparing');
  for (let i = 0; i < 200 && Stream.prepare('791', 'best').state === 'preparing'; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(Stream.prepare('791', 'best').state, 'ready');
});

test('failed preparation exposes safe upstream diagnostics and a stable error code',async t=>{
  mockDownload(t,async()=>{throw Object.assign(new Error('safe response failure'),{code:'PLAYBACK_EMPTY_RESPONSE',diagnostic:{http_status:200,body_bytes:0,log_id:'safe-id'}});});
  Stream.prepare('794','best');
  let result;
  for(let i=0;i<100;i++){result=Stream.prepare('794','best');if(result.state==='failed')break;await new Promise(resolve=>setTimeout(resolve,5));}
  assert.equal(result.code,'PLAYBACK_EMPTY_RESPONSE');assert.equal(result.diagnostic.body_bytes,0);
  assert.equal(result.diagnostic.log_id,'safe-id');assert.equal(Stream.cachedPath('794','best'),null);
});

test('ready playback leases protect cached files during later Range requests',async t=>{
  mockDownload(t,async()=>valid);
  const file=await Stream.ensureDecrypted('793','best');
  assert.equal(Stream.prepare('793','best').state,'ready');
  const old=new Date(Date.now()-86400000);fs.utimesSync(file,old,old);
  Cache.sweep({maxMb:0.00001,ttlMin:0,graceMs:0});
  assert.equal(fs.existsSync(file),true);
});

test('foreground preparation enters before speculative queued work',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});const started=[];
  mockDownload(t,async vid=>{started.push(vid);if(['801','802'].includes(vid))await gate;return valid;});
  const tasks=[Stream.ensureDecrypted('801','best'),Stream.ensureDecrypted('802','best')];
  await new Promise(r=>setImmediate(r));
  assert.equal(Stream.prepare('803','best',false,true).stage,'queued');
  assert.equal(started.includes('803'),false);
  tasks.push(Stream.ensureDecrypted('804','best'));
  release();await Promise.all(tasks);
  assert.equal(started.includes('804'),true);assert.equal(started.includes('803'),false);
});

test('Range suffix/open/clamped/invalid and HEAD responses use correct bytes', async t => {
  const file = path.join(isolated.dir, 'range.mp4'); fs.writeFileSync(file, '0123456789');
  const server = await listen(http.createServer((req, res) => { Res.streamFile(req, res, file, '123', 'test.mp4'); }));
  t.after(() => close(server));
  for (const [range, status, body] of [['bytes=-3',206,'789'], ['bytes=7-',206,'789'], ['bytes=8-99',206,'89'], ['bytes=-99',206,'0123456789'], ['bytes=10-',416,''], ['bytes=6-3',416,''], ['bytes=-0',416,''], ['bytes=0-1,3-4',416,'']]) {
    const response = await request(server, '/', { Range: range });
    assert.equal(response.status, status, range); assert.equal(response.body, body, range);
  }
  const head = await request(server, '/', { Range: 'bytes=-3' }, 'HEAD');
  assert.equal(head.status, 206); assert.equal(head.body, ''); assert.equal(head.headers['content-length'], '3');
  assert.equal(head.headers['content-range'], 'bytes 7-9/10');
});

test('streaming HTTP download rejects disconnect, oversized body and bad statuses', async t => {
  const server = await listen(http.createServer((req, res) => {
    if (req.url === '/cut') { res.writeHead(200, { 'content-length': '20' }); res.write('abc'); setImmediate(() => res.destroy()); }
    else if (req.url === '/redirect') { res.writeHead(302, { location: '/ok' }); res.end(); }
    else if (req.url === '/denied') { res.writeHead(403); res.end(); }
    else res.end('0123456789');
  }));
  t.after(() => close(server));
  const base = 'http://127.0.0.1:' + server.address().port;
  for (const route of ['/cut', '/denied']) await assert.rejects(Http.downloadFile({ url: base + route }, path.join(isolated.dir, route.slice(1))));
  await assert.rejects(Http.downloadFile({ url: base + '/ok', maxBytes: 3 }, path.join(isolated.dir, 'small')));
  const dest = path.join(isolated.dir, 'redirected');
  assert.equal(await Http.downloadFile({ url: base + '/redirect' }, dest), 10);
  assert.equal(fs.readFileSync(dest, 'utf8'), '0123456789');
});
