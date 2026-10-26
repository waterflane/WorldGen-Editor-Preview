const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {create}=require('../tile-cache.js');

test('world image cache restores distant areas, draws fine detail last and bounds memory',()=>{
 const cache=create(t=>t.x+':'+t.step,3),draws=[];
 const context={drawImage:(...args)=>draws.push(args)};
 const tile=(x,step)=>({x,z:0,step,size:16,buffer:new ArrayBuffer(1024)});
 cache.remember([tile(-16,1),tile(2048,1),tile(-128,8)]);
 cache.draw(context,{x:2056,z:8,blocksPerPixel:1},32,32);
 assert.equal(draws.length,1);assert.equal(draws[0][0],'2048:1');draws.length=0;
 cache.draw(context,{x:-8,z:8,blocksPerPixel:1.5},32,32);
 assert.deepEqual(draws.map(d=>d[0]),['-128:8','-16:1']);
 cache.remember([tile(4096,1)]);assert.equal(cache.size(),3);
 cache.clear();draws.length=0;
 assert.equal(cache.draw(context,{x:-8,z:8,blocksPerPixel:1},32,32),0);
});

function app(info){
 const elements=new Map(),frames=[],timers=new Map(),messages=[],workers=[];let timerId=0;
 const context=new Proxy({},{get:(o,k)=>o[k]||(()=>{})});
 function element(){return {value:'',checked:false,dataset:{},style:{},classList:{add(){},remove(){},toggle(){}},listeners:{},
  addEventListener(name,fn){this.listeners[name]=fn},appendChild(){},setPointerCapture(){},releasePointerCapture(){},
  getBoundingClientRect:()=>({left:0,top:0,width:800,height:600}),getContext:()=>context};}
 const document={querySelector(id){if(!elements.has(id))elements.set(id,element());return elements.get(id)},createElement:element};
 const sandbox={document,WgeMask:require('../mask-core.js'),WgeTileCache:require('../tile-cache.js'),WgeDocument:require('../document-format.js'),
  WgeRenderer:require('../render-core.js'),Worker:class{constructor(url){this.url=url;this.handlers={};workers.push(this)}addEventListener(type,fn){this.handlers[type]=fn}postMessage(m){messages.push(m)}},
  window:{addEventListener(){}},location:{protocol:info?'http:':'file:',search:''},performance,URLSearchParams,
  fetch:async()=>({json:async()=>info}),
  crypto:{getRandomValues:bytes=>bytes},requestAnimationFrame:fn=>frames.push(fn),
  setTimeout(fn){timers.set(++timerId,fn);return timerId},clearTimeout:id=>timers.delete(id)};
 vm.runInNewContext(fs.readFileSync(require.resolve('../app.js'),'utf8'),sandbox);
 const flush=()=>{while(frames.length)frames.shift()()};flush();
 return {elements,messages,workers,preview:sandbox.window.WgePreview,flush,tick(){const current=[...timers.values()];timers.clear();current.forEach(fn=>fn())}};
}

test('dragging cancels generation, uses only the visual cache, and resumes on release',()=>{
 const ui=app(),canvas=ui.elements.get('#previewCanvas'),e={pointerId:1,clientX:400,clientY:300,offsetX:400,offsetY:300,preventDefault(){}};
 const initial=ui.messages.filter(m=>!m.cancelOnly).length;
 canvas.listeners.pointerdown(e);
 for(let n=0;n<10;n++){canvas.listeners.pointermove({...e,clientX:400+n*10});ui.flush();}
 assert.equal(ui.messages.filter(m=>m.cancelOnly).length,1);
 assert.equal(ui.messages.filter(m=>!m.cancelOnly).length,initial);
 assert.equal(canvas.dataset.interacting,'true');
 // Wheel debounce must never start generation while a drag still holds capture.
 canvas.listeners.wheel({...e,deltaY:1});ui.tick();ui.flush();
 assert.equal(ui.messages.filter(m=>!m.cancelOnly).length,initial);
 canvas.listeners.pointerup(e);ui.tick();ui.flush();
 assert.equal(ui.messages.filter(m=>!m.cancelOnly).length,initial+1);
 assert.equal(canvas.dataset.interacting,'false');
});

test('wheel bursts draw cached tiles immediately and start only one generation after settling',()=>{
 const ui=app(),canvas=ui.elements.get('#previewCanvas');ui.messages.length=0;
 for(let n=0;n<10;n++){
  canvas.listeners.wheel({offsetX:400,offsetY:300,deltaY:-1,preventDefault(){}});ui.flush();
 }
 assert.equal(ui.messages.filter(m=>!m.cancelOnly).length,0);
 ui.tick();ui.flush();assert.equal(ui.messages.filter(m=>!m.cancelOnly).length,1);
});

