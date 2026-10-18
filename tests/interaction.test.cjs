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

function app(){
 const elements=new Map(),frames=[],timers=new Map(),messages=[];let timerId=0;
 const context=new Proxy({},{get:(o,k)=>o[k]||(()=>{})});
 function element(){return {value:'',checked:false,dataset:{},style:{},classList:{add(){},remove(){},toggle(){}},listeners:{},
  addEventListener(name,fn){this.listeners[name]=fn},appendChild(){},setPointerCapture(){},releasePointerCapture(){},
  getBoundingClientRect:()=>({left:0,top:0,width:800,height:600}),getContext:()=>context};}
 const document={querySelector(id){if(!elements.has(id))elements.set(id,element());return elements.get(id)},createElement:element};
 const sandbox={document,WgeMask:require('../mask-core.js'),WgeTileCache:require('../tile-cache.js'),
  WgeRenderer:require('../render-core.js'),Worker:class{addEventListener(){}postMessage(m){messages.push(m)}},
  window:{addEventListener(){}},location:{protocol:'file:',search:''},performance,URLSearchParams,
  crypto:{getRandomValues:bytes=>bytes},requestAnimationFrame:fn=>frames.push(fn),
  setTimeout(fn){timers.set(++timerId,fn);return timerId},clearTimeout:id=>timers.delete(id)};
 vm.runInNewContext(fs.readFileSync(require.resolve('../app.js'),'utf8'),sandbox);
 const flush=()=>{while(frames.length)frames.shift()()};flush();
 return {elements,messages,flush,tick(){const current=[...timers.values()];timers.clear();current.forEach(fn=>fn())}};
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
