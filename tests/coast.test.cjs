const {test}=require('node:test'),assert=require('node:assert/strict');
const core=require('../mask-core'),{Model}=require('../editor-model');
const coast=(b=16,s=128)=>({beach_width_blocks:b,shallow_ocean_width_blocks:s});
const island=(patch={})=>({x:0,z:0,radius:160,roughness:0,coast:coast(),...patch});
const setup=entries=>{const config={enabled:true,generation_version:4,entries};return {config,compiled:core.parseConfig(config,2n)}};
function sample(scene,x,z){const details={};const value=core.sampleMask(scene.config,scene.compiled,x,z,details);return {value,zone:details.zone};}

test('coast widths are strict, versioned and survive project, preset and undo roundtrips',()=>{
 const m=new Model({entries:[{x:0,z:0,radius:160}]},'2');
 m.changeEntry(0,{coast:coast()});assert.equal(m.preset().generation_version,4);
 assert.deepEqual(new Model(m.project()).preset(),m.preset());
 m.history();assert.equal(m.preset().generation_version,3);m.history(true);assert.equal(m.preset().generation_version,4);
 const before=m.preset();for(const value of [null,{},coast(-1),coast(.5),coast(4097),coast(16,NaN)]){
  if(value===null)continue;assert.throws(()=>m.changeEntry(0,{coast:value}));assert.deepEqual(m.preset(),before);
 }
 assert.throws(()=>core.readDocument({...before,generation_version:3}),/generation_version 4/);
 assert.throws(()=>setup([island({type:'ocean'})]));
 m.changeEntry(0,{coast:null});assert.equal(m.config.entries[0].coast,undefined);assert.equal(m.preset().generation_version,4);
});

test('beach is inland and shallow ocean is offshore without changing the waterline',()=>{
 const scene=setup([island()]);
 assert.equal(sample(scene,144,0).zone,3);assert.equal(sample(scene,120,0).zone,4);
 assert.equal(sample(scene,200,0).zone,2);assert.equal(sample(scene,320,0).zone,1);
 for(let x=-340;x<=340;x+=3.5){const raw=core.sampleRawMask(scene.config,scene.compiled,x,9);assert.equal(sample(scene,x,9).value>=.54,raw>=.54);}
 const resized=setup([island({radius:320})]);assert.equal(sample(resized,360,0).zone,2);assert.equal(sample(resized,460,0).zone,1);
 const none=setup([island({coast:coast(0,0)})]);assert.notEqual(sample(none,152,0).zone,3);assert.notEqual(sample(none,170,0).zone,2);
});

test('overlapping land has no internal beach and ocean cutouts retain their water',async()=>{
 const scene=setup([island({x:-80}),island({x:80})]);assert.equal(sample(scene,0,0).zone,4);
 const m=new Model({entries:[]},'2');
 for(const [tool,radius]of [['land',160],['ocean',48]]){m.begin({tool,radius,roughness:0});await m.point(-256,-256);m.end();}
 await m.selectPaint(-336,-256);const index=await m.convertPaint();m.changeEntry(index,{coast:coast(128,128)});
 const donut=setup(m.preset().entries);assert.equal(sample(donut,-256,-256).zone,2);assert.ok(sample(donut,-256,-256).value<.54);
 assert.equal(sample(donut,-304,-256).zone,3);
 m.changeEntry(index,{x:512,z:128,radius_x:300,radius_z:180,rotation:37});const moved=setup(m.preset().entries);assert.ok(sample(moved,512,128).value<.54);
 assert.equal(sample(moved,-256,-256).value,0);
});

test('maximum widths are finite and contour caches are bounded',()=>{
 const scene=setup([island({coast:coast(4096,4096)})]);const start=performance.now();
 assert.equal(sample(scene,4000,0).zone,2);assert.equal(sample(scene,4400,0).value,0);
 for(let x=-256;x<=256;x+=8)assert.ok(Number.isFinite(sample(scene,x,0).value));
 assert.ok(scene.compiled.coastField.tiles.size<=512);assert.ok(scene.compiled.coastField.hints.size<=1024);
 console.log(`coast maximum-width scenario: ${(performance.now()-start).toFixed(1)} ms`);
});

test('large coast queries yield for cancellation and reuse bounded empty geometry tiles',async()=>{
 const scene=setup([island({radius:5000,roughness:.18,coast:coast(16,4096)})]);let active=true,yields=0;
 const start=performance.now(),cancelled=await core.sampleMaskAsync(scene.config,scene.compiled,8800,0,{},()=>active,async()=>{yields++;active=false;await new Promise(setImmediate);});
 assert.equal(cancelled,null);assert.ok(yields>0);assert.ok(performance.now()-start<100,'cold coast work must allow cancellation within 100 ms');
 active=true;const details={},value=await core.sampleMaskAsync(scene.config,scene.compiled,8800,0,details,()=>active,()=>new Promise(setImmediate));
 assert.ok(Number.isFinite(value));assert.equal(details.zone,2);
 assert.ok(scene.compiled.coastField.emptyTiles.size<=32768);assert.ok(scene.compiled.coastField.tiles.size<=512);
 assert.equal(value,core.sampleMask(scene.config,scene.compiled,8800,0));
});

test('overlapping shelves retain the wider island band beyond a neighboring short shelf',()=>{
 const scene=setup([island({coast:coast(16,512)}),island({x:600,radius:80,coast:coast(16,16)})]);
 assert.equal(sample(scene,470,0).zone,2);
});
