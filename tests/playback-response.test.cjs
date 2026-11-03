'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isolate, load } = require('./support.cjs');
const isolated = isolate(); after(() => isolated.cleanup());
const Http = load('util/http');
const Device = load('service/playback-device');
const modulePath = require.resolve(path.join(__dirname, '../server/vendor/hongguo-web/server/src/service/app-source'));
function fresh() { delete require.cache[modulePath]; return require(modulePath); }
function scenario(t, handler) {
  const original = Http.send; const requests = []; let registrations = 0;
  Device.resetPlaybackDevice({ forget: true });
  Http.send = async request => {
    if (request.url.includes('device_register')) { registrations++; return { status: 200, text: () => JSON.stringify({ device_id_str: '1234567890123456', install_id_str: '2234567890123456' }) }; }
    requests.push(request); return handler(request, requests.length);
  };
  t.after(() => { Http.send = original; Device.resetPlaybackDevice({ forget: true }); });
  return { app: fresh(), requests, registrations: () => registrations };
}
const success = () => ({ status: 200, text: () => JSON.stringify({ data: { '123': { video_model: { video_list: [{ main_url: 'https://fixture.fqnovelvod.com/a.mp4', codec_type: 'h264', vwidth: 720, vheight: 1280 }] } } } }) });
const empty = () => ({ status: 200, text: () => '', header: name => name === 'x-tt-logid' ? 'safe-log-123' : 'application/json' });

test('one transient empty response retries once with the same registered identity', async t => {
  const context = scenario(t, (_, count) => count === 1 ? empty() : success());
  assert.equal((await context.app.fetch('123', 'best')).url, 'https://fixture.fqnovelvod.com/a.mp4');
  assert.equal(context.requests.length, 2); assert.equal(context.registrations(), 1);
  const identities = context.requests.map(request => new URL(request.url).searchParams.get('device_id'));
  assert.equal(identities[0], identities[1]);
  assert.deepEqual(context.requests.map(request => new URL(request.url).hostname), [context.app.VIDEO_API_HOST, 'api5-normal-hl.fqnovel.com']);
  for (const request of context.requests) {
    for (const header of ['x-medusa', 'x-gorgon', 'x-khronos', 'x-helios', 'x-ladon', 'x-argus']) assert.ok(request.headers[header]);
    assert.equal(load('core/pure-sign').branchOf(request.url, request.body, Number(request.headers['x-khronos'])), 0);
    assert.equal(request.followRedirect, false);
    assert.equal(new URL(request.url).searchParams.get('cdid').length, 36);
  }
});

test('persistent empty bodies are classified, bounded and cooled without rotating identity', async t => {
  const context = scenario(t, empty);
  await assert.rejects(context.app.fetch('123', 'best'), error => {
    assert.equal(error.code, 'PLAYBACK_EMPTY_RESPONSE');
    assert.deepEqual(error.diagnostic, { http_status: 200, body_bytes: 0, content_type: 'application/json', log_id: 'safe-log-123' });
    assert.match(error.message, /60 秒/); assert.doesNotMatch(error.message, /原始响应/); return true;
  });
  await assert.rejects(context.app.fetch('124', 'best'), error => error.code === 'PLAYBACK_EMPTY_RESPONSE');
  assert.equal(context.requests.length, 2); assert.equal(context.registrations(), 1);
});

test('nonempty missing-data responses never trigger identity replacement or empty retry', async t => {
  const context = scenario(t, () => ({ status: 200, text: () => JSON.stringify({ code: 0, private_response: 'must-not-log' }) }));
  await assert.rejects(context.app.fetch('123', 'best'), error => error.code === 'PLAYBACK_MISSING_DATA' && !error.message.includes('must-not-log'));
  assert.equal(context.requests.length, 1); assert.equal(context.registrations(), 1);
});

test('business errors and HTTP failures remain distinct from empty responses', async t => {
  const context = scenario(t, (_, count) => count === 1 ? { status: 200, text: () => JSON.stringify({ code: 100103 }) } : { status: 403, text: () => '' });
  await assert.rejects(context.app.fetch('123', 'best'), error => error.code === 'PLAYBACK_BUSINESS_ERROR');
  await assert.rejects(context.app.fetch('123', 'best'), error => error.code === 'PLAYBACK_HTTP_ERROR');
  assert.equal(context.requests.length, 2);
});

test('invalid JSON is classified without printing raw payload', async t => {
  const context = scenario(t, () => ({ status: 200, text: () => '<html>private upstream content</html>' }));
  await assert.rejects(context.app.fetch('123', 'best'), error => error.code === 'PLAYBACK_INVALID_RESPONSE' && !error.message.includes('private upstream'));
  assert.equal(context.requests.length, 1);
});

test('a loaded playback identity expires in memory and is refreshed after configured TTL', async t => {
  let registrations = 0;
  const originalSend = Http.send, originalNow = Date.now, originalTTL = process.env.PLAYBACK_IDENTITY_TTL_HOURS;
  t.after(() => { Http.send = originalSend; Date.now = originalNow; if (originalTTL === undefined) delete process.env.PLAYBACK_IDENTITY_TTL_HOURS; else process.env.PLAYBACK_IDENTITY_TTL_HOURS = originalTTL; Device.resetPlaybackDevice({forget:true}); });
  Http.send = async () => { registrations++; return { status: 200, text: () => JSON.stringify({ device_id_str: String(1234567890123000 + registrations), install_id_str: '2234567890123456' }) }; };
  process.env.PLAYBACK_IDENTITY_TTL_HOURS = '1'; Device.resetPlaybackDevice({forget:true});
  const now = originalNow(); Date.now = () => now;
  const first = await Device.getPlaybackDevice(); assert.equal(registrations, 1);
  Date.now = () => now + 3600001;
  const second = await Device.getPlaybackDevice(); assert.equal(registrations, 2); assert.notEqual(first.device_id, second.device_id);
  assert.ok(fs.existsSync(path.join(isolated.dir, 'playback-device.json')));
});
