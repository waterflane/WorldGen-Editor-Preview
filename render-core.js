/* Bounded world-space tile cache and cooperative cancellation, shared with the no-worker fallback. */
(function(root){
  const {biomeColor}=root.WgeBiomeColors||(typeof require==="function"?require("./biome-colors.js"):{});
  const wait=()=>new Promise(resolve=>{
    if(typeof setImmediate==="function")setImmediate(resolve);
    else if(root.scheduler?.yield)root.scheduler.yield().then(resolve);
    else setTimeout(resolve,0);
  });
  function sampleStep(message){
    const java=message.source==="biomes";
    const density=message.samplingQuality??message.quality;
    const budget=message.interactive?32:density>=.99?Infinity:density>=.60?256:128;
    const overviewLimit=java?Math.max(message.cssWidth,message.cssHeight)*message.view.blocksPerPixel/budget:0;
    const ratio=Math.max(message.view.blocksPerPixel/density,overviewLimit);
    return 2**Math.max(0,java?Math.ceil(Math.log2(ratio)):Math.floor(Math.log2(ratio)));
  }
  function create(){
    let key="",config,compiled,session=null,generationVersion=2;
    const client=typeof crypto!=="undefined"&&crypto.randomUUID?crypto.randomUUID():String(Math.random());
    const controllers=new Set(),tiles=new Map(),levels=new Set();

    function remember(id,tile,cache){tile.cache=cache;levels.add(cache.step);tiles.delete(id);tiles.set(id,tile);while(tiles.size>8192)tiles.delete(tiles.keys().next().value);return tile;}
    async function post(path,body,active){
      if(!active())return null;
      const requestController=new AbortController();controllers.add(requestController);
      let response;
      try { response=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),signal:requestController.signal}); }
      catch(error){if(error.name==="AbortError")throw error;throw new Error("Java preview unavailable; start the local process and apply again");}
      finally {controllers.delete(requestController);}
      const result=await response.json();
      if(!active()||result.cancelled)return null;
      if(!response.ok){if(String(result.error).startsWith("Session expired"))session=null;throw new Error(result.error||"Java preview request failed");}return result;
    }
    async function render(message,active,{preview,onProgress}={}){
      const started=performance.now();
      const nextKey="coast3\n"+message.seedText+"\n"+message.configText;
      if(nextKey!==key){
        const document=WgeMask.readDocument(JSON.parse(message.configText)),parsed=document.config,next=WgeMask.parseConfig(parsed,WgeMask.parseSeed(message.seedText));
        config=parsed;compiled=next;generationVersion=document.generationVersion;key=nextKey;session=null;tiles.clear();levels.clear();
      }
      const java=message.source==="biomes";
      // A 16x16 sample tile amortizes HTTP/composition while remaining cancellable per sample.
      const size=16;
      if(java&&!message.backendAvailable)throw new Error(message.backendError||"Start the local Java preview and open its URL to view biomes");
      if(java&&!session){session=await post("/api/session",{seed:message.seedText,config,generation_version:generationVersion,coast_revision:3,client},active);if(!session)return null;}
      const step=sampleStep(message);
      const includeHeights=!!message.relief&&message.heightMode==="surface";
      const group=(java?session.session:"mask")+":"+message.heightMode+(java&&includeHeights?":heights":"");
      const tileId=(level,tx,tz)=>group+":"+level+":"+tx+":"+tz;
      const data=new Uint8ClampedArray(message.width*message.height*4);
      const resolutions=new Uint32Array(message.width*message.height);resolutions.fill(0xffffffff);
      const palette=[],paletteIndices=new Map();
      const biomePixels=java?new Uint16Array(message.width*message.height):null;
      const heightPixels=java?new Int16Array(message.width*message.height):null;
      if(java){
        // Unfinished coarse tiles must stay neutral, including their hover data.
        biomePixels.fill(65535);
        const neutral=Uint8Array.of(48,53,60,255);
        new Uint32Array(data.buffer).fill(new Uint32Array(neutral.buffer)[0]);
      }
      if(java&&preview){
        const pixels=new Uint8ClampedArray(preview.buffer),ids=new Uint16Array(preview.biomesBuffer),ys=new Int16Array(preview.heightsBuffer);
        const previousResolutions=preview.resolutionBuffer?new Uint32Array(preview.resolutionBuffer):null;
        for(const id of preview.palette){paletteIndices.set(id,palette.length);palette.push(id);}
        if(preview.width===message.width&&preview.height===message.height){
          data.set(pixels);biomePixels.set(ids);heightPixels.set(ys);
          if(previousResolutions)resolutions.set(previousResolutions);else resolutions.fill(preview.sampleStep);
        }else{
          let seedBudget=performance.now();
          for(let row=0;row<message.height;row++){
            for(let col=0;col<message.width;col++){
              const i=row*message.width+col,j=Math.min(preview.height-1,Math.floor(row*preview.height/message.height))*preview.width+Math.min(preview.width-1,Math.floor(col*preview.width/message.width));
              for(let k=0;k<4;k++)data[i*4+k]=pixels[j*4+k];biomePixels[i]=ids[j];heightPixels[i]=ys[j];
              resolutions[i]=previousResolutions?previousResolutions[j]:preview.sampleStep;
            }
            if(performance.now()-seedBudget>8){await wait();seedBudget=performance.now();}if(!active())return null;
          }
        }
      }
      const inactive=config.enabled===false||(config.entries.length===0&&!config.painted_map);
      const local=new Map();
      const finerLevels=[...levels].filter(level=>level<step).sort((a,b)=>a-b);
      function fromFinerCache(x,z){
        if(!finerLevels.length)return null;
        const tile=java?{palette:[],biomes:[],heights:[]}:{values:new Float64Array(size*size),zones:new Uint8Array(size*size)};
        for(let row=0;row<size;row++)for(let col=0;col<size;col++){
          const bx=x+col*step,bz=z+row*step,i=row*size+col;let found=false;
          for(const level of finerLevels){
            const tx=Math.floor(bx/(size*level)),tz=Math.floor(bz/(size*level));
            const id=tileId(level,tx,tz),cached=tiles.get(id);if(!cached)continue;
            tiles.delete(id);tiles.set(id,cached);
            const j=(bz/level-tz*size)*size+bx/level-tx*size;
            if(java){const id=cached.palette[cached.biomes[j]];let index=tile.palette.indexOf(id);
              if(index<0){index=tile.palette.length;tile.palette.push(id);}tile.biomes[i]=index;tile.heights[i]=cached.heights[j];
            }else {tile.values[i]=cached.values[j];tile.zones[i]=cached.zones?.[j]||0;}
            found=true;break;
          }
          if(!found)return null;
        }
        return tile;
      }
      async function tileAt(tx,tz){
        const id=tileId(step,tx,tz);
        if(local.has(id))return local.get(id);
        let tile=tiles.get(id);
        if(tile){tiles.delete(id);tiles.set(id,tile);local.set(id,tile);return tile;}
        const x=tx*size*step,z=tz*size*step;
        tile=fromFinerCache(x,z);
        if(!tile&&java){
          tile=await post("/api/tile",{session:session.session,client,request:(session.request_base||0)+message.id,x,z,step,size,height_mode:message.heightMode==="surface"?"surface":"slice",y:Number(message.heightMode)||0,include_heights:includeHeights},active);
          if(!tile)return null;
        }else if(!tile){
          tile={values:new Float64Array(size*size),zones:new Uint8Array(size*size)};
          let budget=performance.now();
          for(let row=0;row<size;row++){
            for(let col=0;col<size;col++){const details={},i=row*size+col;const value=await WgeMask.sampleMaskAsync(config,compiled,x+col*step,z+row*step,details,active,wait);if(value===null)return null;tile.values[i]=value;tile.zones[i]=details.zone||0;}
            if(performance.now()-budget>8){await wait();budget=performance.now();}if(!active())return null;
          }
        }
        remember(id,tile,{group,x,z,step,size});local.set(id,tile);return tile;
      }
      // Compose one completed tile at a time, so fine detail can replace the coarse map immediately.
      const left=message.view.x-message.cssWidth/2*message.view.blocksPerPixel;
      const top=message.view.z-message.cssHeight/2*message.view.blocksPerPixel;
      const worldPerPixel=message.view.blocksPerPixel/message.quality,extent=size*step;
      const tx0=Math.floor(left/extent),tz0=Math.floor(top/extent);
      const right=message.view.x+((message.width-1)/message.quality-message.cssWidth/2)*message.view.blocksPerPixel;
      const bottom=message.view.z+((message.height-1)/message.quality-message.cssHeight/2)*message.view.blocksPerPixel;
      const tx1=Math.floor(right/extent),tz1=Math.floor(bottom/extent);
      const visible=[];
      for(let tz=tz0;tz<=tz1;tz++)for(let tx=tx0;tx<=tx1;tx++)visible.push([tx,tz]);
      const cx=(tx0+tx1)/2,cz=(tz0+tz1)/2;
      visible.sort((a,b)=>(a[0]-cx)**2+(a[1]-cz)**2-(b[0]-cx)**2-(b[1]-cz)**2);
      let renderBudget=performance.now(),lastProgress=renderBudget;
      const emitted=new Set(),visualTiles=[];
      function colorAt(tile,i){
        if(!java){
          const value=tile.values[i];let color=inactive?[48,53,60]:({1:[22,63,104],2:[38,118,166],3:[216,202,142],4:maskColor(Math.max(.58,value))}[tile.zones?.[i]]||maskColor(value));
          if(!inactive&&message.shores&&(Math.abs(value-.50)<.012||Math.abs(value-.58)<.012))color=color.map(v=>Math.round(v*.55+240*.45));
          return color;
        }
        let color=biomeColor(tile.palette[tile.biomes[i]]);
        if(includeHeights){
          const h=tile.heights[i],left=tile.heights[i%size>0?i-1:i],up=tile.heights[i>=size?i-size:i];
          const shade=Math.max(.60,Math.min(1.25,1+(left+up-2*h)/Math.max(tile.cache.step,4)*.07));
          color=color.map(v=>Math.min(255,Math.round(v*shade)));
        }
        return color;
      }
      async function paint(tile){
        const cached=tile.cache,level=cached.step,span=cached.size*level;
        if(!emitted.has(tile)){
          emitted.add(tile);
          const pixels=new Uint8ClampedArray(size*size*4);
          for(let i=0;i<size*size;i++){pixels.set(colorAt(tile,i),i*4);pixels[i*4+3]=255;}
          visualTiles.push({x:cached.x,z:cached.z,step:level,size,buffer:pixels.buffer});
        }
        const tx=Math.floor(cached.x/span),tz=Math.floor(cached.z/span);
        const col0=Math.max(0,Math.floor((cached.x-left)/worldPerPixel)-1),col1=Math.min(message.width,Math.ceil((cached.x+span-left)/worldPerPixel)+1);
        const row0=Math.max(0,Math.floor((cached.z-top)/worldPerPixel)-1),row1=Math.min(message.height,Math.ceil((cached.z+span-top)/worldPerPixel)+1);
        for(let row=row0;row<row1;row++){
          const z=message.view.z+(row/message.quality-message.cssHeight/2)*message.view.blocksPerPixel;
          for(let col=col0;col<col1;col++){
            const x=message.view.x+(col/message.quality-message.cssWidth/2)*message.view.blocksPerPixel;
            const pixel=row*message.width+col;
            if(resolutions[pixel]<level)continue;
            const gx=Math.floor(x/level),gz=Math.floor(z/level);
            if(Math.floor(gx/size)!==tx||Math.floor(gz/size)!==tz)continue;
            const i=(gz-tz*size)*size+gx-tx*size;
            const color=colorAt(tile,i);
            if(java){
              const biome=tile.palette[tile.biomes[i]];
              let index=paletteIndices.get(biome);
              if(index===undefined){index=palette.length;palette.push(biome);paletteIndices.set(biome,index);}
              biomePixels[row*message.width+col]=index;heightPixels[row*message.width+col]=tile.heights[i];
            }
            const offset=(row*message.width+col)*4;data[offset]=color[0];data[offset+1]=color[1];data[offset+2]=color[2];data[offset+3]=255;
            resolutions[pixel]=level;
          }
          if(performance.now()-renderBudget>8){await wait();renderBudget=performance.now();}if(!active())return false;
        }
        return true;
      }
      // World-space cached detail survives changes of zoom and is never replaced by a coarser tile.
      const retained=[...tiles.values()].filter(tile=>{
        const c=tile.cache,span=c.step*c.size;
        return c.group===group&&c.x<=right&&c.x+span>left&&c.z<=bottom&&c.z+span>top;
      }).sort((a,b)=>b.cache.step-a.cache.step);
      for(const tile of retained){
        if(!await paint(tile))return null;
        const c=tile.cache,id=tileId(c.step,Math.floor(c.x/(size*c.step)),Math.floor(c.z/(size*c.step)));
        tiles.delete(id);tiles.set(id,tile);
      }
      const jobs=new Map(),parallel=java?Math.max(1,Math.min(6,Number.isInteger(session.workers)?session.workers:4)):1;
      const schedule=index=>{
        if(index>=visible.length||jobs.has(index))return;
        jobs.set(index,tileAt(...visible[index]).then(tile=>({tile}),error=>({error})));
      };
      for(let i=0;i<parallel;i++)schedule(i);
      for(let i=0;i<visible.length;i++){
        const {tile,error}=await jobs.get(i);jobs.delete(i);
        if(!active())return null;if(error)throw error;if(!tile)return null;
        schedule(i+parallel);
        if(!await paint(tile))return null;
        if(java&&onProgress&&(i===0||performance.now()-lastProgress>=125)){
          onProgress({...message,interactive:true,partial:true,elapsedMs:Math.round(performance.now()-started),
            visualTiles:visualTiles.splice(0),
            buffer:data.slice().buffer,biomesBuffer:biomePixels.slice().buffer,heightsBuffer:heightPixels.slice().buffer,
            palette:[...palette],resolutionBuffer:resolutions.slice().buffer,sampleStep:preview?.sampleStep??step,targetStep:step,generationVersion,exact:true});
          lastProgress=performance.now();
        }
      }
      if(java&&preview){
        const used=new Set(biomePixels),remap=new Uint16Array(palette.length),finalPalette=[];
        for(const old of used){remap[old]=finalPalette.length;finalPalette.push(palette[old]);}
        for(let i=0;i<biomePixels.length;i++)biomePixels[i]=remap[biomePixels[i]];
        palette.length=0;palette.push(...finalPalette);
      }
      return {...message,visualTiles,elapsedMs:Math.round(performance.now()-started),buffer:data.buffer,biomesBuffer:biomePixels?.buffer,heightsBuffer:heightPixels?.buffer,resolutionBuffer:java?resolutions.buffer:undefined,palette,sampleStep:step,generationVersion,exact:true};
    }
    function cancel(nextId){
      for(const controller of controllers)controller.abort();controllers.clear();
      if(session)void fetch("/api/cancel",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({session:session.session,client,request:(session.request_base||0)+nextId})}).catch(()=>{});
    }
    return {render,cancel,cacheSize:()=>tiles.size};
  }
  function maskColor(v){return v<.08?[22,63,104]:v<.30?[38,118,166]:v<.50?[62,139,174]:v<.58?[216,202,142]:v<.82?[115,167,96]:[71,123,79];}
  root.WgeRenderer={create,biomeColor,sampleStep};
  if(typeof module!=="undefined")module.exports=root.WgeRenderer;
})(globalThis);
