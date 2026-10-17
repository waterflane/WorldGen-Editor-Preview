/* Bounded world-space tile cache and cooperative cancellation, shared with the no-worker fallback. */
(function(root){
  const wait=()=>new Promise(resolve=>{
    if(typeof setImmediate==="function")setImmediate(resolve);
    else if(root.scheduler?.yield)root.scheduler.yield().then(resolve);
    else setTimeout(resolve,0);
  });
  function sampleStep(message){
    const java=message.source==="biomes";
    const budget=message.interactive?32:message.quality>=.99?Infinity:message.quality>=.60?256:128;
    const overviewLimit=java?Math.max(message.cssWidth,message.cssHeight)*message.view.blocksPerPixel/budget:0;
    const ratio=Math.max(message.view.blocksPerPixel/message.quality,overviewLimit);
    return 2**Math.max(0,java?Math.ceil(Math.log2(ratio)):Math.floor(Math.log2(ratio)));
  }
  function create(){
    let key="",config,compiled,session=null,generationVersion=2;
    const client=typeof crypto!=="undefined"&&crypto.randomUUID?crypto.randomUUID():String(Math.random());
    let controller=null;
    const tiles=new Map();

    function remember(id,tile){tiles.delete(id);tiles.set(id,tile);while(tiles.size>8192)tiles.delete(tiles.keys().next().value);return tile;}
    async function post(path,body,active){
      if(!active())return null;
      const requestController=new AbortController();controller=requestController;
      let response;
      try { response=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),signal:requestController.signal}); }
      catch(error){if(error.name==="AbortError")throw error;throw new Error("Java preview unavailable; start the local process and apply again");}
      if(controller===requestController)controller=null;
      const result=await response.json();
      if(!active()||result.cancelled)return null;
      if(!response.ok){if(String(result.error).startsWith("Session expired"))session=null;throw new Error(result.error||"Java preview request failed");}return result;
    }
    async function render(message,active,{preview,onProgress}={}){
      const started=performance.now();
      const nextKey=message.seedText+"\n"+message.configText;
      if(nextKey!==key){
        const document=WgeMask.readDocument(JSON.parse(message.configText)),parsed=document.config,next=WgeMask.parseConfig(parsed,WgeMask.parseSeed(message.seedText));
        config=parsed;compiled=next;generationVersion=document.generationVersion;key=nextKey;session=null;tiles.clear();
      }
      const java=message.source==="biomes";
      const size=java?8:16;
      if(java&&!message.backendAvailable)throw new Error(message.backendError||"Start the local Java preview and open its URL to view biomes");
      if(java&&!session){session=await post("/api/session",{seed:message.seedText,config,generation_version:generationVersion,client},active);if(!session)return null;}
      const step=sampleStep(message);
      const data=new Uint8ClampedArray(message.width*message.height*4);
      const palette=[],paletteIndices=new Map();
      const biomePixels=java?new Uint16Array(message.width*message.height):null;
      const heightPixels=java?new Int16Array(message.width*message.height):null;
      if(java&&preview){
        const pixels=new Uint8ClampedArray(preview.buffer),ids=new Uint16Array(preview.biomesBuffer),ys=new Int16Array(preview.heightsBuffer);
        for(const id of preview.palette){paletteIndices.set(id,palette.length);palette.push(id);}
        let seedBudget=performance.now();
        for(let row=0;row<message.height;row++){
          for(let col=0;col<message.width;col++){
            const i=row*message.width+col,j=Math.min(preview.height-1,Math.floor(row*preview.height/message.height))*preview.width+Math.min(preview.width-1,Math.floor(col*preview.width/message.width));
            for(let k=0;k<4;k++)data[i*4+k]=pixels[j*4+k];biomePixels[i]=ids[j];heightPixels[i]=ys[j];
          }
          if(performance.now()-seedBudget>8){await wait();seedBudget=performance.now();}if(!active())return null;
        }
      }
      const inactive=config.enabled===false||config.entries.length===0;
      const local=new Map();
      async function tileAt(tx,tz){
        const id=(java?session.session:"mask")+":"+message.heightMode+":"+step+":"+tx+":"+tz;
        if(local.has(id))return local.get(id);
        let tile=tiles.get(id);
        if(tile){tiles.delete(id);tiles.set(id,tile);local.set(id,tile);return tile;}
        const x=tx*size*step,z=tz*size*step;
        if(java){
          tile=await post("/api/tile",{session:session.session,client,request:(session.request_base||0)+message.id,x,z,step,size,height_mode:message.heightMode==="surface"?"surface":"slice",y:Number(message.heightMode)||0},active);
          if(!tile)return null;
        }else{
          tile={values:new Float64Array(size*size)};
          let budget=performance.now();
          for(let row=0;row<size;row++){
            for(let col=0;col<size;col++)tile.values[row*size+col]=WgeMask.sampleMask(config,compiled,x+col*step,z+row*step);
            if(performance.now()-budget>8){await wait();budget=performance.now();}if(!active())return null;
          }
        }
        remember(id,tile);local.set(id,tile);return tile;
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
      for(const [tx,tz] of visible){
        const tile=await tileAt(tx,tz);if(!tile)return null;
        const col0=Math.max(0,Math.floor((tx*extent-left)/worldPerPixel)-1),col1=Math.min(message.width,Math.ceil(((tx+1)*extent-left)/worldPerPixel)+1);
        const row0=Math.max(0,Math.floor((tz*extent-top)/worldPerPixel)-1),row1=Math.min(message.height,Math.ceil(((tz+1)*extent-top)/worldPerPixel)+1);
        for(let row=row0;row<row1;row++){
          const z=message.view.z+(row/message.quality-message.cssHeight/2)*message.view.blocksPerPixel;
          for(let col=col0;col<col1;col++){
            const x=message.view.x+(col/message.quality-message.cssWidth/2)*message.view.blocksPerPixel;
            const gx=Math.floor(x/step),gz=Math.floor(z/step);
            if(Math.floor(gx/size)!==tx||Math.floor(gz/size)!==tz)continue;
            const i=(gz-tz*size)*size+gx-tx*size;
            let color;
            if(java){
              const biome=tile.palette[tile.biomes[i]];
              let index=paletteIndices.get(biome);
              if(index===undefined){index=palette.length;palette.push(biome);paletteIndices.set(biome,index);}
              biomePixels[row*message.width+col]=index;heightPixels[row*message.width+col]=tile.heights[i];
              color=biomeColor(biome);
              if(message.relief&&message.heightMode==="surface"){
                const h=tile.heights[i],left=tile.heights[i%size>0?i-1:i],up=tile.heights[i>=size?i-size:i];
                const shade=Math.max(.60,Math.min(1.25,1+(left+up-2*h)/Math.max(step,4)*.07));color=color.map(v=>Math.min(255,Math.round(v*shade)));
              }
            }else{
              const value=tile.values[i];color=inactive?[48,53,60]:maskColor(value);
              if(!inactive&&message.shores&&(Math.abs(value-.50)<.012||Math.abs(value-.58)<.012))color=color.map(v=>Math.round(v*.55+240*.45));
            }
            const offset=(row*message.width+col)*4;data[offset]=color[0];data[offset+1]=color[1];data[offset+2]=color[2];data[offset+3]=255;
          }
          if(performance.now()-renderBudget>8){await wait();renderBudget=performance.now();}if(!active())return null;
        }
        if(java&&preview&&onProgress&&performance.now()-lastProgress>=250){
          onProgress({...message,interactive:true,elapsedMs:Math.round(performance.now()-started),
            buffer:data.slice().buffer,biomesBuffer:biomePixels.slice().buffer,heightsBuffer:heightPixels.slice().buffer,
            palette:[...palette],sampleStep:preview.sampleStep,targetStep:step,generationVersion,exact:true});
          lastProgress=performance.now();
        }
      }
      if(java&&preview){
        const used=new Set(biomePixels),remap=new Uint16Array(palette.length),finalPalette=[];
        for(const old of used){remap[old]=finalPalette.length;finalPalette.push(palette[old]);}
        for(let i=0;i<biomePixels.length;i++)biomePixels[i]=remap[biomePixels[i]];
        palette.length=0;palette.push(...finalPalette);
      }
      return {...message,elapsedMs:Math.round(performance.now()-started),buffer:data.buffer,biomesBuffer:biomePixels?.buffer,heightsBuffer:heightPixels?.buffer,palette,sampleStep:step,generationVersion,exact:true};
    }
    function cancel(nextId){
      controller?.abort();controller=null;
      if(session)void fetch("/api/cancel",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({session:session.session,client,request:(session.request_base||0)+nextId})}).catch(()=>{});
    }
    return {render,cancel,cacheSize:()=>tiles.size};
  }
  function maskColor(v){return v<.08?[22,63,104]:v<.30?[38,118,166]:v<.50?[62,139,174]:v<.58?[216,202,142]:v<.82?[115,167,96]:[71,123,79];}
  function biomeColor(id){
    if(id.includes("river"))return id.includes("frozen")?[135,193,211]:[53,133,194];
    if(id.includes("ocean"))return id.includes("deep")?[22,63,104]:id.includes("frozen")?[139,192,210]:[38,118,166];
    if(id.includes("beach")||id.includes("shore"))return [216,202,142];
    if(/snow|frozen|ice|grove/.test(id))return [220,232,226];
    if(/desert|badlands/.test(id))return id.includes("badlands")?[182,108,64]:[220,200,134];
    if(/jungle/.test(id))return [48,125,67];if(/swamp/.test(id))return [78,112,83];
    if(/forest|taiga/.test(id))return [64,119,73];if(/peak|mountain|slope/.test(id))return [145,153,143];
    if(/cave|dark/.test(id))return [95,91,119];if(/savanna/.test(id))return [164,174,87];
    return [116,165,95];
  }
  root.WgeRenderer={create,biomeColor,sampleStep};
  if(typeof module!=="undefined")module.exports=root.WgeRenderer;
})(globalThis);
