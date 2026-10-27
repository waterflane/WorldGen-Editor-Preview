const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {Worker}=require('node:worker_threads');
function worker(){
 const w=new Worker(`const {parentPort,workerData}=require('node:worker_threads'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
 global.self={postMessage:(m,t)=>parentPort.postMessage(m,t)};
 global.importScripts=(...names)=>{for(const name of names)vm.runInThisContext(fs.readFileSync(path.join(workerData,name),'utf8'),{filename:name});};
 importScripts('editor.worker.js');parentPort.on('message',data=>self.onmessage({data}));`,{eval:true,workerData:path.resolve(__dirname,'..')});
 const inbox=[],waiters=[];
 w.on('message',m=>{const index=waiters.findIndex(x=>x.predicate(m));if(index<0)inbox.push(m);else{const q=waiters.splice(index,1)[0];clearTimeout(q.timer);q.resolve(m);}});
 return {send:m=>w.postMessage(m),close:()=>w.terminate(),next:predicate=>{const i=inbox.findIndex(predicate);if(i>=0)return Promise.resolve(inbox.splice(i,1)[0]);return new Promise((resolve,reject)=>{const q={predicate,resolve,timer:setTimeout(()=>reject(new Error('Worker response timed out')),5000)};waiters.push(q);});}};
}
test('worker preserves the document after invalid imports and serializes brush/save/undo operations',async()=>{
 const w=worker();try{
  w.send({type:'load',input:{entries:[]},seed:'0'});await w.next(m=>m.type==='state');
  w.send({type:'begin',brush:{tool:'land',radius:64,roughness:.3}});
  w.send({type:'points',points:[{x:-200,z:-100},{x:200,z:-100}]});w.send({type:'end'});
  const edited=await w.next(m=>m.type==='state'&&m.revision===1);assert.ok(edited.canUndo);
  w.send({type:'export',kind:'project',id:1,view:{x:0,z:0,blocksPerPixel:4}});
  const saved=await w.next(m=>m.type==='export'&&m.id===1),project=JSON.parse(saved.text);assert.ok(project.config.painted_map.tiles.length);
  w.send({type:'load',input:'{bad json',seed:'0'});await w.next(m=>m.type==='error');
  w.send({type:'export',kind:'project',id:2,view:{x:0,z:0,blocksPerPixel:4}});
  assert.equal((await w.next(m=>m.type==='export'&&m.id===2)).text,saved.text);
  w.send({type:'undo'});assert.ok((await w.next(m=>m.type==='state')).canRedo);
  w.send({type:'redo'});assert.ok((await w.next(m=>m.type==='state')).canUndo);
 }finally{await w.close();}
});
test('worker cancels a large obsolete brush cooperatively and rolls back its document',async()=>{
 const w=worker();try{
  w.send({type:'load',input:{entries:[]},seed:'0'});await w.next(m=>m.type==='state');
  w.send({type:'begin',brush:{tool:'land',radius:2048,roughness:1}});w.send({type:'points',points:[{x:0,z:0}]});
  await w.next(m=>m.type==='patch');const started=performance.now();w.send({type:'cancel'});
  const state=await w.next(m=>m.type==='state');assert.equal(state.tileCount,0);assert.equal(state.canUndo,false);
  assert.ok(performance.now()-started<100,'cancellation must yield in 100 ms');
 }finally{await w.close();}
});

test('renaming a map updates both file formats and invalid names preserve the previous document',async()=>{
 const w=worker();try{
  w.send({type:'load',input:{entries:[]},seed:'0'});await w.next(m=>m.type==='state');
  w.send({type:'name',name:' Hidden Coast '});assert.equal((await w.next(m=>m.type==='state'&&m.revision===1)).name,'Hidden Coast');
  w.send({type:'export',kind:'preset',id:10});
  const preset=await w.next(m=>m.type==='export'&&m.id===10);assert.equal(preset.filename,'Hidden-Coast.json');assert.equal(JSON.parse(preset.text).name,'Hidden Coast');
  w.send({type:'name',name:''});assert.equal((await w.next(m=>m.type==='error')).name,'Hidden Coast');
  w.send({type:'export',kind:'project',id:11,view:{x:0,z:0,blocksPerPixel:4}});
  const project=await w.next(m=>m.type==='export'&&m.id===11);assert.equal(project.filename,'Hidden-Coast.wge.json');assert.equal(JSON.parse(project.text).name,'Hidden Coast');
 }finally{await w.close();}
});

