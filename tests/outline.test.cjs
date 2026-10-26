const {test}=require('node:test'),assert=require('node:assert/strict');
const {Model}=require('../editor-model.js'),mask=require('../mask-core.js');
async function paint(model,tool,x,z,radius,roughness=.3){model.begin({tool,radius,roughness});await model.point(x,z);model.end();}
const sorted=value=>({...value,tiles:value.tiles.slice().sort((a,b)=>a.x-b.x||a.z-b.z)});

test('conversion retains the exact feathered contour, ocean hole and other islands over a procedural base',async()=>{
 const model=new Model({enabled:true,generation_version:2,entries:[{x:-257,z:-257,radius:180,roughness:.2}]},'2');
 await paint(model,'land',-257,-257,160);await paint(model,'ocean',-257,-257,32,0);await paint(model,'land',800,800,64);
 const original=model.preset(),old=mask.parseConfig(original,2n),beforePaint=model.grid.toJSON(),history=model.undoStack.length;
 await model.selectPaint(-337,-257);const index=await model.convertPaint(),converted=model.preset(),compiled=mask.parseConfig(converted,2n);
 assert.equal(index,1);assert.equal(model.undoStack.length,history+1);assert.ok(converted.entries[1].outline);
 for(let x=-480;x<-32;x+=13.25)for(let z=-480;z<-32;z+=11.75)
  assert.ok(Math.abs(mask.sampleMask(original,old,x,z)-mask.sampleMask(converted,compiled,x,z))<1e-12,`conversion changed coast at ${x},${z}`);
 assert.equal(model.grid.apply(0,800,800),1,'another painted island must stay in the root layer');
 assert.equal(model.grid.node(Math.round(-257/4),Math.round(-257/4)),0,'the enclosed ocean hole must move into the outline too');
 const roundtrip=new Model(model.project({x:0,z:0,blocksPerPixel:4}));assert.deepEqual(roundtrip.preset(),converted);
 model.history();assert.equal(model.config.entries.length,1);assert.deepEqual(sorted(model.grid.toJSON()),sorted(beforePaint));
 model.history(true);assert.deepEqual(model.preset(),converted);
});

test('converted islands transform independently without replacing their contour',async()=>{
 const model=new Model({entries:[]},'2');await paint(model,'land',-257,-257,96);await model.selectPaint(-257,-257);const index=await model.convertPaint();
 const outline=structuredClone(model.config.entries[index].outline);
 model.changeEntry(index,{x:512,z:-128,radius_x:220,radius_z:75,rotation:37,temperature:'warm'});
 assert.deepEqual(model.config.entries[index].outline,outline);const config=model.preset(),compiled=mask.parseConfig(config,2n),shape=compiled.outlines[0];
 for(const [x,z]of [[512,-128],[540,-100],[600,-160],[800,0]]){
  const dx=x-512,dz=z+128,field=shape.outline.mask.field((dx*shape.cos-dz*shape.sin)*shape.outlineScaleX,(dx*shape.sin+dz*shape.cos)*shape.outlineScaleZ);
  assert.ok(Math.abs(mask.sampleMask(config,compiled,x,z)-field.weightedValue)<1e-12);
 }
 assert.equal(model.config.entries[index].temperature,'warm');const other=model.duplicateEntry(index);assert.equal(other,1);assert.deepEqual(model.config.entries[1].outline,outline);
});

test('invalid/stale conversion cannot replace a working document',async()=>{
 const model=new Model({entries:[]});await paint(model,'land',0,0,64);await model.selectPaint(0,0);model.rename('Changed');const before=model.preset();
 await assert.rejects(model.convertPaint(),/Select the painted island again/);assert.deepEqual(model.preset(),before);
 await model.selectPaint(0,0);assert.equal(await model.convertPaint(()=>false),null);assert.deepEqual(model.preset(),before);
 const index=await model.convertPaint(),good=model.preset();
 for(const bad of [null,{}, {...good.entries[index].outline,mask:null},{...good.entries[index].outline,radius_x:.001}]){
  assert.throws(()=>model.changeEntry(index,{outline:bad}));assert.deepEqual(model.preset(),good);
 }
 assert.throws(()=>mask.readDocument({...good,generation_version:2}),/generation_version 3/);
 assert.throws(()=>model.changeEntry(index,{type:'ocean'}),/outlined_island/);
});
