const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const core=require('../mask-core.js');
global.WgeMask=core;
const {create,sampleStep}=require('../render-core.js');
const raw={enabled:true,entries:[{x:0,z:0,radius:100}]};

test('Minecraft seed parsing, including signed overflow and empty input',()=>{
 assert.equal(core.parseSeed('hello'),99162322n);assert.equal(core.parseSeed('+123'),123n);
 assert.equal(core.parseSeed('-9223372036854775808'),-(1n<<63n));
 const text='9223372036854775808';let hash=0;for(const char of text)hash=(Math.imul(hash,31)+char.charCodeAt(0))|0;
 assert.equal(core.parseSeed(text),BigInt(hash));assert.equal(core.parseSeed(' '),null);
 assert.equal(core.parseSeed('\u0661\u0662\u0663'),123n);
 const nbsp='\u00a0123';let nbspHash=0;for(const c of nbsp)nbspHash=(Math.imul(nbspHash,31)+c.charCodeAt(0))|0;assert.equal(core.parseSeed(nbsp),BigInt(nbspHash));
});
test('strict validation and bounded numbers',()=>{
 for(const entry of [{...raw.entries[0],x:'0'},{...raw.entries[0],overlap:'false'},
 {...raw.entries[0],noise:{first_octave:1024}},{...raw.entries[0],stretch_x:1e308},
 {...raw.entries[0],noise:{amplitudes:'bad'}},{...raw.entries[0],noise:{amplitudes:[1e308,1e308]}}])
 assert.throws(()=>core.parseConfig({entries:[entry]},0n));
});
test('Java c792da7 golden mask parity',()=>{
 const file=process.env.WGE_FIXTURES||path.resolve(__dirname,'../../WorldGen Editor/common/src/test/resources/legacy-mask.json');
 const cases=JSON.parse(fs.readFileSync(file,'utf8'));
 for(const item of cases){const compiled=core.parseConfig(item.config,BigInt(item.seed));for(const [x,z,value]of item.points)
 assert.ok(Math.abs(core.sampleMask(item.config,compiled,x,z)-value)<1e-12,`${item.preset} ${item.seed} ${x} ${z}`);}
});
function message(config=raw,id=1){return {id,configText:JSON.stringify(config),seedText:'0',view:{x:0,z:0,blocksPerPixel:2},width:32,height:32,quality:1,cssWidth:32,cssHeight:32,source:'mask',heightMode:'surface'};}
test('failed compilation cannot poison the render cache',async()=>{
 const renderer=create();await renderer.render(message(),()=>true);
 for(let i=0;i<2;i++)await assert.rejects(renderer.render(message({entries:42}),()=>true));
 assert.ok(await renderer.render(message(),()=>true));
});
test('disabled/empty masks are neutral, not an ocean prediction',async()=>{
 for(const config of [{...raw,enabled:false},{entries:[]}]){const result=await create().render(message(config),()=>true);
 assert.deepEqual(Array.from(new Uint8ClampedArray(result.buffer).slice(0,4)),[48,53,60,255]);}
});
test('cancellation yields to new work and cached rendering avoids recomputation',async()=>{
 const renderer=create();let samples=0;const original=core.sampleMask;core.sampleMask=(...args)=>{samples++;return original(...args)};
 try{await renderer.render(message(),()=>true);samples=0;await renderer.render(message(),()=>true);assert.equal(samples,0);
 let active=true;const start=performance.now();const task=renderer.render({...message(raw,2),width:1024,height:1024,cssWidth:1024,cssHeight:1024},()=>active);
 setTimeout(()=>{active=false},1);assert.equal(await task,null);assert.ok(performance.now()-start<100,'cancel should finish in 100ms');
 }finally{core.sampleMask=original;}
 assert.ok(renderer.cacheSize()<=2048);
});

test('world snapshots retain legacy versions and per-world enable flag',()=>{
 const document=core.readDocument({generation_version:1,enabled:false,config:raw});
 assert.equal(document.generationVersion,1);assert.equal(document.config.enabled,false);assert.equal(raw.enabled,true);
 assert.equal(core.readDocument({config:raw}).generationVersion,1);
 assert.throws(()=>core.readDocument({generation_version:3,config:raw}));
});

test('HTTP work can be aborted while the Java tile is still computing',async()=>{
 const original=global.fetch;let tileStarted,active=true,cancelled=false,aborted=0;
 const started=new Promise(resolve=>tileStarted=resolve);
 global.fetch=async(url,options)=>{
  if(url==='/api/session')return {ok:true,json:async()=>({session:'test',request_base:0})};
  if(url==='/api/cancel'){cancelled=true;return {ok:true};}
  tileStarted();return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>{aborted++;reject(new DOMException('cancelled','AbortError'));}));
 };
 try{
  const renderer=create(),task=renderer.render({...message(),source:'biomes',backendAvailable:true},()=>active);
  await started;const now=performance.now();active=false;renderer.cancel(2);
  assert.equal(await task,null);assert.equal(aborted,4);assert.ok(cancelled);assert.ok(performance.now()-now<100);
 }finally{global.fetch=original;}
});

