'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { temporaryIdentity, comparisonSummary } = require('../server/lib/diagnostic-identity');
test('temporary diagnostic identity is isolated and cleaned on success and failure',async()=>{
  let generated; const oldDirectory=process.env.HONGGUO_DATA_DIR;
  await temporaryIdentity(async directory=>{generated=directory;fs.writeFileSync(path.join(directory,'playback-device.json'),'temporary');assert.equal(process.env.HONGGUO_DATA_DIR,oldDirectory);});
  assert.equal(fs.existsSync(generated),false);
  await assert.rejects(temporaryIdentity(async directory=>{generated=directory;throw new Error('simulated failure');}),/simulated failure/);
  assert.equal(fs.existsSync(generated),false);
});
test('comparison conclusions distinguish old identity from shared failure without claiming a cause',()=>{
  assert.match(comparisonSummary({ok:false},{ok:true}),/未替换原身份/);
  assert.match(comparisonSummary({ok:false},{ok:false}),/没有改善证据/);
  assert.match(comparisonSummary({ok:true},{ok:true}),/已有身份取址成功/);
});
