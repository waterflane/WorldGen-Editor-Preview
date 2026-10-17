importScripts("mask-core.js", "render-core.js");
const renderer=WgeRenderer.create();
let latest=0,pending=null,running=false;
self.onmessage=event=>{
  latest=event.data.id;renderer.cancel(latest);pending=event.data;
  if(!running)void drain();
};
async function drain(){
  running=true;
  while(pending){
    const message=pending;pending=null;
    try{
      let preview;
      if(message.source==="biomes"&&!message.interactive){
        const quality=Math.min(message.quality,32/Math.max(message.cssWidth,message.cssHeight));
        const coarse={...message,quality,width:Math.max(1,Math.floor(message.cssWidth*quality)),height:Math.max(1,Math.floor(message.cssHeight*quality))};
        preview=await renderer.render(coarse,()=>message.id===latest);
        if(preview&&message.id===latest)self.postMessage({...preview,interactive:true});
      }
      const result=await renderer.render(message,()=>message.id===latest,{preview,onProgress:frame=>{
        if(message.id===latest)self.postMessage(frame,[frame.buffer,frame.biomesBuffer,frame.heightsBuffer]);
      }});
      if(result&&message.id===latest)self.postMessage(result,[result.buffer,...[result.biomesBuffer,result.heightsBuffer].filter(Boolean)]);
    }catch(error){if(message.id===latest)self.postMessage({id:message.id,error:error.message||String(error)});}
  }
  running=false;
}
