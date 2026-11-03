'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const script = fs.readFileSync(path.join(__dirname,'../server/web/index.html'),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const tick = () => new Promise(resolve => setImmediate(resolve));
function element() {
  return { children: [], listeners: {}, attributes:{}, value:'', hidden:false, src:'', textContent:'',
    get innerHTML(){return this._html||'';},set innerHTML(value){this._html=value;this.children=[];},
    classList:{add(){},remove(){}}, appendChild(child){this.children.push(child);},
    addEventListener(name,callback){this.listeners[name]=callback;},
    setAttribute(name,value){this.attributes[name]=value;},removeAttribute(name){delete this.attributes[name];if(name==='src')this.src='';},
    pause(){},load(){},play(){return Promise.resolve();} };
}
function boot(t,respond,personal={}) {
  const elements=new Map(),requests=[],timers=[];
  const response=data=>({ok:true,status:200,json:async()=>data});
  const env={console,AbortController,AbortSignal,DOMException,clearTimeout,setInterval:()=>0,window:{addEventListener(){},confirm:()=>true},
    setTimeout(callback,ms){const timer=setTimeout(callback,[1000,1500,2000].includes(ms)?1:ms);timer.unref();timers.push(timer);return timer;},
    document:{addEventListener(){},getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id);},createElement:()=>element()},
    fetch:async(url,options)=>{requests.push(url);if(url==='/healthz')return response({ok:true});
      if(url==='/api/auth/status')return response({setupRequired:false});
      if(url==='/api/auth/me')return response({user:{id:'test-user',username:'test',role:'admin',autoplay:true},csrf:'fixture'});
      if(url.startsWith('/api/library/'))return response({favorite:'',recent:null,episodes:[]});
      if(url==='/api/playback/start'){if(personal.onStart)personal.onStart(JSON.parse(options.body));return response({playbackId:'fixture-playback',position:personal.position||0});}
      if(url==='/api/progress'){if(personal.onProgress)await personal.onProgress(JSON.parse(options.body));return response({ok:true});}
      return respond(url,options,response);},
  };
  vm.runInNewContext(script,env);
  t.after(()=>timers.forEach(clearTimeout));
  return {elements,requests};
}
function title(card){return card.children[1].children[0].textContent;}

test('search during loading wins over a stale response and uses server pagination cursor',async t=>{
  let oldRank;
  const {elements,requests}=boot(t,(url,options,response)=>{
    if(url.includes('/rank?'))return new Promise(resolve=>{oldRank=()=>resolve(response({items:[{series_id:'1',title:'stale'}]}));});
    return response({results:[{series_id:'2',title:'current'}],has_more:true,next_offset:99});
  });
  await tick();
  elements.get('q').value='new';elements.get('search-form').listeners.submit({preventDefault(){}});
  await tick();oldRank();await tick();
  assert.equal(title(elements.get('grid').children[0]),'current');
  elements.get('more-btn').listeners.click();await tick();
  assert.ok(requests.some(url=>url.includes('/search?')&&url.includes('offset=99')));
  assert.equal(elements.get('grid').children.length,1,'duplicate results are not appended');
});

test('closing or replacing detail ignores an earlier episode response',async t=>{
  let stale;
  const {elements}=boot(t,(url,options,response)=>{
    if(url.includes('/rank?'))return response({items:[{series_id:'1',title:'first'},{series_id:'2',title:'second'}]});
    if(url.includes('series_id=1'))return new Promise(resolve=>{stale=()=>resolve(response({episodes:[{index:99,vid:'99'}]}));});
    return response({episodes:[{index:2,vid:'22'}]});
  });
  await tick();const cards=elements.get('grid').children;
  cards[0].listeners.click();elements.get('d-close').listeners.click();cards[1].listeners.click();
  await tick();stale();await tick();
  assert.equal(elements.get('d-title').textContent,'second');
  assert.equal(elements.get('d-eps').children[0].textContent,'第 2 集');
});

test('media preparation stays separate from video, and closing cancels playback',async t=>{
  let ready=false;
  const {elements,requests}=boot(t,(url,options,response)=>{
    if(url.includes('/rank?'))return response({items:[{series_id:'1',title:'fixture'}]});
    if(url.includes('/episodes?'))return response({episodes:[{index:1,vid:'123'}]});
    if(url.includes('/prepare?'))return response({state:ready?'ready':'preparing'});
    throw new Error(url);
  });
  await tick();elements.get('grid').children[0].listeners.click();await tick();
  elements.get('d-eps').children[0].listeners.click();await tick();
  assert.equal(elements.get('d-video').src,'');
  elements.get('d-close').listeners.click();ready=true;
  await new Promise(r=>setTimeout(r,15));
  assert.equal(elements.get('d-video').src,'');
  assert.ok(requests.some(url=>url.includes('/prepare?')));
  elements.get('grid').children[0].listeners.click();await tick();
  elements.get('d-eps').children[0].listeners.click();await tick();
  assert.match(elements.get('d-video').src,/\/gw\/stream\?vid=123/);
});

test('upstream error text is displayed as text, not inserted HTML',async t=>{
  const attack='<img src=x onerror=alert(1)>';
  const {elements}=boot(t,()=>({ok:false,status:502,text:async()=>JSON.stringify({detail:attack})}));
  await tick();
  assert.equal(elements.get('grid').innerHTML,'');
  assert.ok(elements.get('grid').children[0].textContent.includes(attack));
});

