// Model measurements exclude worker transport and browser presentation. Browser
// canvas data-first-brush-frame-ms separately includes the first actual draw.
const {Model}=require('../editor-model.js');
(async()=>{
 const results=[];
 for(const scenario of ['large_area','distant_islands']){
  const model=new Model({entries:[]}),start=performance.now();let firstPatch=null;
  if(scenario==='large_area'){
   model.begin({tool:'land',radius:2048,roughness:.4});
   for(const [x,z] of [[-2500,0],[2500,0]])await model.point(x,z,()=>firstPatch??=performance.now()-start);model.end();
  }else{
   for(let i=0;i<100;i++){
    model.begin({tool:'land',radius:128,roughness:.4});await model.point((i-50)*50000,(i%7-3)*70000,()=>firstPatch??=performance.now()-start);model.end();
   }
  }
  const elapsed=performance.now()-start,serialize=performance.now(),text=JSON.stringify(model.project({x:0,z:0,blocksPerPixel:8}));
  results.push({scenario,first_model_patch_ms:firstPatch,model_complete_ms:elapsed,serialization_ms:performance.now()-serialize,
   encoded_bytes:Buffer.byteLength(text),painted_tiles:model.grid.tiles.size,history_bytes:model.historyBytes});
 }
 console.log(JSON.stringify({note:'Model only; not an end-to-end browser latency measurement',results},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
