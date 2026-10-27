const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function harness(){
 const elements=new Map(),events=[],requests=[];
 const element=()=>({value:'',hidden:false,disabled:false,children:[],listeners:{},classList:{toggle(){}},addEventListener(t,f){this.listeners[t]=f},replaceChildren(){this.children=[]},append(v){this.children.push(v)},get options(){return this.children}});
 const get=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id)};get('profileHeap').value='2048';get('generationProfile').value='vanilla';
 const profiles=[{id:'vanilla',name:'Minecraft + WGE',heap_mib:512,status:'verified'},{id:'supported-bop',name:'BOP',heap_mib:2048,status:'unverified'}];
 let hook=null;
 const fetch=async(url,options)=>{requests.push({url,body:options?.body});if(hook){const custom=hook(url,options);if(custom)return custom;}
  let value=url==='biome-palette.json'?{}:url.includes('profiles/list')?{profiles}:url.includes('catalog?')?{resources:url.includes('bop')?'bop-resources':'vanilla-resources',climates:[],biomes:[],world_presets:['minecraft:normal']}:{};
  return {ok:true,json:async()=>value};};
 const window={dispatchEvent:e=>events.push(e.type)},sandbox={window,document:{getElementById:get,createElement:element},fetch,CustomEvent:class{constructor(type){this.type=type}},WgeBiomeColors:{installCatalog(){}},WgeDocument:require('../document-format.js'),setTimeout:fn=>setImmediate(fn),console};
 vm.runInNewContext(fs.readFileSync(require.resolve('../profiles.js'),'utf8'),sandbox);
 return {state:window.WgeProfiles,get,requests,events,hook:fn=>hook=fn};
}
const exported=()=>({metadataText:'{"generation_version":5,"entries":[]}',paintText:null,seed:'2'});

test('profile selection uses a local catalog and preflight includes profile and world preset',async()=>{
 const h=harness();await h.state.ready;h.get('generationProfile').value='supported-bop';h.get('generationProfile').listeners.change();await h.state.ready;
 const applied=await h.state.validate(exported());assert.equal(applied.id,'supported-bop');
 const request=JSON.parse(h.requests.findLast(r=>r.url==='/api/session').body);assert.equal(request.profile,'supported-bop');assert.equal(request.world_preset,'minecraft:normal');assert.equal(request.generation_version,5);
});
test('a late catalog cannot replace the most recently selected profile',async()=>{
 const h=harness();await h.state.ready;let release;h.hook(url=>url.includes('catalog?profile=supported-bop')?new Promise(r=>release=r):null);
 h.get('generationProfile').value='supported-bop';h.get('generationProfile').listeners.change();const old=h.state.ready;
 h.get('generationProfile').value='vanilla';h.get('generationProfile').listeners.change();await h.state.ready;
 release({ok:true,json:async()=>({resources:'obsolete',biomes:[],climates:[]})});await old;
 assert.equal(h.state.selection.id,'vanilla');assert.equal(h.state.selection.fingerprint,'vanilla-resources');
});
test('failed server validation does not replace the selected profile; obsolete validation is rejected',async()=>{
 const h=harness();await h.state.ready;const initial={...h.state.selection};h.hook(url=>url==='/api/session'?Promise.resolve({ok:false,json:async()=>({error:'No surface biomes available'})}):null);
 await assert.rejects(h.state.validate(exported()),/No surface biomes/);assert.deepEqual({...h.state.selection},initial);
 let release;h.hook(url=>url==='/api/session'?new Promise(r=>release=r):null);const pending=h.state.validate(exported());await new Promise(setImmediate);
 h.state.selection={...initial,id:'supported-bop'};release({ok:true,json:async()=>({session:'old'})});await assert.rejects(pending,/profile changed/);
});

test('a missing project profile blocks exact preview until an available profile is selected',async()=>{
 const h=harness();await h.state.ready;await h.state.restore({id:'pack-missing',fingerprint:'old',worldPreset:'minecraft:normal'});
 await assert.rejects(h.state.validate(exported()),/Project modpack is unavailable/);
 assert.equal(h.get('useVanillaButton').hidden,false);
 h.get('useVanillaButton').listeners.click();await h.state.ready;
 assert.equal((await h.state.validate(exported())).id,'vanilla');
});

test('alternate world presets do not inherit the normal preset verification status',async()=>{
 const h=harness();await h.state.ready;
 h.hook(url=>url.includes('catalog?profile=supported-bop')?Promise.resolve({ok:true,json:async()=>({accuracy:'verified',resources:'checked',biomes:[],climates:[],world_presets:['minecraft:normal','example:other']})}):null);
 h.get('generationProfile').value='supported-bop';h.get('generationProfile').listeners.change();await h.state.ready;
 assert.equal(h.get('accuracyProfile').textContent,'Verified modpack');
 h.get('worldPreset').value='example:other';h.get('worldPreset').listeners.change();
 assert.equal(h.get('accuracyProfile').textContent,'Unverified modpack');
});
