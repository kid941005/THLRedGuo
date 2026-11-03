'use strict';
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const http=require('node:http');
const {listen,close}=require('./support.cjs');
const {spawnSync}=require('node:child_process');
const {isolate,load}=require('./support.cjs');
const isolated=isolate();after(()=>isolated.cleanup());
const Stream=load('service/stream');
const Spade=load('core/spade');
test('real tail-moov CENC media decrypts, remuxes and decodes with ffmpeg',async t=>{
  if(spawnSync('ffmpeg',['-version'],{stdio:'ignore'}).status!==0){t.skip('ffmpeg is not installed');return;}
  const encrypted=path.join(isolated.dir,'encrypted.mp4');
  const made=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=64x64:r=10','-t','0.3','-c:v','libx264','-pix_fmt','yuv420p',
    '-encryption_scheme','cenc-aes-ctr','-encryption_key',Spade.TRUTH[0][1],'-encryption_kid','11223344556677889900aabbccddeeff',encrypted],{encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(made.status,0,made.stderr);
  const result=await Stream.offlineDecrypt(Buffer.from(Spade.TRUTH[0][0],'hex').toString('base64'),encrypted,path.join(isolated.dir,'tail.raw.mp4'));
  assert.match(result.path,/\.play\.mp4$/);
  const decoded=spawnSync('ffmpeg',['-v','error','-i',result.path,'-f','null','-'],{encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(decoded.status,0,decoded.stderr);
  assert.equal(decoded.stderr.trim(),'');
  await assert.rejects(Stream.offlineDecrypt(Buffer.from(Spade.TRUTH[1][0],'hex').toString('base64'),encrypted,path.join(isolated.dir,'wrong-key.raw.mp4')),/封装失败/);
});

test('plaintext tail-moov media is faststart-remuxed before browser publication',async t=>{
  if(spawnSync('ffmpeg',['-version'],{stdio:'ignore'}).status!==0){t.skip('ffmpeg is not installed');return;}
  const source=path.join(isolated.dir,'plain-tail.mp4');
  const made=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=s=64x64:r=10','-t','0.5','-c:v','libx264','-pix_fmt','yuv420p',source],{encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(made.status,0,made.stderr);assert.equal(Stream.hasFastStart(source),false);
  const media=await listen(http.createServer((req,res)=>fs.createReadStream(source).pipe(res)));t.after(()=>close(media));
  const App=load('service/app-source'),old=App.fetch;
  App.fetch=async()=>({url:'http://127.0.0.1:'+media.address().port,encrypt:false});t.after(()=>{App.fetch=old;});
  const published=await Stream.ensureDecrypted('987','best');assert.equal(Stream.hasFastStart(published),true);
  const decoded=spawnSync('ffmpeg',['-v','error','-i',published,'-f','null','-'],{encoding:'utf8',timeout:10000,windowsHide:true});assert.equal(decoded.status,0,decoded.stderr);
});
