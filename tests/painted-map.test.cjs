const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {Grid}=require('../painted-map.js'),mask=require('../mask-core.js');
test('painted mask matches the cross-language fixture, including negative tile seams',()=>{
 const f=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../WorldGen Editor/common/src/test/resources/painted-mask.json')));
 const map=new Grid(f.map);
 for(const [x,z,base,expected] of f.points)assert.ok(Math.abs(map.apply(base,x,z)-expected)<1e-12);
 assert.deepEqual(new Grid(map.toJSON()).toJSON(),map.toJSON());
 const config={entries:[],painted_map:f.map},compiled=mask.parseConfig(config,0n);
 assert.equal(mask.sampleMask(config,compiled,-1,-1),map.apply(0,-1,-1));
 assert.equal(mask.readDocument(config).generationVersion,3);
 assert.throws(()=>mask.readDocument({generation_version:2,config}));
});
test('painted mask rejects overflow, invalid runs, duplicates and unsupported formats',()=>{
 const tile={x:0,z:0,runs:[4096,65535,65535]},base={version:1,step:4,size:64};
 for(const input of [null,{}, {...base,tiles:[{...tile,runs:[4097,1,1]}]}, {...base,tiles:[tile,tile]},
  {...base,tiles:[{...tile,x:1.5}]},{...base,tiles:[{...tile,runs:[4096,65536,0]}]}])assert.throws(()=>new Grid(input));
 assert.equal(new Grid({...base,tiles:[tile]}).apply(0,0,0),1);
 assert.equal(new Grid({...base,tiles:[tile]}).apply(0,-2,0),.5);
});
