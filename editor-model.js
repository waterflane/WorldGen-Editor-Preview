/* Worker-owned document, sparse capsule brushes and bounded stroke history. */
(function(root){
  const {Grid,SIZE,STEP,MAX_TILES}=root.WgePaintedMap||(typeof require==='function'?require('./painted-map.js'):{});
  const mask=root.WgeMask||(typeof require==='function'?require('./mask-core.js'):{});
  const MAX_BYTES=32*1024*1024,BOUND=29999984;
  const pause=()=>new Promise(resolve=>typeof setImmediate==='function'?setImmediate(resolve):setTimeout(resolve,0));
  function noise(x,z){
    const hash=(x,z)=>{let n=Math.imul(x,374761393)^Math.imul(z,668265263);n=Math.imul(n^(n>>>13),1274126177);return ((n^(n>>>16))>>>0)/4294967295*2-1;};
    const ix=Math.floor(x),iz=Math.floor(z),u=x-ix,v=z-iz,s=u*u*(3-2*u),t=v*v*(3-2*v);
    return (hash(ix,iz)*(1-s)+hash(ix+1,iz)*s)*(1-t)+(hash(ix,iz+1)*(1-s)+hash(ix+1,iz+1)*s)*t;
  }
  function validate(input,seed='0'){
    const project=input?.format==='wge-map-project';
    if(project&&input.version!==1)throw new Error('Unsupported project version');
    const document=mask.readDocument(project?{config:input.config,generation_version:3}:input);
    const config=structuredClone(document.config);
    config.enabled??=true;
    config.painted_map??={version:1,step:4,size:64,tiles:[]};
    const resolved=mask.parseSeed(project?input.seed:seed);
    if(resolved===null)throw new Error('Project requires a concrete seed');
    mask.parseConfig(config,resolved);
    const editor=project?input.editor||{}:{};
    const radius=Number(editor.radius??128),roughness=Number(editor.roughness??.25),view=editor.view;
    if(!Number.isFinite(radius)||radius<8||radius>2048||!Number.isFinite(roughness)||roughness<0||roughness>1)throw new Error('Invalid brush settings');
    if(view&&(![view.x,view.z,view.blocksPerPixel].every(Number.isFinite)||Math.abs(view.x)>BOUND||Math.abs(view.z)>BOUND||view.blocksPerPixel<1||view.blocksPerPixel>96))throw new Error('Invalid project view');
    return {config,seed:resolved.toString(),editor:{radius,roughness,...(view?{view:{...view}}:{})}};
  }
  class Model {
    constructor(input,seed='0'){
      const parsed=validate(input,seed);Object.assign(this,parsed);
      this.grid=new Grid(this.config.painted_map);this.undoStack=[];this.redoStack=[];this.historyBytes=0;this.stroke=null;this.revision=0;
    }
    begin({radius=128,roughness=.25,tool='land'}){
      if(this.stroke)throw new Error('Finish the current stroke first');
      if(!Number.isFinite(radius)||radius<8||radius>2048||!Number.isFinite(roughness)||roughness<0||roughness>1||!['land','ocean'].includes(tool))throw new Error('Invalid brush');
      this.editor={...this.editor,radius,roughness};this.stroke={radius,roughness,target:tool==='land'?1:0,before:new Map(),coverage:new Map(),last:null};
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
              if(!this.grid.tiles.has(key)&&this.grid.tiles.size>=MAX_TILES)throw new Error('Painted map tile limit reached');
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
      this.redoStack=[];this.undoStack.push({before,after,bytes});
      this.historyBytes=this.undoStack.reduce((n,h)=>n+h.bytes,0);
      while(this.undoStack.length>100||this.historyBytes>MAX_BYTES){this.historyBytes-=this.undoStack.shift().bytes;}
      this.revision++;return true;
    }
    cancel(){if(!this.stroke)return [];const before=this.stroke.before;this.stroke=null;this.restore(before);return [...before.keys()];}
    restore(values){for(const [key,data] of values){if(data)this.grid.tiles.set(key,data.slice());else this.grid.tiles.delete(key);}}
    history(redo=false){
      if(this.stroke)throw new Error('Finish the current stroke first');
      const from=redo?this.redoStack:this.undoStack,to=redo?this.undoStack:this.redoStack,item=from.pop();if(!item)return [];
      this.restore(redo?item.after:item.before);to.push(item);this.revision++;return [...item.before.keys()];
    }
    preset(){return {...this.config,generation_version:3,painted_map:this.grid.toJSON()};}
    project(view){return {format:'wge-map-project',version:1,seed:this.seed,config:this.preset(),editor:{...this.editor,view}};}
  }
  root.WgeEditorModel={Model,validate,MAX_BYTES,BOUND};
  if(typeof module!=='undefined')module.exports=root.WgeEditorModel;
})(globalThis);