test('zooming out keeps fine terrain and reuses samples across zoom levels',async()=>{
 const original=global.fetch;let requests=0,inFlight=0,maximum=0;
 const palette=['minecraft:ocean','minecraft:forest'];
 const indexAt=(x,z)=>(Math.floor(x/17)+Math.floor(z/23))&1;
 global.fetch=async(url,options)=>{
  if(url==='/api/session')return {ok:true,json:async()=>({session:'zoom',request_base:0,workers:6})};
  const q=JSON.parse(options.body);requests++;inFlight++;maximum=Math.max(maximum,inFlight);
  await new Promise(resolve=>setTimeout(resolve,2));inFlight--;
  const biomes=[],heights=[];
  for(let row=0;row<q.size;row++)for(let col=0;col<q.size;col++){
   const x=q.x+col*q.step,z=q.z+row*q.step;biomes.push(indexAt(x,z));heights.push(x+z);
  }
  return {ok:true,json:async()=>({palette,biomes,heights})};
 };
 try{
  const renderer=create(),base={...message(),source:'biomes',backendAvailable:true,cssWidth:64,cssHeight:64,width:64,height:64,quality:1,view:{x:64,z:-64,blocksPerPixel:1}};
  await renderer.render(base,()=>true);const loaded=requests;
  const coarse=await renderer.render({...base,samplingQuality:.125,view:{...base.view,blocksPerPixel:1.5}},()=>true);
  const coarseResolution=new Uint32Array(coarse.resolutionBuffer);
  assert.equal(coarse.width,base.width);assert.equal(coarseResolution[32*64+32],1,'the first overview must keep loaded detail');
  const result=await renderer.render({...base,view:{...base.view,blocksPerPixel:1.5}},()=>true);
  assert.equal(maximum,6,'follow the backend concurrency limit');assert.ok(requests-loaded<36,'covered coarse tiles should be derived from cached fine samples');
  const resolutions=new Uint32Array(result.resolutionBuffer),ids=new Uint16Array(result.biomesBuffer),heights=new Int16Array(result.heightsBuffer);
  for(let row=0;row<64;row++)for(let col=0;col<64;col++){
   const x=16+col*1.5,z=-112+row*1.5;
   if(x>=32&&x<96&&z>=-96&&z<-32){
    const i=row*64+col;assert.equal(resolutions[i],1,'loaded relief was replaced by coarser data');
    assert.equal(result.palette[ids[i]],palette[indexAt(Math.floor(x),Math.floor(z))]);
    assert.equal(heights[i],Math.floor(x)+Math.floor(z));
   }
  }
  const beforeReturn=requests;await renderer.render(base,()=>true);assert.equal(requests,beforeReturn,'returning to the loaded area must not request tiles');
  await renderer.render({...base,seedText:'1'},()=>true);assert.ok(requests>beforeReturn,'changing the seed must invalidate retained terrain');
 }finally{global.fetch=original;}
});

test('unavailable or incompatible Java runtime is reported explicitly',async()=>{
 const renderer=create();
 await assert.rejects(renderer.render({...message(),source:'biomes',backendAvailable:false,backendError:'Java preview version mismatch'},()=>true),/version mismatch/);
 const original=global.fetch;global.fetch=async()=>{throw new TypeError('Failed to fetch');};
 try {await assert.rejects(create().render({...message(),source:'biomes',backendAvailable:true},()=>true),/Java preview unavailable/);}
 finally {global.fetch=original;}
});

test('biome quality increases overview resolution and Full follows window pixels',()=>{
 const base={...message(),source:'biomes',cssWidth:1280,cssHeight:720,view:{x:0,z:0,blocksPerPixel:6}};
 assert.equal(sampleStep({...base,quality:.45}),64);
 assert.equal(sampleStep({...base,quality:.65}),32);
 assert.equal(sampleStep({...base,quality:1}),8);
 assert.equal(sampleStep({...base,quality:1,view:{...base.view,blocksPerPixel:1}}),1);
 assert.ok(sampleStep({...base,quality:1,interactive:true})>sampleStep({...base,quality:1}));
});

