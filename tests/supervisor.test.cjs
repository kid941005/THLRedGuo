'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { listen, close, request } = require('./support.cjs');
const { createSupervisor } = require('../server/lib/upstream');
const { createGatewayServer } = require('../server/gateway');
const { createProxy } = require('../server/lib/proxy');

test('health becomes unhealthy on missing key, rejected health or hung process, and recovers', async t => {
  let mode = 'ready';
  const upstream = await listen(http.createServer((req,res) => {
    if (mode === 'hang') return;
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify(req.url === '/health' ? {ok:mode!=='bad'} : {api_key:mode==='missing'?'':'fixture'}));
  }));
  const provider = createSupervisor({ url: 'http://127.0.0.1:' + upstream.address().port, timeoutMs: 80 });
  const gateway = await listen(createGatewayServer({provider}));
  t.after(async () => {provider.stop(); await close(gateway); await close(upstream);});
  for (const [state, status] of [['ready',200],['missing',503],['bad',503],['hang',503],['ready',200]]) {
    mode=state;
    const health = await request(gateway,'/healthz');
    assert.equal(health.status,status,state); assert.equal(JSON.parse(health.body).ok,status===200);
  }
  provider.stop(); assert.equal(provider.isReady(),false);
});

test('proxy refreshes once after 401 and preserves Range bytes and query', async t => {
  let attempts=0, refreshes=0;
  const upstream = await listen(http.createServer((req,res) => {
    attempts++;
    assert.equal(req.url,'/stream?vid=123');
    assert.equal(req.headers.range,'bytes=-3');
    assert.equal(req.headers.authorization,undefined);
    if(req.headers['x-api-key']!=='fresh'){res.writeHead(401);res.end();return;}
    res.writeHead(206,{'content-range':'bytes 7-9/10','content-length':'3','content-type':'video/mp4'});res.end('789');
  }));
  let key='stale';
  const proxy = createProxy({upstreamUrl:'http://127.0.0.1:'+upstream.address().port,provider:{getKey:()=>key,ensureKey:async()=>{refreshes++;key='fresh';}}});
  const gateway=await listen(http.createServer((req,res)=>proxy(req,res,'/stream')));
  t.after(async()=>{await close(gateway);await close(upstream);});
  const result=await request(gateway,'/?vid=123',{Range:'bytes=-3',Authorization:'Basic fixture'});
  assert.equal(result.status,206);assert.equal(result.body,'789');assert.equal(result.headers['content-range'],'bytes 7-9/10');
  assert.equal(attempts,2);assert.equal(refreshes,1);
});
