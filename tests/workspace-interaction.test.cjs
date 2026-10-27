const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');

function workspace(){
 const elements=new Map(),messages=[],workers=[],frames=[],applied=[];
 const context=new Proxy({},{get:(target,key)=>target[key]||(()=>{})});
 const element=()=>({value:'',checked:false,hidden:false,style:{},dataset:{},listeners:{},classList:{toggle(){}},
  addEventListener(type,fn){this.listeners[type]=fn},setAttribute(){},replaceChildren(){},append(){},appendChild(){},
  getContext:()=>context,getBoundingClientRect:()=>({left:0,top:0,width:800,height:600}),setPointerCapture(){},hasPointerCapture:()=>true,releasePointerCapture(){},close(){},showModal(){},reportValidity:()=>true,
  requestSubmit(){this.listeners.submit({preventDefault(){}})}});
 const document={activeElement:{tagName:'BODY'},getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id)},createElement:element};
 const preview={snapshot:()=>({document:JSON.stringify({enabled:true,entries:[]}),seed:'2',view:{x:0,z:0,blocksPerPixel:4}}),pause(){},resume(){},applyPainted:result=>applied.push(result)};
 const window={listeners:{},addEventListener(type,fn){this.listeners[type]=fn}};
 const sandbox={document,window,WgePreview:preview,WgeWorkspaceGeometry:require('../workspace-geometry.js'),WgeTileCache:require('../tile-cache.js'),performance,URLSearchParams,location:{search:'?review=test'},
  indexedDB:{open(){throw new Error('disabled for test')}},requestAnimationFrame:fn=>{frames.push(fn);return frames.length},cancelAnimationFrame(){},setTimeout:()=>1,clearTimeout(){},confirm:()=>true,
  Worker:class{constructor(url){this.url=url;this.handlers={};workers.push(this)}addEventListener(type,fn){this.handlers[type]=fn}postMessage(message){messages.push({url:this.url,...message})}}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../editor.js'),'utf8'),sandbox);
 const worker=workers.find(w=>w.url==='editor.worker.js');
 const emit=data=>worker.handlers.message({data});
 emit({type:'loaded',epoch:0,name:'Test map',seed:'2',editor:{radius:128,roughness:.25},base:{enabled:true,name:'Test map',entries:[]},paintBounds:null});
 emit({type:'state',epoch:0,name:'Test map',revision:0,tileCount:0,canUndo:false,canRedo:false,paintBounds:null});
 return {elements,messages,applied,emit,window,document,async finishExport(revision){
  const request=messages.filter(m=>m.type==='export').at(-1);assert.ok(request);
  emit({type:'export',epoch:0,id:request.id,revision,seed:request.settings?.seed??'2',metadataText:'{"enabled":true,"entries":[],"generation_version":3}',paintText:'{"version":1,"step":4,"size":64,"tiles":[]}',bounds:null});
  await new Promise(resolve=>setImmediate(resolve));
 }};
}

test('Inspect queues stroke completion and exports even before the changed revision is acknowledged',async()=>{
 const ui=workspace();ui.elements.get('inspectModeButton').listeners.click();await ui.finishExport(0);assert.equal(ui.applied.length,1);
 ui.elements.get('landBrush').listeners.click();
 const canvas=ui.elements.get('editorCanvas'),event={pointerId:1,button:0,clientX:400,clientY:300,preventDefault(){}};
 canvas.listeners.pointerdown(event);
 // Simulate Inspect before pointer-up/state acknowledgement. It must flush points/end first.
 ui.elements.get('inspectModeButton').listeners.click();
 const types=ui.messages.filter(m=>m.url==='editor.worker.js').map(m=>m.type);
 assert.deepEqual(types.slice(-4),['begin','points','end','export']);
 await ui.finishExport(1);assert.equal(ui.applied.length,2);assert.equal(ui.applied[1].revision,1);
});

