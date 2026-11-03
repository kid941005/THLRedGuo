'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createGatewayServer } = require('../server/gateway');

function request(server, pathname, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: pathname, method }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('Docker web gateway routes work without client assets', async t => {
  let ready = false;
  const provider = {
    isReady: () => ready,
    getKey: () => ready ? 'fixture-key' : '',
    devicePersisted: () => ready,
  };
  let forwarded;
  const server = createGatewayServer({
    provider,
    application: { handle: async () => false, originCheck() {}, accounts: { authenticate: () => ({ id: 'fixture' }) }, close: async () => {} },
    proxyRequest(req, res, subPath) {
      forwarded = { subPath, url: req.url, method: req.method, range: req.headers.range };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  await t.test('browser gets local HTML and HEAD has no body', async () => {
    const page = await request(server, '/');
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.match(page.body, /<!doctype html>/i);
    assert.match(page.body, /\/gw\/stream/);
    const head = await request(server, '/index.html', 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
  });

  await t.test('API discovery describes the browser service', async () => {
    const response = await request(server, '/api');
    const data = JSON.parse(response.body);
    assert.equal(response.status, 200);
    assert.equal(data.endpoints.ui, '/');
    assert.equal(data.endpoints.health, '/healthz');
    assert.equal(Object.hasOwn(data.endpoints, 'spider'), false);
    assert.match(data.hint, /浏览器/);
  });

  await t.test('readiness reports the provider startup state', async () => {
    const pending = await request(server, '/healthz');
    assert.equal(pending.status, 503);
    assert.equal(JSON.parse(pending.body).has_key, false);
    ready = true;
    const healthy = await request(server, '/healthz');
    assert.equal(healthy.status, 200);
    const data = JSON.parse(healthy.body);
    assert.equal(data.has_key, true);
    assert.equal(Object.hasOwn(data, 'source'), false);
  });

  await t.test('video API routing retains query and Range headers', async () => {
    const response = await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: server.address().port, path: '/gw/stream?vid=123&quality=best', headers: { Range: 'bytes=0-0' } }, res => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
    });
    assert.equal(response, 200);
    assert.deepEqual(forwarded, { subPath: '/stream', url: '/gw/stream?vid=123&quality=best', method: 'GET', range: 'bytes=0-0' });
  });

  await t.test('retired plugin URLs and unknown routes return 404', async () => {
    for (const url of ['/sources/hongguo_gw.js', '/sources/hongguo-gw.js', '/gw/api-key', '/gw/admin/keys', '/gw/download/task', '/missing']) {
      assert.equal((await request(server, url)).status, 404);
    }
  });
});
