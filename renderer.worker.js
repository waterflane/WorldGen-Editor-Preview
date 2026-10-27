importScripts('climate-options.js',"painted-map.js", "mask-core.js", "biome-colors.js", "render-core.js");
const renderer=WgeRenderer.create();
let latest=0,pending=null,running=false;
self.onmessage=event=>{
  latest=event.data.id;renderer.cancel(latest);pending=event.data.cancelOnly?null:event.data;
  if(!running)void drain();
};
async function drain(){
  running=true;
  while(pending){
    const message=pending;pending=null;
    try{
      let preview;
      if(message.source==="biomes"&&!message.interactive){
        const coarse={...message,samplingQuality:Math.min(message.quality,32/Math.max(message.cssWidth,message.cssHeight))};
        preview=await renderer.render(coarse,()=>message.id===latest,{onProgress:frame=>{
          if(message.id===latest)self.postMessage(frame,[frame.buffer,frame.biomesBuffer,frame.heightsBuffer,frame.resolutionBuffer]);
        }});
        if(preview&&message.id===latest)self.postMessage({...preview,interactive:true});
      }
      const result=await renderer.render(message,()=>message.id===latest,{preview,onProgress:frame=>{
        if(message.id===latest)self.postMessage(frame,[frame.buffer,frame.biomesBuffer,frame.heightsBuffer,frame.resolutionBuffer]);
      }});
      if(result&&message.id===latest)self.postMessage(result,[result.buffer,...[result.biomesBuffer,result.heightsBuffer,result.resolutionBuffer].filter(Boolean)]);
    }catch(error){if(message.id===latest)self.postMessage({id:message.id,error:error.message||String(error)});}
  }
  running=false;
}