test('ocean setting changes are serialized, exported for Apply and restored from a saved draft',async()=>{
 const w=worker();try{
  w.send({type:'load',input:{entries:[]},seed:'2'});await w.next(m=>m.type==='state');
  w.send({type:'ocean-temperature',value:'cold'});
  const state=await w.next(m=>m.type==='state'&&m.revision===1);assert.equal(state.oceanTemperature,'cold');assert.equal(state.canUndo,true);
  w.send({type:'export',kind:'apply',id:20});
  assert.equal(JSON.parse((await w.next(m=>m.type==='export'&&m.id===20)).metadataText).ocean_temperature,'cold');
  w.send({type:'export',kind:'project',id:21,view:{x:0,z:0,blocksPerPixel:4}});
  const draft=(await w.next(m=>m.type==='export'&&m.id===21)).text;
  w.send({type:'ocean-temperature',value:'invalid'});assert.equal((await w.next(m=>m.type==='error')).oceanTemperature,'cold');
  w.send({type:'load',input:JSON.stringify({entries:[],ocean_temperature:null}),seed:'2'});await w.next(m=>m.type==='error');
  w.send({type:'export',kind:'project',id:22,view:{x:0,z:0,blocksPerPixel:4}});
  assert.equal((await w.next(m=>m.type==='export'&&m.id===22)).text,draft);
  w.send({type:'ocean-temperature',value:''});assert.equal((await w.next(m=>m.type==='state'&&m.revision===2)).oceanTemperature,'');
  w.send({type:'load',input:draft});assert.equal((await w.next(m=>m.type==='state'&&m.revision===0)).oceanTemperature,'cold');
 }finally{await w.close();}
});

test('selecting and moving a painted island is serialized before exact-preview export',async()=>{
 const w=worker();try{
  w.send({type:'load',input:{entries:[]},seed:'2'});await w.next(m=>m.type==='state');
  w.send({type:'begin',brush:{tool:'land',radius:64,roughness:0}});w.send({type:'points',points:[{x:-257,z:-257}]});w.send({type:'end'});
  // Export immediately after ending the stroke, without waiting for its state acknowledgement.
  w.send({type:'export',kind:'apply',id:40});const applied=await w.next(m=>m.type==='export'&&m.id===40);
  assert.ok(JSON.parse(applied.paintText).tiles.length);assert.equal(applied.revision,1);
  w.send({type:'paint-pick',pick:1,x:-257,z:-257});const picked=await w.next(m=>m.type==='paint-picked');assert.ok(picked.selection.samples);
  w.send({type:'paint-move',pick:1,dx:512,dz:256});const moved=await w.next(m=>m.type==='paint-picked');assert.equal(moved.selection.anchorX,picked.selection.anchorX+512);
  w.send({type:'export',kind:'apply',id:41});const result=await w.next(m=>m.type==='export'&&m.id===41);
  const {Grid}=require('../painted-map.js'),grid=new Grid(JSON.parse(result.paintText));assert.equal(grid.apply(0,255,-1),1);assert.equal(grid.apply(0,-257,-257),0);
 }finally{await w.close();}
});

test('conversion creates an editable island, exports its contour and undoes as one action',async()=>{
 const w=worker();try{
  w.send({type:'load',input:{entries:[]},seed:'2'});await w.next(m=>m.type==='state');
  w.send({type:'begin',brush:{tool:'land',radius:64,roughness:.3}});w.send({type:'points',points:[{x:-257,z:-257}]});w.send({type:'end'});
  w.send({type:'paint-pick',pick:1,x:-257,z:-257});await w.next(m=>m.type==='paint-picked');
  w.send({type:'paint-convert'});const converted=await w.next(m=>m.type==='loaded'&&m.preserveHistory);assert.equal(converted.selected,0);assert.ok(converted.base.entries[0].outline);
  w.send({type:'entry-change',index:0,patch:{radius_x:120,rotation:45,temperature:'warm'}});await w.next(m=>m.type==='state'&&m.revision===3);
  w.send({type:'export',kind:'preset',id:50});const preset=JSON.parse((await w.next(m=>m.type==='export'&&m.id===50)).text);
  assert.equal(preset.entries[0].temperature,'warm');assert.equal(preset.entries[0].rotation,45);assert.ok(preset.entries[0].outline.mask.tiles.length);assert.equal(preset.painted_map.tiles.length,0);
  w.send({type:'undo'});await w.next(m=>m.type==='state'&&m.revision===4);
  w.send({type:'undo'});const restored=await w.next(m=>m.type==='state'&&m.revision===5);assert.ok(restored.tileCount);
  w.send({type:'export',kind:'preset',id:51});const before=JSON.parse((await w.next(m=>m.type==='export'&&m.id===51)).text);assert.equal(before.entries.length,0);assert.ok(before.painted_map.tiles.length);
 }finally{await w.close();}
});