test('paint picking does not create brush strokes and ignores an obsolete response after scene selection',()=>{
 const ui=workspace();
 ui.emit({type:'state',epoch:0,name:'Test map',revision:1,tileCount:1,canUndo:true,canRedo:false,paintBounds:{minX:-256,maxX:256,minZ:-256,maxZ:256}});
 const canvas=ui.elements.get('editorCanvas'),event={pointerId:1,button:0,clientX:400,clientY:300,preventDefault(){}};
 canvas.listeners.pointerdown(event);canvas.listeners.pointerup(event);
 const pick=ui.messages.filter(m=>m.type==='paint-pick').at(-1);assert.ok(pick);
 assert.equal(ui.messages.some(m=>m.type==='points'),false);
 ui.emit({type:'paint-picked',epoch:0,pick:pick.pick,selection:{bounds:{minX:-32,maxX:32,minZ:-32,maxZ:32},x:0,z:0,revision:1}});
 assert.equal(ui.elements.get('paintProperties').hidden,false);
 ui.elements.get('paintLayerButton').listeners.click();
 ui.emit({type:'paint-picked',epoch:0,pick:pick.pick,selection:{bounds:{minX:-32,maxX:32,minZ:-32,maxZ:32},x:0,z:0,revision:1}});
 assert.equal(ui.elements.get('paintProperties').hidden,true);
});

test('Convert to island opens the contour inspector instead of procedural noise controls',()=>{
 const ui=workspace();ui.emit({type:'state',epoch:0,revision:1,tileCount:1,paintBounds:{minX:-128,maxX:128,minZ:-128,maxZ:128}});
 const canvas=ui.elements.get('editorCanvas'),event={pointerId:1,button:0,clientX:400,clientY:300,preventDefault(){}};
 canvas.listeners.pointerdown(event);canvas.listeners.pointerup(event);const pick=ui.messages.filter(m=>m.type==='paint-pick').at(-1);
 ui.emit({type:'paint-picked',epoch:0,pick:pick.pick,selection:{bounds:{minX:-32,maxX:32,minZ:-32,maxZ:32},x:0,z:0,revision:1}});
 ui.elements.get('convertPaintButton').listeners.click();assert.equal(ui.messages.at(-1).type,'paint-convert');assert.equal(ui.elements.get('convertPaintButton').disabled,true);
 const entry={type:'island',name:'Painted Island 1',x:0,z:0,radius_x:64,radius_z:64,outline:{radius_x:64,radius_z:64,mask:{}}};
 ui.emit({type:'loaded',epoch:0,name:'Test map',seed:'2',editor:{radius:128,roughness:.25},base:{entries:[entry]},preserveHistory:true,selected:0,paintBounds:null});
 assert.equal(ui.elements.get('objectProperties').hidden,false);assert.equal(ui.elements.get('shapeCoastProperties').hidden,true);assert.equal(ui.elements.get('shapeNoiseProperties').hidden,true);
 assert.equal(ui.elements.get('objectGeometryKind').textContent,'CUSTOM CONTOUR');
});

test('Enter applies the current seed without blur and stays in biome inspection',async()=>{
 const ui=workspace();ui.elements.get('inspectModeButton').listeners.click();await ui.finishExport(0);
 const seed=ui.elements.get('editorSeed');seed.value='314';seed.tagName='INPUT';ui.document.activeElement=seed;
 let prevented=false;ui.window.listeners.keydown({key:'Enter',target:seed,preventDefault(){prevented=true}});
 const request=ui.messages.filter(m=>m.type==='export').at(-1);assert.equal(request.settings.seed,'314');assert.equal(prevented,true);
 await ui.finishExport(1);assert.equal(ui.applied.at(-1).seed,'314');assert.equal(ui.elements.get('editorCanvas').hidden,true);
});