test('metadata editing and failed JSON preserve the linked painted layer; explicit clear removes it',()=>{
 const ui=app(),format=require('../document-format.js');
 const config={generation_version:3,entries:[],painted_map:{version:1,step:4,size:64,tiles:[{x:0,z:0,runs:[4096,65535,65535]}]}};
 const ready=format.prepare(JSON.stringify(config),'0');ui.preview.applyPainted({...ready,seed:'0'});ui.flush();
 assert.equal(JSON.parse(ui.preview.snapshot().document).painted_map.tiles.length,1);
 assert.equal(JSON.parse(ui.elements.get('#jsonInput').value).painted_map,undefined);
 const small=JSON.parse(ui.elements.get('#jsonInput').value);small.outer_ocean='minecraft:cold_ocean';
 ui.elements.get('#jsonInput').value=JSON.stringify(small);ui.elements.get('#applyButton').listeners.click({});ui.flush();
 const applied=ui.preview.snapshot().document;assert.equal(JSON.parse(applied).painted_map.tiles.length,1);
 ui.elements.get('#jsonInput').value='{bad';ui.elements.get('#applyButton').listeners.click({});assert.equal(ui.preview.snapshot().document,applied);
 ui.elements.get('#jsonInput').value=JSON.stringify(small);ui.elements.get('#clearPaintButton').listeners.click();ui.flush();
 assert.equal(JSON.parse(ui.preview.snapshot().document).painted_map,undefined);
});

test('late document validation cannot replace a newer attempted configuration',()=>{
 const ui=app(),format=require('../document-format.js'),before=ui.preview.snapshot().document;
 const config={generation_version:3,entries:[],painted_map:{version:1,step:4,size:64,tiles:[]}};
 ui.elements.get('#jsonInput').value=JSON.stringify(config);ui.elements.get('#applyButton').listeners.click({});
 const request=ui.messages.at(-1),validator=ui.workers.find(w=>w.url==='document.worker.js');assert.ok(validator);
 ui.elements.get('#jsonInput').value='{bad';ui.elements.get('#applyButton').listeners.click({});
 validator.handlers.message({data:{id:request.id,...format.prepare(request.text,'0')}});
 assert.equal(ui.preview.snapshot().document,before);
});

test('changing ocean policy ignores late worker responses and invalid settings preserve the applied map',()=>{
 const ui=app(),input=ui.elements.get('#jsonInput'),renderer=ui.workers.find(w=>w.url==='renderer.worker.js');
 const previous=ui.messages.at(-1),config=JSON.parse(input.value);config.ocean_temperature='warm';input.value=JSON.stringify(config);
 ui.elements.get('#applyButton').listeners.click({});ui.flush();
 assert.equal(JSON.parse(ui.preview.snapshot().document).ocean_temperature,'warm');
 const before=ui.elements.get('#stateBadge').textContent;
 renderer.handlers.message({data:{id:previous.id,error:'obsolete cold coastline'}});
 assert.equal(ui.elements.get('#stateBadge').textContent,before);
 input.value=JSON.stringify({...config,ocean_temperature:'standard'});ui.elements.get('#applyButton').listeners.click({});
 assert.equal(JSON.parse(ui.preview.snapshot().document).ocean_temperature,'warm');
});

test('Java capability negotiation rejects the old ocean policy and accepts the updated runtime',async()=>{
 const base={protocol:2,minecraft:'1.21.1',supported_generation_versions:[1,2,3,4],capabilities:['painted_map_v1','vanilla_wge_only']};
 for(const enabled of [false,true]){
  const ui=app({...base,capabilities:[...base.capabilities,...(enabled?['ocean_temperature_v1','island_outline_v1','coast_profile_v1','coast_smoothing_v1']:[])]});
  await new Promise(resolve=>setImmediate(resolve));
  const source=ui.elements.get('#mapSource');source.value='biomes';source.listeners.change();ui.flush();
  const request=ui.messages.filter(m=>m.source==='biomes'&&!m.cancelOnly).at(-1);
  assert.equal(request.backendAvailable,enabled);
  if(!enabled)assert.match(request.backendError,/ocean temperature/);
 }
});

test('an outline-aware Java runtime without coast profiles is explicitly incompatible',async()=>{
 const ui=app({protocol:2,minecraft:'1.21.1',supported_generation_versions:[1,2,3],capabilities:['painted_map_v1','vanilla_wge_only','ocean_temperature_v1','island_outline_v1']});
 await new Promise(setImmediate);const source=ui.elements.get('#mapSource');source.value='biomes';source.listeners.change();ui.flush();
 const request=ui.messages.filter(m=>m.source==='biomes'&&!m.cancelOnly).at(-1);assert.equal(request.backendAvailable,false);assert.match(request.backendError,/coast profiles/);
});


test('a coast-aware runtime without the smoothing revision is rejected',async()=>{
 const ui=app({protocol:2,minecraft:'1.21.1',supported_generation_versions:[1,2,3,4],capabilities:['painted_map_v1','vanilla_wge_only','ocean_temperature_v1','island_outline_v1','coast_profile_v1']});
 await new Promise(setImmediate);const source=ui.elements.get('#mapSource');source.value='biomes';source.listeners.change();ui.flush();
 const request=ui.messages.filter(m=>m.source==='biomes'&&!m.cancelOnly).at(-1);assert.equal(request.backendAvailable,false);assert.match(request.backendError,/smooth coast/);
});
