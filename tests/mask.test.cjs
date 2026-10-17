const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const core=require('../mask-core.js');
global.WgeMask=core;
const {create}=require('../render-core.js');
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
 assert.ok(renderer.cacheSize()<=256);
});

test('world snapshots retain legacy versions and per-world enable flag',()=>{
 const document=core.readDocument({generation_version:1,enabled:false,config:raw});
 assert.equal(document.generationVersion,1);assert.equal(document.config.enabled,false);assert.equal(raw.enabled,true);
 assert.throws(()=>core.readDocument({generation_version:3,config:raw}));
});
