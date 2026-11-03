'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isolate, load, request, close } = require('./support.cjs');
const isolated = isolate(); after(() => isolated.cleanup());
const Client = load('service/client');
const Http = load('util/http');
const App = load('service/app-source');
const Device = load('service/playback-device');
const { Server } = load('server');
function mock(t, object, key, value) { const old = object[key]; object[key] = value; t.after(() => { object[key] = old; }); }

test('browse first/second/last pages expose next cursor and accept absent seen', async t => {
  const calls = [];
  mock(t, Client, 'browsePage', async (genre, opts, seen, offset) => {
    calls.push({ seen, offset });
    return { items: [{ series_id: String(offset + 1) }], hasMore: offset < 36, nextSkip: offset + 18 };
  });
  const api = new Server(); api.ensureBootstrap();
  const server = await api.start('127.0.0.1', 0);
  t.after(() => close(server));
  const headers = { 'x-api-key': api.keys.firstEnabled().key };
  for (const offset of [0,18,36]) {
    const response = await request(server, '/browse?genre=short_play&limit=18&offset=' + offset, headers);
    assert.equal(response.status, 200);
    const data = JSON.parse(response.body);
    assert.equal(data.has_more, offset < 36); assert.equal(data.next_offset, offset + 18);
  }
  assert.deepEqual(calls.map(c => c.seen), [[],[],[]]);
});

test('real browse parser follows upstream cursor and filters seen ids', async t => {
  const requests = [];
  mock(t, Http, 'send', async req => {
    const body = JSON.parse(req.body.toString()); requests.push(body);
    const rows = [{ series_id: '100', title: 'duplicate' }, { series_id: String(body.offset + 101), title: 'next' }];
    return { status: 200, text: () => JSON.stringify({ code: 0, data: { video_data: rows, has_more: false, next_offset: body.offset + 100 } }) };
  });
  const page = await Client.browsePage('short_play', { limit: 18 }, ['100'], 18);
  assert.equal(page.items.length, 1); assert.equal(page.items[0].series_id, '119');
  assert.equal(page.nextSkip, 118); assert.equal(page.hasMore, false);
  assert.equal(requests[0].offset, 18); assert.equal(requests[0].filter_ids, '100');
});

test('last upstream page still exposes locally buffered search results', () => {
  const results = Array.from({length: 30}, (_,i) => i);
  assert.equal(Client.Page.slice(results, 0, 18, false).hasMore, true);
  assert.equal(Client.Page.slice(results, 18, 18, false).hasMore, false);
});

test('rank pagination never drops the tail of an upstream batch', async t => {
  mock(t, Http, 'send', async () => ({ status: 200, text: () => JSON.stringify({code:0,data:{cell_view:{
    cell_data:Array.from({length:30},(_,i)=>({video_data:{series_id:String(1000+i),title:'rank'}})),has_more:false,next_offset:30,
  }}}) }));
  const page = await Client.rankPage('hot',18,0);
  assert.equal(page.items.length,30);assert.equal(page.nextOffset,30);assert.equal(page.hasMore,false);
});

test('latest cached first page preserves its end state and next cursor', async t => {
  let calls=0;
  mock(t,Http,'send',async()=>{calls++;return {status:200,text:()=>JSON.stringify({code:0,data:{video_data:[{series_id:'700',title:'latest'}],has_more:false}})};});
  const first=await Client.latestPage('comic_series',false,18,false,[],0);
  const cached=await Client.latestPage('comic_series',false,18,false,[],0);
  assert.equal(calls,1);assert.equal(first.hasMore,false);assert.equal(cached.hasMore,false);assert.equal(cached.nextSkip,1);
});

test('inline object/array/string video models and fallback all select a stream', async t => {
  let model;
  const row = { main_url: 'https://fixture.fqnovelvod.com/media.mp4', codec_type: 'h264', vwidth: 720, vheight: 1280 };
  mock(t, Http, 'send', async req => {
    if (req.url.includes('device_register')) return { status: 200, text: () => JSON.stringify({ device_id_str: '1234567890123456', install_id_str: '2234567890123456' }) };
    if (req.url.includes('/fallback')) return { status: 200, text: () => JSON.stringify({ video_info: { data: { video_list: { video_1: row } } } }) };
    return { status: 200, text: () => JSON.stringify({ data: { '123': { video_model: model } } }) };
  });
  Device.resetPlaybackDevice({forget:true});
  for (const value of [{ video_list: { video_1: row } }, { video_list: [row] }, JSON.stringify({ video_list: { video_1: row } }), { fallback_api: 'https://fixture.fqnovel.com/fallback' }]) {
    model = value;
    const stream = await App.fetch('123', 'best');
    assert.equal(stream.url, row.main_url); assert.equal(stream.encrypt, false);
  }
  model = { video_list: { video_1: { ...row, main_url: Buffer.from(row.main_url).toString('base64') } } };
  assert.equal((await App.fetch('123', 'best')).url, row.main_url);
});

test('registered playback identity survives a fresh process module without re-registering', async t => {
  let calls = 0;
  mock(t, Http, 'send', async () => { calls++; return { status: 200, text: () => JSON.stringify({ device_id_str: '3334567890123456', install_id_str: '4434567890123456' }) }; });
  Device.resetPlaybackDevice({forget:true});
  const first = await Device.getPlaybackDevice();
  const modulePath = require.resolve(path.join(__dirname, '../server/vendor/hongguo-web/server/src/service/playback-device'));
  delete require.cache[modulePath];
  const fresh = require(modulePath);
  assert.deepEqual(await fresh.getPlaybackDevice(), first); assert.equal(calls, 1);
  assert.equal(fresh.isPersisted(), true);
  fs.writeFileSync(path.join(isolated.dir, 'playback-device.json'), '{broken');
  fresh.resetPlaybackDevice();
  await fresh.getPlaybackDevice(); assert.equal(calls, 2);
});