test('player restores saved time, persists progress and automatically advances without clearing completed state',async t=>{
  const starts=[],progress=[];
  const {elements}=boot(t,(url,options,response)=>{
    if(url.includes('/rank?'))return response({items:[{series_id:'1',title:'fixture'}]});
    if(url.includes('/episodes?'))return response({episodes:[{index:1,vid:'11'},{index:2,vid:'22'}]});
    if(url.includes('/prepare?'))return response({state:'ready'});
    throw new Error(url);
  },{position:35,onStart:body=>starts.push(body),onProgress:body=>progress.push(body)});
  await tick();elements.get('grid').children[0].listeners.click();await tick();
  elements.get('d-eps').children[0].listeners.click();await tick();
  const video=elements.get('d-video');video.duration=100;video.currentTime=0;video.onloadedmetadata();
  assert.equal(video.currentTime,35);
  video.onseeked();
  video.currentTime=50;video.listeners.timeupdate();await tick();assert.equal(progress.at(-1).position,50);
  video.currentTime=100;await video.listeners.ended();await tick();
  assert.deepEqual(starts.map(body=>body.vid),['11','22']);
  assert.equal(progress.filter(body=>body.completed).length>=1,true);
  assert.equal(progress.at(-1).completed,true);
});

test('slow history persistence does not block switching episodes or autoplay',async t=>{
  let unblock;const pending=new Promise(resolve=>{unblock=resolve;});
  const starts=[];
  const {elements}=boot(t,(url,options,response)=>{
    if(url.includes('/rank?'))return response({items:[{series_id:'1',title:'fixture'}]});
    if(url.includes('/episodes?'))return response({episodes:[{index:1,vid:'11'},{index:2,vid:'22'}]});
    if(url.includes('/prepare?'))return response({state:'ready'});throw new Error(url);
  },{onStart:body=>starts.push(body),onProgress:()=>pending});
  await tick();elements.get('grid').children[0].listeners.click();await tick();elements.get('d-eps').children[0].listeners.click();await tick();
  const video=elements.get('d-video');video.duration=100;video.currentTime=25;video.onloadedmetadata();
  elements.get('player-next').listeners.click();await tick();
  assert.deepEqual(starts.map(body=>body.vid),['11','22']);unblock();
});

test('network errors recover at the last position, preserve speed and preload only the next episode',async t=>{
  const {elements,requests}=boot(t,(url,options,response)=>{
    if(url.includes('/rank?'))return response({items:[{series_id:'1',title:'fixture'}]});
    if(url.includes('/episodes?'))return response({episodes:[{index:1,vid:'11'},{index:2,vid:'22'},{index:3,vid:'33'}]});
    if(url.includes('/prepare?'))return response({state:'ready'});
    if(url.includes('/stream?'))return {ok:true,status:206};throw new Error(url);
  });
  await tick();elements.get('grid').children[0].listeners.click();await tick();elements.get('d-eps').children[0].listeners.click();await tick();
  const video=elements.get('d-video');video.duration=100;video.currentTime=80;video.paused=false;video.readyState=4;video.onloadedmetadata();
  video.playbackRate=1.5;video.listeners.ratechange();video.listeners.playing();video.listeners.timeupdate();await tick();
  assert.ok(requests.some(url=>url.includes('vid=22')&&url.includes('background=1')));
  assert.equal(requests.some(url=>url.includes('vid=33')),false);
  video.error={code:2};video.onerror();await new Promise(r=>setTimeout(r,12));await tick();
  assert.match(video.src,/recovery=1/);video.onloadedmetadata();assert.equal(video.currentTime,80);assert.equal(video.playbackRate,1.5);
  video.onseeked();video.error={code:3};
  // A successful range diagnostic distinguishes an unsupported codec from a transport failure.
  const originalError=video.onerror;
  await originalError();await tick();
  assert.match(elements.get('d-status').textContent,/无法解码/);assert.equal(elements.get('player-retry').hidden,false);
});

test('closing a player while recovery is scheduled prevents reopening the old stream',async t=>{
  const {elements}=boot(t,(url,options,response)=>{
    if(url.includes('/rank?'))return response({items:[{series_id:'1',title:'fixture'}]});
    if(url.includes('/episodes?'))return response({episodes:[{index:1,vid:'11'}]});
    if(url.includes('/prepare?'))return response({state:'ready'});throw new Error(url);
  });
  await tick();elements.get('grid').children[0].listeners.click();await tick();elements.get('d-eps').children[0].listeners.click();await tick();
  const video=elements.get('d-video');video.error={code:2};video.onerror();elements.get('d-close').listeners.click();
  await new Promise(r=>setTimeout(r,12));assert.equal(video.src,'');
});

test('automatic recovery is bounded to two attempts and keeps manual retry available',async t=>{
  const {elements}=boot(t,(url,options,response)=>{
    if(url.includes('/rank?'))return response({items:[{series_id:'1',title:'fixture'}]});
    if(url.includes('/episodes?'))return response({episodes:[{index:1,vid:'11'}]});
    if(url.includes('/prepare?'))return response({state:'ready'});throw new Error(url);
  });
  await tick();elements.get('grid').children[0].listeners.click();await tick();elements.get('d-eps').children[0].listeners.click();await tick();
  const video=elements.get('d-video');video.error={code:2};
  for(let i=1;i<=2;i++){video.onerror();await new Promise(r=>setTimeout(r,12));await tick();assert.match(video.src,new RegExp('recovery='+i));}
  video.onerror();await new Promise(r=>setTimeout(r,12));
  assert.match(video.src,/recovery=2/);assert.match(elements.get('d-status').textContent,/自动恢复未成功/);assert.equal(elements.get('player-retry').hidden,false);
});
