/* Worker-owned document, sparse capsule brushes and bounded stroke history. */
(function(root){
  const {Grid,SIZE,STEP,MAX_TILES}=root.WgePaintedMap||(typeof require==='function'?require('./painted-map.js'):{});
  const mask=root.WgeMask||(typeof require==='function'?require('./mask-core.js'):{});
  const climate=root.WgeClimate||(typeof require==='function'?require('./climate-options.js'):{});
  const MAX_BYTES=32*1024*1024,BOUND=29999984;
  const pause=()=>new Promise(resolve=>typeof setImmediate==='function'?setImmediate(resolve):setTimeout(resolve,0));
  function noise(x,z){
    const hash=(x,z)=>{let n=Math.imul(x,374761393)^Math.imul(z,668265263);n=Math.imul(n^(n>>>13),1274126177);return ((n^(n>>>16))>>>0)/4294967295*2-1;};
    const ix=Math.floor(x),iz=Math.floor(z),u=x-ix,v=z-iz,s=u*u*(3-2*u),t=v*v*(3-2*v);
    return (hash(ix,iz)*(1-s)+hash(ix+1,iz)*s)*(1-t)+(hash(ix,iz+1)*(1-s)+hash(ix+1,iz+1)*s)*t;
  }
  const targetVersion=config=>Math.max(3,config.generation_version||3,climate.modern(config)?5:config.entries?.some(e=>e.coast!==undefined)?4:3);
  function validate(input,seed='0'){
    const project=input?.format==='wge-map-project';
    if(project&&input.version!==1)throw new Error('Unsupported project version');
    const document=mask.readDocument(project?{config:input.config,generation_version:input.config?.generation_version??3}:input);
    const config=structuredClone(document.config);
    config.name=project?(input.name??config.name??'Untitled Map'):(config.name??'Untitled Map');
    if(typeof config.name!=='string')throw new Error('Map name must be text');
    config.name=config.name.trim();
    if(!config.name||config.name.length>120||/[\u0000-\u001f\u007f-\u009f]/.test(config.name))throw new Error('Map name must contain 1–120 characters without control characters');
    config.enabled??=true;
    config.painted_map??={version:1,step:4,size:64,tiles:[]};
    const resolved=mask.parseSeed(project?input.seed:seed);
    if(resolved===null)throw new Error('Project requires a concrete seed');
    mask.parseConfig(config,resolved);
    const editor=project?input.editor||{}:{};
    const radius=Number(editor.radius??128),roughness=Number(editor.roughness??.25),view=editor.view;
    if(!Number.isFinite(radius)||radius<8||radius>2048||!Number.isFinite(roughness)||roughness<0||roughness>1)throw new Error('Invalid brush settings');
    if(view&&(![view.x,view.z,view.blocksPerPixel].every(Number.isFinite)||Math.abs(view.x)>BOUND||Math.abs(view.z)>BOUND||view.blocksPerPixel<1||view.blocksPerPixel>96))throw new Error('Invalid project view');
    return {config,seed:resolved.toString(),editor:{radius,roughness,...(editor.profile?{profile:structuredClone(editor.profile)}:{}),...(view?{view:{...view}}:{})}};
  }
  class Model {
    constructor(input,seed='0'){
      const parsed=validate(input,seed);Object.assign(this,parsed);
      this.grid=new Grid(this.config.painted_map);this.undoStack=[];this.redoStack=[];this.historyBytes=0;this.stroke=null;this.revision=0;
    }
    settings({radius,roughness}){
      if(!Number.isFinite(radius)||radius<8||radius>2048||!Number.isFinite(roughness)||roughness<0||roughness>1)throw new Error('Invalid brush settings');
      this.editor={...this.editor,radius,roughness};
    }
    rename(name){
      if(typeof name!=='string'||!name.trim()||name.trim().length>120||/[\u0000-\u001f\u007f-\u009f]/.test(name))throw new Error('Map name must contain 1–120 characters without control characters');
      if(name.trim()!==this.config.name)this.configure({...this.config,name:name.trim()});
    }
    oceanTemperature(value){
      if(this.stroke)throw new Error('Finish the stroke before changing ocean temperature');
      if(!['','temperate','cold','warm'].includes(value))throw new Error('Invalid coastal ocean temperature');
      if((this.config.ocean_temperature??'')===value)return;
      const next={...this.config};
      if(value)next.ocean_temperature=value;else delete next.ocean_temperature;
      this.configure(next);
    }
    remember(item){
      this.redoStack=[];this.undoStack.push(item);
      this.historyBytes=this.undoStack.reduce((n,h)=>n+h.bytes,0);
      while(this.undoStack.length>100||this.historyBytes>MAX_BYTES){this.historyBytes-=this.undoStack.shift().bytes;}
    }
    configure(config,seed=this.seed,editor=this.editor){
      if(this.stroke)throw new Error('Finish the current stroke first');
      const next={...config};delete next.painted_map;
      // New coast profiles opt into v4; other edits preserve the document generation version.
      const parsed=validate({...next,generation_version:targetVersion(next),painted_map:this.grid.toJSON()},seed),before={config:this.config,seed:this.seed,editor:this.editor};
      // Keep sparse paint and its undo history out of parameter edits.
      const after={config:{...parsed.config,painted_map:this.config.painted_map},seed:parsed.seed,editor};
      const withoutPaint=value=>{const copy={...value.config};delete copy.painted_map;return {config:copy,seed:value.seed,editor:value.editor};};
      const a=JSON.stringify(withoutPaint(before)),b=JSON.stringify(withoutPaint(after));if(a===b)return;
      const bytes=new TextEncoder().encode(a+b).length;if(bytes>MAX_BYTES)throw new Error('Parameter change exceeds the undo memory limit');
      this.config=after.config;this.seed=after.seed;this.editor=after.editor;this.remember({kind:'document',before,after,bytes});this.revision++;
    }
    entryConfig(index,patch){
      if(!Number.isInteger(index)||!this.config.entries[index])throw new Error('Select an island first');
      const entries=this.config.entries.slice();entries[index]={...entries[index],...patch};
      if(patch.coast===null)delete entries[index].coast;
      if(patch.noise)entries[index].noise={...this.config.entries[index].noise,...patch.noise};
      // A changed canonical radius must not be shadowed by a legacy alias.
      for(const [key,alias] of [['x','center_x'],['z','center_z'],['radius_x','x_divisor'],['radius_z','z_divisor'],['rotation','rotation_degrees'],['roughness','noise_strength'],['shore_width','edge_width']])if(Object.hasOwn(patch,key))delete entries[index][alias];
      return {...this.config,entries};
    }
    changeEntry(index,patch){
      this.configure(this.entryConfig(index,patch));
    }
    applySettings({seed=this.seed,name=this.config.name,oceanTemperature=this.config.ocean_temperature??'',temperature=this.config.temperature??'standard',profile=this.editor.profile,entry}={}){
      const resolved=mask.parseSeed(seed);if(resolved===null)throw new Error('Enter a world seed');
      if(!['','temperate','cold','warm'].includes(oceanTemperature))throw new Error('Invalid coastal ocean temperature');
      const next=entry?this.entryConfig(entry.index,entry.patch):{...this.config};
      if(!climate.valid(temperature))throw new Error('Invalid map temperature');
      if(temperature!=='standard')next.temperature=temperature;else delete next.temperature;
      if(temperature!==(this.config.temperature??'standard'))next.generation_version=5;
      next.name=name;
      if(oceanTemperature)next.ocean_temperature=oceanTemperature;else delete next.ocean_temperature;
      this.configure(next,resolved.toString(),{...this.editor,...(profile?{profile:structuredClone(profile)}:{})});
    }
    addEntry(type,x=0,z=0){
      if(!['island','ocean','archipelago'].includes(type))throw new Error('Invalid object type');
      const entry={name:type==='archipelago'?'Archipelago':type==='ocean'?'Ocean Cutout':'Island',type,x,z,radius:type==='archipelago'?1000:300,temperature:'standard'};
      this.configure({...this.config,entries:[...this.config.entries,entry]});return this.config.entries.length-1;
    }
    removeEntry(index){
      if(!Number.isInteger(index)||!this.config.entries[index])throw new Error('Select an island first');
      this.configure({...this.config,entries:this.config.entries.filter((_,i)=>i!==index)});
    }
    duplicateEntry(index){
      if(!Number.isInteger(index)||!this.config.entries[index])throw new Error('Select an island first');
      const entry=structuredClone(this.config.entries[index]);entry.name=(entry.name||'Island')+' Copy';entry.x=(entry.x??entry.center_x)+64;entry.z=(entry.z??entry.center_z)+64;
      this.configure({...this.config,entries:[...this.config.entries,entry]});return this.config.entries.length-1;
    }
    async selectPaint(x,z,active=()=>true){
      const start=[Math.round(x/STEP),Math.round(z/STEP)];
      // Keep every positive feather sample, not just the visible land core.
      const land=p=>(p>>>16)>0&&(p&65535)>0;
      if(!land(this.grid.node(...start))){this.paintSelection=null;return null;}
      const visited=new Map(),queue=[start],cells=[];let head=0,budget=performance.now(),minX=Infinity,minZ=Infinity,maxX=-Infinity,maxZ=-Infinity;
      while(head<queue.length){
        const [gx,gz]=queue[head++],tx=Math.floor(gx/SIZE),tz=Math.floor(gz/SIZE),key=`${tx}:${tz}`,index=(gz-tz*SIZE)*SIZE+gx-tx*SIZE;
        let marks=visited.get(key);if(!marks){marks=new Uint8Array(SIZE*SIZE);visited.set(key,marks);}if(marks[index])continue;marks[index]=1;
        const value=this.grid.node(gx,gz);if(!land(value))continue;
        cells.push([gx,gz,value]);if(cells.length>262144)throw new Error('Painted selection exceeds 262144 samples; use a smaller connected island');
        minX=Math.min(minX,gx);minZ=Math.min(minZ,gz);maxX=Math.max(maxX,gx);maxZ=Math.max(maxZ,gz);
        queue.push([gx-1,gz],[gx+1,gz],[gx,gz-1],[gx,gz+1]);
        if(performance.now()-budget>8){await pause();budget=performance.now();if(!active())return null;}
      }
      // Enclosed painted ocean belongs to this component too. The same payload
      // is used for move, delete and conversion so holes never get left behind.
      const width=maxX-minX+1,height=maxZ-minZ+1;
      if(width*height>1048576)throw new Error('Island bounds exceed 1048576 samples; select a smaller connected region');
      const points=new Set(cells.map(([x,z])=>`${x}:${z}`)),outside=new Uint8Array(width*height),flood=new Int32Array(width*height);
      let first=0,last=0;
      const push=(x,z)=>{const i=z*width+x;if(outside[i]||points.has(`${x+minX}:${z+minZ}`))return;outside[i]=1;flood[last++]=i;};
      for(let x=0;x<width;x++){push(x,0);push(x,height-1);}for(let z=0;z<height;z++){push(0,z);push(width-1,z);}
      while(first<last){const i=flood[first++],x=i%width,z=Math.floor(i/width);if(x)push(x-1,z);if(x+1<width)push(x+1,z);if(z)push(x,z-1);if(z+1<height)push(x,z+1);
        if(performance.now()-budget>8){await pause();budget=performance.now();if(!active())return null;}}
      for(let z=0;z<height;z++){
        for(let x=0;x<width;x++)if(!outside[z*width+x]&&!points.has(`${x+minX}:${z+minZ}`)){
          const p=this.grid.node(x+minX,z+minZ);if((p>>>16)>0&&(p&65535)===0)cells.push([x+minX,z+minZ,p]);
        }
        if(performance.now()-budget>8){await pause();budget=performance.now();if(!active())return null;}
      }
      if(!active())return null;
      const bounds={minX:minX*STEP-STEP,minZ:minZ*STEP-STEP,maxX:maxX*STEP+STEP,maxZ:maxZ*STEP+STEP};
      const summary={bounds,x:(bounds.minX+bounds.maxX)/2,z:(bounds.minZ+bounds.maxZ)/2,anchorX:start[0]*STEP,anchorZ:start[1]*STEP,samples:cells.length,revision:this.revision};
      this.paintSelection={cells,summary};return summary;
    }
    transformPaint(dx,dz,remove=false){
      if(this.stroke||!this.paintSelection||this.paintSelection.summary.revision!==this.revision)throw new Error('Select the painted island again before moving it');
      const sx=Math.round(dx/STEP),sz=Math.round(dz/STEP);if(!remove&&!sx&&!sz)return [];
      const {cells}=this.paintSelection,before=new Map(),locations=new Map();
      for(const [gx,gz]of cells)for(const [x,z]of remove?[[gx,gz]]:[[gx,gz],[gx+sx,gz+sz]]){
        if(Math.abs(x*STEP)>BOUND||Math.abs(z*STEP)>BOUND)throw new Error('Painted island would leave world bounds');
        const key=`${Math.floor(x/SIZE)}:${Math.floor(z/SIZE)}`;locations.set(key,true);
      }
      if(locations.size*SIZE*SIZE*8>MAX_BYTES)throw new Error('Move exceeds the undo memory limit');
      const newTiles=[...locations.keys()].filter(key=>!this.grid.tiles.has(key)).length;
      if(this.grid.tiles.size+newTiles+this.config.entries.reduce((n,e)=>n+(e.outline?.mask.tiles.length||0),0)>MAX_TILES)throw new Error('Combined painted map and island outline tile limit reached');
      for(const key of locations.keys()){before.set(key,this.grid.tiles.get(key)?.slice()??null);if(!this.grid.tiles.has(key))this.grid.tiles.set(key,new Uint32Array(SIZE*SIZE));}
      const put=(x,z,value)=>{const tx=Math.floor(x/SIZE),tz=Math.floor(z/SIZE);this.grid.tiles.get(`${tx}:${tz}`)[(z-tz*SIZE)*SIZE+x-tx*SIZE]=value;};
      try{
        for(const [gx,gz]of cells)put(gx,gz,0);
        if(!remove)for(const [gx,gz,value]of cells){
          const old=this.grid.node(gx+sx,gz+sz),a=(value>>>16)/65535,b=(old>>>16)/65535,coverage=a+b*(1-a);
          const v=((value&65535)/65535*a+(old&65535)/65535*b*(1-a))/coverage;
          put(gx+sx,gz+sz,((Math.round(coverage*65535)<<16)|Math.round(v*65535))>>>0);
        }
        const after=new Map();for(const key of before.keys()){
          const tile=this.grid.tiles.get(key);if(!tile.some(p=>p>>>16))this.grid.tiles.delete(key);
          after.set(key,this.grid.tiles.get(key)?.slice()??null);
        }
        this.remember({before,after,bytes:before.size*SIZE*SIZE*8});this.revision++;this.paintSelection=null;
        return [...before.keys()];
      }catch(error){this.restore(before);throw error;}
    }
    async convertPaint(active=()=>true){
      if(this.stroke||!this.paintSelection||this.paintSelection.summary.revision!==this.revision)throw new Error('Select the painted island again before converting it');
      const selection=this.paintSelection,cells=selection.cells.slice(),points=new Set(cells.map(([x,z])=>`${x}:${z}`));
      let minX=Infinity,minZ=Infinity,maxX=-Infinity,maxZ=-Infinity;
      for(const [x,z]of cells){minX=Math.min(minX,x);minZ=Math.min(minZ,z);maxX=Math.max(maxX,x);maxZ=Math.max(maxZ,z);}
      if(!active())return null;
      const cx=Math.round((minX+maxX)/2),cz=Math.round((minZ+maxZ)/2),local=new Grid();
      for(const [x,z,p]of cells){const lx=x-cx,lz=z-cz,tx=Math.floor(lx/SIZE),tz=Math.floor(lz/SIZE),key=`${tx}:${tz}`;
        if(!local.tiles.has(key))local.tiles.set(key,new Uint32Array(SIZE*SIZE));local.tiles.get(key)[(lz-tz*SIZE)*SIZE+lx-tx*SIZE]=p;}
      const rx=(Math.max(Math.abs(minX-cx),Math.abs(maxX-cx))+1)*STEP,rz=(Math.max(Math.abs(minZ-cz),Math.abs(maxZ-cz))+1)*STEP;
      const names=new Set(this.config.entries.map(entry=>entry.name));let number=1;while(names.has(`Painted Island ${number}`))number++;
      const entry={type:'outlined_island',name:`Painted Island ${number}`,x:cx*STEP,z:cz*STEP,radius_x:rx,radius_z:rz,
        rotation:0,temperature:'standard',roughness:0,shore_width:.001,outline:{radius_x:rx,radius_z:rz,mask:local.toJSON()}};
      const config={...this.config,generation_version:targetVersion(this.config),entries:[...this.config.entries,entry]};
      const tiles=new Map();for(const [x,z]of cells){const key=`${Math.floor(x/SIZE)}:${Math.floor(z/SIZE)}`;if(!tiles.has(key))tiles.set(key,this.grid.tiles.get(key).slice());}
      const metadata={...config};delete metadata.painted_map;
      const bytes=tiles.size*SIZE*SIZE*8+new TextEncoder().encode(JSON.stringify(metadata)).length*2;
      if(bytes>MAX_BYTES)throw new Error('Conversion exceeds the undo memory limit');
      const before={config:this.config,seed:this.seed,tiles},afterTiles=new Map();
      try{
        for(const [x,z]of cells){const tx=Math.floor(x/SIZE),tz=Math.floor(z/SIZE);this.grid.tiles.get(`${tx}:${tz}`)[(z-tz*SIZE)*SIZE+x-tx*SIZE]=0;}
        for(const key of tiles.keys()){
          const data=this.grid.tiles.get(key);if(!data.some(p=>p>>>16))this.grid.tiles.delete(key);afterTiles.set(key,this.grid.tiles.get(key)?.slice()??null);
        }
        config.painted_map=this.grid.toJSON();validate(config,this.seed);
        this.config=config;this.remember({kind:'compound',before,after:{config,seed:this.seed,tiles:afterTiles},bytes});this.revision++;this.paintSelection=null;
        return this.config.entries.length-1;
      }catch(error){this.config=before.config;this.restore(tiles);throw error;}
    }
    begin({radius=128,roughness=.25,tool='land'}){
      if(this.stroke)throw new Error('Finish the current stroke first');
      if(!['land','ocean'].includes(tool))throw new Error('Invalid brush');
      this.settings({radius,roughness});this.stroke={radius,roughness,target:tool==='land'?1:0,before:new Map(),coverage:new Map(),last:null,outlineTiles:this.config.entries.reduce((n,e)=>n+(e.outline?.mask.tiles.length||0),0)};
    }
    async point(x,z,onPatch=()=>{},active=()=>true){
      if(!this.stroke||!Number.isFinite(x)||!Number.isFinite(z)||Math.abs(x)>BOUND||Math.abs(z)>BOUND)throw new Error('Brush outside world bounds');
      const s=this.stroke,a=s.last||{x,z},b={x,z};s.last=b;
      const r=s.radius,reach=r*1.3,dx=b.x-a.x,dz=b.z-a.z,length2=dx*dx+dz*dz;
      const minX=Math.max(Math.ceil(-BOUND/STEP),Math.floor((Math.min(a.x,b.x)-reach)/STEP)),maxX=Math.min(Math.floor(BOUND/STEP),Math.ceil((Math.max(a.x,b.x)+reach)/STEP));
      const minZ=Math.max(Math.ceil(-BOUND/STEP),Math.floor((Math.min(a.z,b.z)-reach)/STEP)),maxZ=Math.min(Math.floor(BOUND/STEP),Math.ceil((Math.max(a.z,b.z)+reach)/STEP));
      let budget=performance.now();const dirty=new Set();
      try{
        for(let gz=minZ;gz<=maxZ;gz++){
          for(let gx=minX;gx<=maxX;gx++){
            const px=gx*STEP,pz=gz*STEP,t=length2?Math.max(0,Math.min(1,((px-a.x)*dx+(pz-a.z)*dz)/length2)):0;
            const d=Math.hypot(px-a.x-t*dx,pz-a.z-t*dz)+noise(px/Math.max(16,r*.3),pz/Math.max(16,r*.3))*r*s.roughness*.22;
            let cover=Math.max(0,Math.min(1,(r-d)/Math.max(4,r*.25)));cover=cover*cover*(3-2*cover);if(!cover)continue;
            const tx=Math.floor(gx/SIZE),tz=Math.floor(gz/SIZE),key=`${tx}:${tz}`,i=(gz-tz*SIZE)*SIZE+gx-tx*SIZE;
            if(!s.before.has(key)){
              if((s.before.size+1)*SIZE*SIZE*8>MAX_BYTES)throw new Error('Stroke too large to undo; use shorter strokes');
              if(!this.grid.tiles.has(key)&&this.grid.tiles.size+s.outlineTiles>=MAX_TILES)throw new Error('Combined painted map and island outline tile limit reached');
              s.before.set(key,this.grid.tiles.get(key)?.slice()??null);s.coverage.set(key,new Float64Array(SIZE*SIZE));
              if(!this.grid.tiles.has(key))this.grid.tiles.set(key,new Uint32Array(SIZE*SIZE));
            }
            const coverage=s.coverage.get(key);if(cover<=coverage[i])continue;coverage[i]=cover;
            const old=s.before.get(key)?.[i]??0,alpha=(old>>>16)/65535,value=(old&65535)/65535,nextAlpha=cover+alpha*(1-cover);
            const nextValue=(s.target*cover+value*alpha*(1-cover))/nextAlpha;
            this.grid.tiles.get(key)[i]=((Math.round(nextAlpha*65535)<<16)|Math.round(nextValue*65535))>>>0;dirty.add(key);
          }
          if(performance.now()-budget>8){if(dirty.size){onPatch([...dirty]);dirty.clear();}await pause();budget=performance.now();if(!active()){onPatch(this.cancel());return;}}
        }
        if(dirty.size)onPatch([...dirty]);
      }catch(error){this.cancel();onPatch([...s.before.keys()]);throw error;}
    }
    end(){
      if(!this.stroke)return false;
      const {before}=this.stroke;this.stroke=null;if(!before.size)return false;
      const after=new Map([...before].map(([key])=>[key,this.grid.tiles.get(key)?.slice()??null]));
      const bytes=before.size*SIZE*SIZE*8;
      this.remember({before,after,bytes});
      this.revision++;return true;
    }
    cancel(){if(!this.stroke)return [];const before=this.stroke.before;this.stroke=null;this.restore(before);return [...before.keys()];}
    restore(values){for(const [key,data] of values){if(data)this.grid.tiles.set(key,data.slice());else this.grid.tiles.delete(key);}}
    history(redo=false){
      if(this.stroke)throw new Error('Finish the current stroke first');
      const from=redo?this.redoStack:this.undoStack,to=redo?this.undoStack:this.redoStack,item=from.pop();if(!item)return [];
      to.push(item);this.revision++;
      this.historyBytes=this.undoStack.reduce((n,h)=>n+h.bytes,0);
      if(item.kind==='compound'){const state=redo?item.after:item.before;this.config=state.config;this.seed=state.seed;this.restore(state.tiles);this.paintSelection=null;return [...state.tiles.keys()];}
      if(item.kind==='document'){Object.assign(this,redo?item.after:item.before);return [...this.grid.tiles.keys()];}
      this.restore(redo?item.after:item.before);return [...item.before.keys()];
    }
    preset(){return {...this.config,generation_version:targetVersion(this.config),painted_map:this.grid.toJSON()};}
    project(view){return {format:'wge-map-project',version:1,name:this.config.name,seed:this.seed,config:this.preset(),editor:{...this.editor,view}};}
  }
  root.WgeEditorModel={Model,validate,MAX_BYTES,BOUND};
  if(typeof module!=='undefined')module.exports=root.WgeEditorModel;
})(globalThis);