test('coast profiles are exported for exact Apply and invalid edits cannot replace a saved draft',async()=>{
 const w=worker();try{
  w.send({type:'load',input:{entries:[{x:0,z:0,radius:160}]},seed:'2'});await w.next(m=>m.type==='state');
  const coast={beach_width_blocks:32,shallow_ocean_width_blocks:256};w.send({type:'entry-change',index:0,patch:{coast}});await w.next(m=>m.type==='state'&&m.revision===1);
  w.send({type:'export',kind:'apply',id:71});const applied=JSON.parse((await w.next(m=>m.type==='export'&&m.id===71)).metadataText);
  assert.equal(applied.generation_version,4);assert.deepEqual(applied.entries[0].coast,coast);
  w.send({type:'export',kind:'project',id:72});const draft=(await w.next(m=>m.type==='export'&&m.id===72)).text;
  w.send({type:'entry-change',index:0,patch:{coast:{...coast,beach_width_blocks:-1}}});await w.next(m=>m.type==='error');
  w.send({type:'export',kind:'project',id:73});assert.equal((await w.next(m=>m.type==='export'&&m.id===73)).text,draft);
  w.send({type:'load',input:draft,seed:'2'});await w.next(m=>m.type==='state'&&m.revision===0);
  w.send({type:'export',kind:'preset',id:74});assert.deepEqual(JSON.parse((await w.next(m=>m.type==='export'&&m.id===74)).text).entries[0].coast,coast);
 }finally{await w.close();}
});

test('Apply commits the current seed and object settings atomically and undoes them together',async()=>{
 const w=worker();try{
  w.send({type:'load',input:{name:'Before',entries:[{x:0,z:0,radius:160}]},seed:'2'});await w.next(m=>m.type==='state');
  const settings={seed:'314',name:'After',oceanTemperature:'warm',entry:{index:0,patch:{radius_x:240,temperature:'cold'}}};
  w.send({type:'export',kind:'apply',id:80,settings});
  const result=await w.next(m=>m.type==='export'&&m.id===80),config=JSON.parse(result.metadataText);
  assert.equal(result.seed,'314');assert.equal(result.revision,1);assert.equal(config.name,'After');assert.equal(config.ocean_temperature,'warm');
  assert.equal(config.entries[0].radius_x,240);assert.equal(config.entries[0].temperature,'cold');
  w.send({type:'undo'});await w.next(m=>m.type==='state'&&m.revision===2);
  w.send({type:'export',kind:'apply',id:81});
  const undone=await w.next(m=>m.type==='export'&&m.id===81),before=JSON.parse(undone.metadataText);
  assert.equal(undone.seed,'2');assert.equal(before.name,'Before');assert.equal(before.ocean_temperature,undefined);assert.equal(before.entries[0].radius,160);
  assert.equal(before.entries[0].temperature,undefined);
  w.send({type:'export',kind:'apply',id:82,settings:{...settings,entry:{index:0,patch:{radius_x:0}}}});
  await w.next(m=>m.type==='error'&&m.id===82);
  w.send({type:'export',kind:'apply',id:83});
  const afterError=await w.next(m=>m.type==='export'&&m.id===83);
  assert.equal(afterError.seed,undone.seed);assert.equal(afterError.metadataText,undone.metadataText);assert.equal(afterError.revision,undone.revision);
  w.send({type:'export',kind:'apply',id:84,settings:{...settings,seed:''}});
  assert.match((await w.next(m=>m.type==='error'&&m.id===84)).error,/seed/);
 }finally{await w.close();}
});
