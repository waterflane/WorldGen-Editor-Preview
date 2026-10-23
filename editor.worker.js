importScripts('painted-map.js','mask-core.js','editor-model.js','document-format.js');
let model=null,compiled=null,epoch=0,queue=[],running=false,operation=0;
self.onmessage=event=>{
  const message=event.data;
  if(message.type==='load'||message.type==='cancel')epoch++;
  queue.push({...message,epoch});if(!running)void drain();
};
function patch(keys){
  const tiles=[];
  for(const key of keys){
    const data=model.grid.tiles.get(key),[tx,tz]=key.split(':').map(Number),buffer=new Uint8ClampedArray(64*64*4);
    if(data)for(let i=0;i<data.length;i++){
      const p=data[i],alpha=p>>>16;if(!alpha)continue;
      const x=(tx*64+i%64)*4,z=(tz*64+Math.floor(i/64))*4;
      const base=alpha===65535?0:WgeMask.sampleMask(model.config,compiled,x,z);
      const value=base+((p&65535)/65535-base)*alpha/65535;
      const color=value<.08?[22,63,104]:value<.30?[38,118,166]:value<.50?[62,139,174]:value<.58?[216,202,142]:value<.82?[115,167,96]:[71,123,79];
      buffer.set(color,i*4);buffer[i*4+3]=255;
    }
    tiles.push({x:tx*256,z:tz*256,step:4,size:64,buffer:buffer.buffer});
  }
  if(tiles.length)self.postMessage({type:'patch',epoch,operation,tiles},tiles.map(t=>t.buffer));
}
function state(){self.postMessage({type:'state',epoch,operation,revision:model.revision,canUndo:!!model.undoStack.length,canRedo:!!model.redoStack.length,tileCount:model.grid.tiles.size});}
async function drain(){
  running=true;
  while(queue.length){const message=queue.shift();
    try{
      if(message.epoch!==epoch){if(message.type==='export')self.postMessage({type:'error',id:message.id,epoch,error:'Export cancelled by a newer action'});continue;}
      if(message.type==='load'){
        if(typeof message.input==='string'&&new TextEncoder().encode(message.input).length>WgeEditorModel.MAX_BYTES)throw new Error('Project exceeds 32 MiB');
        const next=new WgeEditorModel.Model(typeof message.input==='string'?JSON.parse(message.input):message.input,message.seed);
        const base={...next.config,painted_map:{version:1,step:4,size:64,tiles:[]}};
        const prepared=WgeMask.parseConfig(base,BigInt(next.seed));
        model=next;compiled=prepared;operation=0;
        self.postMessage({type:'loaded',epoch,seed:model.seed,editor:model.editor,base});
        const keys=[...model.grid.tiles.keys()];
        for(let i=0;i<keys.length;i+=4){patch(keys.slice(i,i+4));await new Promise(resolve=>setTimeout(resolve,0));if(message.epoch!==epoch)break;}
        state();
      }else if(!model)throw new Error('Open a map first');
      else if(message.type==='seed'){
        if(model.stroke)throw new Error('Finish the stroke before changing the seed');
        const seed=WgeMask.parseSeed(message.seed);if(seed===null)throw new Error('Введите сид мира');
        const base={...model.config,painted_map:{version:1,step:4,size:64,tiles:[]}};
        const next=WgeMask.parseConfig(base,seed);model.seed=seed.toString();compiled=next;model.revision++;
        self.postMessage({type:'loaded',epoch,seed:model.seed,editor:model.editor,base,preserveHistory:true});
        for(const key of model.grid.tiles.keys()){patch([key]);await new Promise(resolve=>setTimeout(resolve,0));if(message.epoch!==epoch)break;}state();
      }
      else if(message.type==='begin'){operation=message.operation||0;model.begin(message.brush);}
      else if(message.type==='points'){for(const point of message.points){if(message.epoch!==epoch)break;await model.point(point.x,point.z,patch,()=>message.epoch===epoch);}}
      else if(message.type==='end'){model.end();state();}
      else if(message.type==='cancel'){patch(model.cancel());state();}
      else if(message.type==='undo'||message.type==='redo'){patch(model.history(message.type==='redo'));state();}
      else if(message.type==='export'){
        if(model.stroke)throw new Error('Finish the stroke before exporting');
        if(message.kind==='apply'){
          self.postMessage({type:'export',id:message.id,epoch,kind:'apply',...WgeDocument.split(model.preset()),seed:model.seed,revision:model.revision});continue;
        }
        const value=message.kind==='project'?model.project(message.view):model.preset(),text=JSON.stringify(value);
        if(new TextEncoder().encode(text).length>WgeEditorModel.MAX_BYTES)throw new Error('Export exceeds the 32 MiB limit');
        self.postMessage({type:'export',id:message.id,epoch,kind:message.kind,text,seed:model.seed,revision:model.revision});
      }
    }catch(error){if(model?.stroke)patch(model.cancel());self.postMessage({type:'error',id:message.id,epoch,error:error.message,seed:model?.seed});}
  }
  running=false;
}