test('Enter submits object controls and seed together without switching back to the mask',async()=>{
 const ui=workspace();
 const entry={type:'island',name:'Island',x:0,z:0,radius:128};
 ui.emit({type:'loaded',epoch:0,name:'Test map',seed:'2',editor:{radius:128,roughness:.25},base:{entries:[entry]},preserveHistory:true,selected:0});
 ui.elements.get('inspectModeButton').listeners.click();await ui.finishExport(0);
 ui.elements.get('shapeRadiusX').value='400';ui.elements.get('shapeTemperature').value='cold';ui.elements.get('editorSeed').value='123';
 const form=ui.elements.get('shapeForm');form.listeners.input();
 const target={tagName:'SELECT',closest:()=>form};ui.document.activeElement=target;
 ui.window.listeners.keydown({key:'Enter',target,preventDefault(){}});
 const request=ui.messages.filter(m=>m.type==='export').at(-1);
 assert.equal(request.settings.seed,'123');assert.equal(request.settings.entry.patch.radius_x,400);assert.equal(request.settings.entry.patch.temperature,'cold');
 assert.equal(ui.messages.some(m=>m.type==='entry-change'),false);assert.equal(ui.elements.get('editorCanvas').hidden,true);
 await ui.finishExport(1);assert.equal(ui.elements.get('editorCanvas').hidden,true);
});

test('Enter validates pending object fields before changing the applied preview',()=>{
 const ui=workspace(),entry={type:'island',name:'Island',x:0,z:0,radius:128};
 ui.emit({type:'loaded',epoch:0,name:'Test map',seed:'2',editor:{radius:128,roughness:.25},base:{entries:[entry]},preserveHistory:true,selected:0});
 const form=ui.elements.get('shapeForm');form.listeners.input();form.reportValidity=()=>false;
 const before=ui.messages.filter(m=>m.type==='export').length;
 ui.window.listeners.keydown({key:'Enter',target:{tagName:'INPUT'},preventDefault(){}});
 assert.equal(ui.messages.filter(m=>m.type==='export').length,before);assert.equal(ui.applied.length,0);
});

test('Enter in viewport controls uses the latest settings but leaves JSON and native buttons alone',async()=>{
 const ui=workspace();ui.elements.get('editorSeed').value='9';
 const target={tagName:'SELECT'};ui.window.listeners.keydown({key:'Enter',target,preventDefault(){}});
 assert.equal(ui.messages.filter(m=>m.type==='export').at(-1).settings.seed,'9');await ui.finishExport(1);
 const before=ui.messages.filter(m=>m.type==='export').length;
 for(const tagName of ['TEXTAREA','BUTTON','SUMMARY'])ui.window.listeners.keydown({key:'Enter',target:{tagName},preventDefault(){throw new Error('Native Enter must be preserved')}});
 for(const extra of [{isComposing:true},{repeat:true},{ctrlKey:true}]){
  ui.document.activeElement={tagName:'INPUT'};
  ui.window.listeners.keydown({key:'Enter',target:ui.document.activeElement,...extra,preventDefault(){throw new Error('Not a new Enter application')}});
 }
 assert.equal(ui.messages.filter(m=>m.type==='export').length,before);
});

test('failed Enter application preserves the previous exact preview',async()=>{
 const ui=workspace();ui.elements.get('inspectModeButton').listeners.click();await ui.finishExport(0);
 ui.elements.get('editorSeed').value='';ui.window.listeners.keydown({key:'Enter',target:{tagName:'INPUT'},preventDefault(){}});
 const request=ui.messages.filter(m=>m.type==='export').at(-1);
 ui.emit({type:'error',epoch:0,id:request.id,error:'Enter a world seed',seed:'2',name:'Test map',oceanTemperature:''});
 await new Promise(setImmediate);assert.equal(ui.applied.length,1);assert.equal(ui.elements.get('applyEditorButton').disabled,false);
 assert.equal(ui.elements.get('editorStatus').textContent,'Enter a world seed');
});
