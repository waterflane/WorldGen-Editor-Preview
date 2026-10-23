const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {prepare,attach}=require('../document-format.js');
test('painted preset payload survives metadata editing without main-thread mask decoding',()=>{
 const preset=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../WorldGen Editor/common/src/test/resources/painted-islands.json')));
 const ready=prepare(JSON.stringify(preset),'+123'),small=JSON.parse(ready.metadataText);
 assert.equal(small.painted_map,undefined);assert.equal(ready.seedText,'123');assert.ok(ready.bounds.tiles>0);
 small.outer_ocean='minecraft:cold_ocean';
 const complete=JSON.parse(attach(small,ready.paintText));
 assert.deepEqual(complete.painted_map,preset.painted_map);assert.equal(complete.outer_ocean,'minecraft:cold_ocean');
 const snapshot={enabled:false,generation_version:3,preset:'custom_map',config:preset};
 const world=prepare(JSON.stringify(snapshot),'0');assert.deepEqual(JSON.parse(attach(JSON.parse(world.metadataText),world.paintText)),snapshot);
 assert.deepEqual(JSON.parse(attach({},ready.paintText)),{painted_map:preset.painted_map});
 assert.deepEqual(JSON.parse(attach({config:{}},ready.paintText)),{config:{painted_map:preset.painted_map}});
});
test('document preparation rejects malformed and editor-only files before replacing a working map',()=>{
 assert.throws(()=>prepare('{','0'));assert.throws(()=>prepare(JSON.stringify({format:'wge-map-project',version:1,config:{entries:[]}}),'0'));
 assert.throws(()=>prepare(JSON.stringify({entries:[],generation_version:2,painted_map:{version:1,step:4,size:64,tiles:[]}}),'0'));
});
