'use strict';

const assert = require('node:assert/strict');
const base = (process.argv[2] || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const get = route => fetch(base + route, { signal: AbortSignal.timeout(3000) });

async function main() {
  let healthy = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await get('/healthz');
      const body = await response.json();
      if (response.ok && body.ok && body.has_key && body.device_persisted) {
        healthy = true;
        break;
      }
    } catch (_) { /* process may still be starting */ }
    await sleep(1000);
  }
  assert.ok(healthy, 'Gateway did not become ready with a key and identity backup');
  const page = await get('/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<!doctype html>/i);
  const api = await get('/api');
  assert.equal(api.status, 200);
  const metadata = await api.json();
  assert.equal(metadata.endpoints.ui, '/');
  assert.equal(Object.hasOwn(metadata.endpoints, 'spider'), false);
  const internal = await get('/gw/health');
  assert.equal(internal.status, 401);
  const auth = await get('/api/auth/status');
  assert.equal(auth.status, 200);
  const retired = await get('/sources/hongguo_gw.js');
  assert.equal(retired.status, 404);
  for (const route of ['/gw/api-key', '/gw/admin/keys', '/gw/download/task']) {
    assert.equal((await get(route)).status, 404);
  }
  console.log('Docker web smoke checks passed');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
