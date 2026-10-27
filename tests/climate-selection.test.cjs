const {test}=require('node:test'),assert=require('node:assert/strict');
const {Model}=require('../editor-model.js'),mask=require('../mask-core.js'),{choices}=require('../climate-options.js');
const base=()=>({generation_version:4,enabled:true,entries:[{x:0,z:0,radius:128,temperature:'standard'}]});

test('map climate opts into generation five and one undo restores the legacy document',()=>{
 const m=new Model(base(),'2');m.applySettings({temperature:'biomesoplenty:mushroom'});
 assert.equal(m.preset().generation_version,5);assert.equal(m.config.temperature,'biomesoplenty:mushroom');
 m.history();assert.equal(m.preset().generation_version,4);assert.equal(m.config.temperature,undefined);
 m.history(true);assert.equal(m.config.temperature,'biomesoplenty:mushroom');
});
test('every declared category survives project export; no profile path enters the preset',()=>{
 for(const c of choices){const m=new Model(base(),'2');m.applySettings({temperature:c.id,profile:{id:'pack-123',fingerprint:'abc',worldPreset:'minecraft:normal'}});
  const copy=new Model(m.project({x:0,z:0,blocksPerPixel:8}));assert.equal(copy.config.temperature,c.id==='standard'?undefined:c.id);
  assert.deepEqual(copy.editor.profile,m.editor.profile);assert.equal(m.preset().profile,undefined);
 }
});
test('invalid climate is atomic and legacy versions cannot silently consume new rules',()=>{
 const m=new Model(base());const before=JSON.stringify(m.project());
 assert.throws(()=>m.applySettings({temperature:'unknown:magic',seed:'123'}));assert.equal(JSON.stringify(m.project()),before);
 assert.throws(()=>mask.readDocument({...base(),temperature:'cold'}),/generation_version 5/);
 const config={...base(),generation_version:5,temperature:'terralith:mystical'};assert.doesNotThrow(()=>mask.parseConfig(config,2n));
});
test('category and Natural changes to an island preserve unrelated settings through undo',()=>{
 const m=new Model(base());m.changeEntry(0,{temperature:'terralith:volcanic'});assert.equal(m.preset().generation_version,5);
 m.changeEntry(0,{temperature:'natural'});assert.equal(m.config.entries[0].temperature,'natural');m.history();assert.equal(m.config.entries[0].temperature,'terralith:volcanic');
});

test('version inference and legacy climate aliases follow the Java document reader',()=>{
 assert.equal(mask.readDocument({entries:[],temperature:'standard'}).generationVersion,5);
 assert.equal(mask.readDocument({entries:[],temperature:'standard',generation_version:4}).generationVersion,4);
 assert.throws(()=>mask.readDocument({entries:[{climate:'minecraft:mushroom'}]}),/generation_version 5/);
 assert.doesNotThrow(()=>mask.readDocument({generation_version:5,entries:[{climate:'minecraft:mushroom'}]}));
});
