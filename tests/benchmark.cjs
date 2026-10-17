global.WgeMask=require('../mask-core.js');
const {create}=require('../render-core.js'),fs=require('node:fs'),path=require('node:path');
const config=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../WorldGen Editor/common/src/main/resources/assets/worldgen_editor/presets/default.json')));
(async()=>{const renderer=create(),times=[];const message={id:1,configText:JSON.stringify(config),seedText:'12345',view:{x:0,z:0,blocksPerPixel:8},width:256,height:256,quality:1,cssWidth:256,cssHeight:256,source:'mask',heightMode:'surface'};
for(let i=0;i<3;i++){const start=performance.now();await renderer.render(message,()=>true);times.push(Math.round(performance.now()-start));}
console.log(JSON.stringify({exact256_ms:times,cache_tiles:renderer.cacheSize()}));})();
