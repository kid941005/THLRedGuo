'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { listen, close } = require('./support.cjs');

async function freePort() {const server=await listen(net.createServer());const port=server.address().port;await new Promise(r=>server.close(r));return port;}
async function stop(child) {
  if(!child || child.exitCode!==null)return;
  if(process.platform==='win32')spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
  else child.kill('SIGTERM');
  await Promise.race([new Promise(r=>child.once('close',r)),new Promise(r=>setTimeout(r,1000))]);
}

test('real gateway/vendor/media pipeline survives recreation with both identities and transcoding',async t=>{
  if(spawnSync('ffmpeg',['-version'],{stdio:'ignore'}).status!==0){t.skip('ffmpeg is not installed');return;}
  const root=path.resolve(__dirname,'..');
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'redguo-runtime-test-'));
  let child,media;
  t.after(async()=>{
    await stop(child);if(media)await close(media);
    if(!path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep))throw new Error('Unsafe test path');
    fs.rmSync(temp,{recursive:true,force:true});
  });
  fs.cpSync(path.join(root,'server'),path.join(temp,'server'),{recursive:true});
  const movie=path.join(temp,'fixture.mp4');
  const generated=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=black:s=64x64:r=10','-t','0.3','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart',movie],{encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(generated.status,0,generated.stderr);
  let downloads=0;
  media=await listen(http.createServer((req,res)=>{downloads++;res.setHeader('content-length',fs.statSync(movie).size);fs.createReadStream(movie).pipe(res);}));
  const vendor=path.join(temp,'server/vendor/hongguo-web/server/src');
  const preload=path.join(temp,'upstream-fixture.cjs');
  fs.writeFileSync(preload,`const path=require('path');const vendor=${JSON.stringify(vendor)};
const Http=require(path.join(vendor,'util/http'));const Device=require(path.join(vendor,'service/playback-device'));
const original=Http.send;Http.send=async req=>req.url.includes('device_register')?{status:200,text:()=>JSON.stringify({device_id_str:'1234567890123456',install_id_str:'2234567890123456'})}:original(req);
require(path.join(vendor,'service/app-source')).fetch=async()=>{await Device.getPlaybackDevice();return {url:'http://127.0.0.1:${media.address().port}/movie',encrypt:false};};`);
  const data=path.join(temp,'data');
  let cookie = '';
  const authenticatedFetch = (url,options={})=>fetch(url,{...options,headers:{...options.headers,Cookie:cookie}});
  async function start(transcode) {
    const port=await freePort();let internal=await freePort();while(internal===port)internal=await freePort();
    child=spawn(process.execPath,[path.join(temp,'server/gateway.js')],{cwd:temp,windowsHide:true,stdio:'ignore',env:{...process.env,
      PORT:String(port),HK_PORT:String(internal),HONGGUO_DATA_DIR:data,HONGGUO_STREAM_CACHE:path.join(data,'cache'),HG_TRANSCODE:String(transcode),
      NODE_OPTIONS:'--require "'+preload.replaceAll('\\','/')+'"',HG_OPEN_BROWSER:'0'}});
    const base='http://127.0.0.1:'+port;
    for(let i=0;i<100;i++){
      try{const result=await fetch(base+'/healthz',{signal:AbortSignal.timeout(1000)});if(result.ok){
        const status=await(await fetch(base+'/api/auth/status')).json();
        const auth=await fetch(base+(status.setupRequired?'/api/auth/setup':'/api/auth/login'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:'runtime-password-123',token:status.setupRequired?fs.readFileSync(path.join(data,'setup-token'),'utf8'):undefined})});
        assert.equal(auth.status,200);cookie=auth.headers.get('set-cookie').split(';')[0];return base;
      }}catch(_){}
      await new Promise(r=>setTimeout(r,30));
    }
    throw new Error('Real runtime failed to become ready');
  }
  async function prepare(base){
    for(let i=0;i<100;i++){
      const response=await authenticatedFetch(base+'/gw/prepare?vid=321&quality=best');assert.equal(response.status,200);
      const state=await response.json();assert.notEqual(state.state,'failed',state.error);
      if(state.state==='ready')return;
      await new Promise(r=>setTimeout(r,30));
    }
    throw new Error('Preparation never finished');
  }
  const first=await start(0);await prepare(first);
  const suffix=await authenticatedFetch(first+'/gw/stream?vid=321&quality=best',{headers:{Range:'bytes=-16'}});
  assert.equal(suffix.status,206);assert.deepEqual(Buffer.from(await suffix.arrayBuffer()),fs.readFileSync(movie).subarray(-16));
  const catalogIdentity=JSON.parse(fs.readFileSync(path.join(data,'apikeys.json'),'utf8')).device_id;
  const playbackIdentity=JSON.parse(fs.readFileSync(path.join(data,'playback-device.json'),'utf8'));
  assert.equal((await fetch(first+'/gw/api-key')).status,404);
  await stop(child);child=null;
  const second=await start(1);await prepare(second);
  assert.equal(JSON.parse(fs.readFileSync(path.join(data,'apikeys.json'),'utf8')).device_id,catalogIdentity);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data,'playback-device.json'),'utf8')),playbackIdentity);
  const files=fs.readdirSync(path.join(data,'cache'));
  assert.ok(files.some(name=>name.includes('_v2_h264_')));
  assert.equal(downloads,2,'transcoded and original caches are independent');
  const health=await(await fetch(second+'/healthz')).json();
  assert.equal(health.playback_device_persisted,true);
});
