'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { listen, close } = require('./support.cjs');
const { createGatewayServer } = require('../server/gateway');
const { createApplication } = require('../server/lib/application');

async function fixture(t, extraOptions = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redguo-app-test-'));
  let slow = false;
  const upstream = await listen(http.createServer((req, res) => {
    if (req.url.startsWith('/episodes')) res.end(JSON.stringify({ episodes: [{ index: 1, vid: '11' }, { index: 2, vid: '22' }] }));
    else if (req.url.startsWith('/prepare')) res.end(JSON.stringify({ state: 'ready' }));
    else {
      res.setHeader('content-length', '10');
      if (slow) { res.write('012'); const timer = setTimeout(() => res.end('3456789'), 300); res.once('close', () => clearTimeout(timer)); }
      else res.end('0123456789');
    }
  }));
  const provider = { getKey: () => 'local-key', isReady: () => true, devicePersisted: () => true };
  const options = { dataDir: dir, provider, upstreamUrl: 'http://127.0.0.1:' + upstream.address().port, setupToken: 'test-setup-token', pollMs: 1, downloadConcurrency: 1, ...extraOptions };
  let app = createApplication(options);
  let server = await listen(createGatewayServer({ application: app, provider }));
  let base = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => { await close(server); await app.close(); await close(upstream); fs.rmSync(dir, { recursive: true, force: true }); });
  function client() {
    let cookie = '', csrf = '';
    return { get cookie() { return cookie; }, get csrf() { return csrf; },
      async call(route, body, method = body === undefined ? 'GET' : 'POST', headers = {}) {
        const response = await fetch(base + route, { method, headers: { Cookie: cookie, ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-csrf-token': csrf }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
        if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
        const type = response.headers.get('content-type') || '';
        const data = type.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
        if (data.csrf) csrf = data.csrf;
        return { status: response.status, data, headers: response.headers };
      } };
  }
  const admin = client();
  assert.equal((await admin.call('/api/auth/setup', { token: 'test-setup-token', username: 'admin', password: 'test-admin-password' })).status, 200);
  async function addUser(name) {
    const created = await admin.call('/api/admin/users', { username: name, password: 'test-user-password' }); assert.equal(created.status, 200);
    const user = client(); assert.equal((await user.call('/api/auth/login', { username: name, password: 'test-user-password' })).status, 200);
    return { client: user, id: created.data.id };
  }
  return { dir, get app() { return app; }, server, client, admin, addUser, setSlow: value => { slow = value; },
    async restart() { await close(server); await app.close(); app = createApplication(options); server = await listen(createGatewayServer({application:app,provider})); base = 'http://127.0.0.1:' + server.address().port; } };
}
const series = { series_id: '123', title: '测试剧', cover: 'https://example.com/cover.jpg', episode_cnt: 2 };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitTask(client, id, state) {
  for (let i = 0; i < 100; i++) { const rows = await client.call('/api/downloads'); const job = rows.data.items.find(j => j.id === id); if (job?.state === state) return job; await wait(10); }
  throw new Error('Task did not reach ' + state);
}

test('accounts enforce login, CSRF, roles, last-admin protection and session revocation', async t => {
  const { admin, addUser, client } = await fixture(t);
  const anonymous = client();
  assert.equal((await anonymous.call('/gw/stream?vid=11')).status, 401);
  assert.equal((await anonymous.call('/api/favorites')).status, 401);
  assert.equal((await anonymous.call('/api/auth/setup', { username: 'other', password: 'test-password-123', token: 'test-setup-token' })).status, 409);
  const account = await addUser('alice'), alice = account.client;
  assert.equal((await alice.call('/api/admin/users')).status, 403);
  assert.equal((await alice.call('/api/favorites', { series, status: 'watching' }, 'PUT', { 'x-csrf-token': '' })).status, 403);
  assert.equal((await alice.call('/api/favorites', { series, status: 'watching' }, 'PUT', { Origin: 'https://attacker.example' })).status, 403);
  const me = await admin.call('/api/auth/me');
  assert.equal((await admin.call('/api/admin/users/' + me.data.user.id, { disabled: true }, 'PATCH')).status, 409);
  assert.equal((await admin.call('/api/admin/users/' + account.id, { disabled: true }, 'PATCH')).status, 200);
  assert.equal((await alice.call('/api/auth/me')).status, 401);
  assert.equal((await admin.call('/api/admin/users/' + account.id, { disabled: false, password: 'replacement-password' }, 'PATCH')).status, 200);
  assert.equal((await alice.call('/api/auth/login', { username: 'alice', password: 'test-user-password' })).status, 401);
  assert.equal((await alice.call('/api/auth/login', { username: 'alice', password: 'replacement-password' })).status, 200);
  assert.equal((await alice.call('/api/auth/password', { currentPassword: 'replacement-password', password: 'brand-new-password' })).status, 200);
  assert.equal((await alice.call('/api/auth/me')).status, 401);
});

test('favorites/history/progress are private, resumable, durable and ignore stale playback updates', async t => {
  const { app, admin, addUser, dir } = await fixture(t);
  const alice = (await addUser('alice')).client, bob = (await addUser('bobby')).client;
  assert.equal((await alice.call('/api/favorites', { series, status: 'watching' }, 'PUT')).status, 200);
  assert.equal((await bob.call('/api/favorites')).data.items.length, 0);
  const first = await alice.call('/api/playback/start', { series, vid: '11', episode: 1 });
  const progress = { playbackId: first.data.playbackId, sequence: 1, position: 35, duration: 100 };
  assert.equal((await alice.call('/api/progress', progress, 'PUT')).status, 200);
  assert.equal((await bob.call('/api/progress', progress, 'PUT')).status, 409);
  await alice.call('/api/progress', { ...progress, sequence: 0, position: 0 }, 'PUT');
  const resume = await alice.call('/api/playback/start', { series, vid: '11', episode: 1 }); assert.equal(resume.data.position, 35);
  const second = await alice.call('/api/playback/start', { series, vid: '22', episode: 2 });
  await alice.call('/api/progress', { playbackId: second.data.playbackId, sequence: 1, position: 20, duration: 100 }, 'PUT');
  await alice.call('/api/progress', { ...progress, sequence: 9, position: 50 }, 'PUT');
  const history = await alice.call('/api/history'); assert.equal(history.data.items[0].vid, '22');
  assert.equal((await bob.call('/api/history')).data.items.length, 0);
  const preferences = await alice.call('/api/preferences', { autoplay: false }, 'PUT'); assert.equal(preferences.status, 200);
  // A second SQLite connection sees committed records, with no plaintext passwords.
  const { DatabaseSync } = require('node:sqlite'); const check = new DatabaseSync(path.join(dir, 'app.sqlite'));
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM favorites').get().n, 1);
  assert.notEqual(check.prepare("SELECT password FROM users WHERE username='alice'").get().password, 'test-user-password'); check.close();
  await alice.call('/api/history/123', {}, 'DELETE');
  assert.equal((await alice.call('/api/progress', { ...progress, sequence: 10 }, 'PUT')).status, 409);
  assert.equal((await alice.call('/api/history')).data.items.length, 0);
  assert.equal((await alice.call('/api/library/123')).data.episodes.length, 0);
  assert.equal((await admin.call('/api/admin/summary')).status, 200);
});

test('batch download validates episodes, isolates ownership and serves individual/ZIP bytes', async t => {
  const { admin, addUser } = await fixture(t);
  const alice = (await addUser('alice')).client, bob = (await addUser('bobby')).client;
  assert.equal((await alice.call('/api/downloads', { series, episodes: [999] })).status, 400);
  const batch = await alice.call('/api/downloads', { series, episodes: [1, 2] }); assert.equal(batch.status, 200); assert.equal(batch.data.ids.length, 2);
  const ids = batch.data.ids;
  for (const id of ids) await waitTask(alice, id, 'ready');
  const file = await alice.call('/api/downloads/' + ids[0] + '/file'); assert.equal(file.status, 200); assert.equal(file.data.toString(), '0123456789'); assert.match(file.headers.get('content-disposition'), /attachment/);
  assert.equal((await bob.call('/api/downloads/' + ids[0] + '/file')).status, 404);
  const zip = await alice.call('/api/downloads/archive?ids=' + ids.join(',')); assert.equal(zip.status, 200); assert.equal(zip.data.readUInt32LE(), 0x04034b50);
  assert.equal(zip.data.readUInt16LE(zip.data.length - 12), 2); assert.ok(zip.data.includes(Buffer.from('0123456789')));
  assert.equal((await bob.call('/api/downloads/archive?ids=' + ids[0])).status, 404);
  assert.equal((await admin.call('/api/admin/downloads')).data.items.length, 2);
  assert.equal((await bob.call('/api/downloads/' + ids[0], { command: 'delete' })).status, 404);
  assert.equal((await alice.call('/api/downloads/' + ids[0], { command: 'delete' })).status, 200);
  assert.equal((await alice.call('/api/downloads/' + ids[0] + '/file')).status, 404);
});

test('download cancellation, retry and restart recover persisted queued jobs', async t => {
  const { app, admin, setSlow, dir } = await fixture(t);
  setSlow(true);
  const result = await admin.call('/api/downloads', { series, episodes: [1] }); const id = result.data.ids[0];
  await waitTask(admin, id, 'downloading');
  assert.equal((await admin.call('/api/downloads/' + id, { command: 'cancel' })).status, 200);
  await waitTask(admin, id, 'cancelled');
  assert.equal(fs.existsSync(path.join(dir, 'downloads', id + '.mp4')), false);
  assert.equal((await admin.call('/api/downloads/' + id, { command: 'retry' })).status, 200);
  await app.downloads.stop();
  assert.equal((await admin.call('/api/downloads')).data.items[0].state, 'queued');
  setSlow(false); app.downloads.start(); await waitTask(admin, id, 'ready');
});

test('complete application restart retains sessions, favorites, progress and download files', async t => {
  const fixtureApp = await fixture(t), { admin } = fixtureApp;
  await admin.call('/api/favorites', { series, status: 'want' }, 'PUT');
  const playback = await admin.call('/api/playback/start', { series, vid:'11',episode:1 });
  await admin.call('/api/progress',{playbackId:playback.data.playbackId,sequence:1,position:10,duration:60},'PUT');
  const task = await admin.call('/api/downloads',{series,episodes:[1]});await waitTask(admin,task.data.ids[0],'ready');
  await fixtureApp.restart();
  assert.equal((await admin.call('/api/auth/me')).status,200);
  assert.equal((await admin.call('/api/favorites')).data.items[0].status,'want');
  const resume=await admin.call('/api/playback/start',{series,vid:'11',episode:1});assert.equal(resume.data.position,10);
  assert.equal((await admin.call('/api/downloads/'+task.data.ids[0]+'/file')).data.toString(),'0123456789');
});

test('download quota failures are explicit and leave no partial file',async t=>{
  const {admin,dir}=await fixture(t,{downloadMaxBytes:5});
  const queued=await admin.call('/api/downloads',{series,episodes:[1]});const id=queued.data.ids[0];
  const failed=await waitTask(admin,id,'failed');assert.match(failed.error,/空间不足/);
  assert.equal(fs.existsSync(path.join(dir,'downloads',id+'.mp4.part')),false);
  assert.equal(fs.existsSync(path.join(dir,'downloads',id+'.mp4')),false);
  assert.equal((await admin.call('/api/downloads/'+id+'/file')).status,409);
});