test('tile composition leaves no gaps at negative coordinates and fractional zoom',async()=>{
 const renderer=create();
 for(const [x,z] of [[-512,-512],[-.1,16],[0,0]])for(const quality of [.45,.65,1])for(const blocksPerPixel of [1,1.3,8.25]){
  const result=await renderer.render({...message(),cssWidth:83,cssHeight:57,width:Math.floor(83*quality),height:Math.floor(57*quality),quality,view:{x,z,blocksPerPixel}},()=>true);
  const pixels=new Uint8ClampedArray(result.buffer);
  for(let i=3;i<pixels.length;i+=4)assert.equal(pixels[i],255,`unpainted pixel at ${x},${z} quality ${quality} zoom ${blocksPerPixel}`);
 }
});

test('fine biome tiles progressively replace coarse data without changing final samples',async()=>{
 const original=global.fetch;let delayNext=false,frames=0;
 const palette=['minecraft:ocean','minecraft:forest'];
 const indexAt=(x,z)=>(Math.floor(x/17)+Math.floor(z/23))&1;
 const heightAt=(x,z)=>Math.floor(x/32)+Math.floor(z/16);
 global.fetch=async(url,options)=>{
  if(url==='/api/session')return {ok:true,json:async()=>({session:'progress',request_base:0})};
  const q=JSON.parse(options.body);
  if(delayNext){delayNext=false;await new Promise(resolve=>setTimeout(resolve,270));}
  const biomes=[],heights=[];
  for(let row=0;row<q.size;row++)for(let col=0;col<q.size;col++){
   const x=q.x+col*q.step,z=q.z+row*q.step;biomes.push(indexAt(x,z));heights.push(heightAt(x,z));
  }
  return {ok:true,json:async()=>({palette,biomes,heights})};
 };
 try{
  const renderer=create(),base={...message(),source:'biomes',backendAvailable:true,cssWidth:64,cssHeight:64,view:{x:-3.5,z:17.25,blocksPerPixel:4}};
  const preview=await renderer.render({...base,quality:.125,width:8,height:8},()=>true);
  delayNext=true;
  const target={...base,quality:.65,width:41,height:41};
  const result=await renderer.render(target,()=>true,{preview,onProgress:frame=>{
   frames++;assert.equal(frame.targetStep,8);assert.equal(frame.sampleStep,preview.sampleStep);
   const pixels=new Uint8ClampedArray(frame.buffer),ids=new Uint16Array(frame.biomesBuffer);
   for(let i=0;i<ids.length;i++){assert.equal(pixels[i*4+3],255);assert.ok(frame.palette[ids[i]]);}
   structuredClone(frame,{transfer:[frame.buffer,frame.biomesBuffer,frame.heightsBuffer]});
  }});
  assert.ok(frames>0,'must paint fine tiles before the entire view completes');
  const ids=new Uint16Array(result.biomesBuffer),heights=new Int16Array(result.heightsBuffer);
  for(let row=0;row<target.height;row++)for(let col=0;col<target.width;col++){
   const x=Math.floor((target.view.x+(col/target.quality-target.cssWidth/2)*target.view.blocksPerPixel)/result.sampleStep)*result.sampleStep;
   const z=Math.floor((target.view.z+(row/target.quality-target.cssHeight/2)*target.view.blocksPerPixel)/result.sampleStep)*result.sampleStep;
   const i=row*target.width+col;assert.equal(result.palette[ids[i]],palette[indexAt(x,z)]);assert.equal(heights[i],heightAt(x,z));
  }
 }finally{global.fetch=original;}
});

test('first coarse tile is visible before the rest finish, without inventing hover biomes',{timeout:2000},async()=>{
 const original=global.fetch;let requests=0,frames=0,release;
 const gate=new Promise(resolve=>release=resolve);
 global.fetch=async(url,options)=>{
  if(url==='/api/session')return {ok:true,json:async()=>({session:'first-frame',request_base:0})};
  const q=JSON.parse(options.body);
  if(++requests>1)await gate;
  return {ok:true,json:async()=>({palette:['minecraft:forest'],biomes:Array(q.size*q.size).fill(0),heights:Array(q.size*q.size).fill(80)})};
 };
 try{
  const result=await create().render({...message(),source:'biomes',backendAvailable:true},()=>true,{onProgress:frame=>{
   if(frames++===0){
    const ids=new Uint16Array(frame.biomesBuffer);
    assert.ok(ids.includes(0),'the completed tile must be drawn');
    assert.ok(ids.includes(65535),'unfinished tiles must not claim a biome');
    assert.equal(frame.palette[65535],undefined);
    release();
   }
  }});
  assert.ok(frames>0,'the first pass must stream frames');
  assert.ok(!new Uint16Array(result.biomesBuffer).includes(65535),'completed map must have no missing samples');
 }finally{release();global.fetch=original;}
});
