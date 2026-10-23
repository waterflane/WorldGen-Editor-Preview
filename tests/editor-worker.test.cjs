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
