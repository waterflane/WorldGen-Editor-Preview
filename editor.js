/* Browser composition only: brush math and project serialization live in editor.worker.js. */
(function(){
  const $=id=>document.getElementById(id),canvas=$('editorCanvas'),context=canvas.getContext('2d',{alpha:false});
  const controls=$('editorControls'),status=$('editorStatus'),hud=$('editorHud'),cursor=$('brushCursor');
  let active=false,worker=null,baseWorker=null,loaded=false,pendingLoad=false,epoch=0,baseId=0,exportId=0,revision=0,appliedRevision=0;
  let dirty=false,space=false,gesture=null,tool='land',view={x:0,z:0,blocksPerPixel:8},currentBase=null;
  let pendingView=null;
  let pendingDirty=false;
  let previewDiverged=false;
  let points=[],pointFrame=0,drawFrame=0,viewTimer=0,saveTimer=0,draftText=null,db=null;
  const exports=new Map();
  let operation=0,measurement=null,firstPaintPending=false,completePaintPending=false;
  const makeImage=tile=>{const c=document.createElement('canvas');c.width=tile.size;c.height=tile.size;c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(tile.buffer),tile.size,tile.size),0,0);return c;};
  const baseCache=WgeTileCache.create(makeImage),paintCache=WgeTileCache.create(makeImage,4096);
  function tell(text,error=false){status.textContent=text;status.classList.toggle('error',error);}
  function updateStatus(){tell(`${revision===appliedRevision?'Applied':'Unapplied changes'} · ${dirty?'unsaved project':'no unsaved changes'} · seed ${$('editorSeed').value}${previewDiverged?' · preview uses another preset; draft kept':''}${currentBase?.enabled===false?' · generation disabled in JSON':''}`);}
  function send(type,data={}){worker?.postMessage({type,...data});}
  function ensureWorkers(){
    if(worker)return;
    if(typeof Worker==='undefined')throw new Error('The editor requires a browser with Web Workers');
    worker=new Worker('editor.worker.js');baseWorker=new Worker('renderer.worker.js');
    worker.addEventListener('error',e=>tell(`Editor error: ${e.message}`,true));
    worker.addEventListener('message',({data:m})=>{
      if(m.type==='error'){
        if(m.seed!==undefined)$('editorSeed').value=m.seed;
        pendingLoad=false;epoch=m.epoch;tell(m.error,true);
        if(exports.has(m.id)){exports.get(m.id).reject(new Error(m.error));exports.delete(m.id);}return;
      }
      if(m.type==='loaded'){
        const preserve=m.preserveHistory;pendingLoad=false;loaded=true;epoch=m.epoch;currentBase=m.base;
        $('editorSeed').value=m.seed;$('brushRadius').value=m.editor.radius;$('brushRoughness').value=Math.round(m.editor.roughness*100);updateBrushLabels();
        if(!preserve){view=m.editor.view||pendingView||view;revision=0;appliedRevision=-1;dirty=pendingDirty;previewDiverged=false;}
        pendingView=null;
        baseCache.clear();paintCache.clear();renderBase();draw();return;
      }
      if(pendingLoad||m.epoch!==epoch)return;
      if(m.type==='patch'){
        paintCache.remember(m.tiles,true);
        if(measurement?.operation===m.operation&&measurement.first===null)firstPaintPending=true;
        draw();
      }
      if(m.type==='state'){
        const changed=m.revision!==revision;
        if(changed){revision=m.revision;dirty=true;}
        $('undoBrush').disabled=!m.canUndo;$('redoBrush').disabled=!m.canRedo;
        canvas.dataset.revision=String(revision);canvas.dataset.paintedTiles=String(m.tileCount);
        if(measurement?.operation===m.operation&&!measurement.done){completePaintPending=true;draw();}
        updateStatus();if(changed)scheduleSave();
      }
      if(m.type==='export'&&exports.has(m.id)){
        exports.get(m.id).resolve(m);exports.delete(m.id);
      }
    });
    baseWorker.addEventListener('message',({data:m})=>{
      if(m.id!==baseId)return;if(m.error){tell(m.error,true);return;}
      baseCache.remember(m.visualTiles);draw();
    });
    baseWorker.addEventListener('error',e=>tell(`Mask error: ${e.message}`,true));
  }
  function open(input,seed='0',nextView=view,unsaved=false){
    ensureWorkers();finishGesture(true);clearTimeout(saveTimer);pendingLoad=true;pendingView={...nextView};pendingDirty=unsaved;
    baseWorker.postMessage({id:++baseId,cancelOnly:true});send('load',{input,seed});tell('Loading project…');
  }
  function okayToReplace(){return !dirty||confirm('The current project has not been saved to a file. Replace it?');}
  function switchTab(editor){
    if(gesture)finishGesture(true);active=editor;
    controls.hidden=!editor;$('previewControls').hidden=editor;canvas.hidden=!editor;$('previewCanvas').hidden=editor;
    hud.hidden=!editor;$('previewHud').hidden=editor;$('biomeTooltip').hidden=true;cursor.hidden=true;
    $('editorTab').setAttribute('aria-pressed',String(editor));$('previewTab').setAttribute('aria-pressed',String(!editor));
    if(editor){
      WgePreview.pause();
      if(!loaded&&!pendingLoad){const current=WgePreview.snapshot();open(current.document,current.seed,current.view);}
      else{renderBase();draw();}
    }else{
      if(baseWorker)baseWorker.postMessage({id:++baseId,cancelOnly:true});
      WgePreview.resume(loaded?view:undefined);
    }
  }
  function draw(){
    if(drawFrame||!active)return;
    drawFrame=requestAnimationFrame(()=>{
      drawFrame=0;const r=canvas.getBoundingClientRect();canvas.width=Math.max(1,Math.floor(r.width));canvas.height=Math.max(1,Math.floor(r.height));
      context.fillStyle='#163f68';context.fillRect(0,0,canvas.width,canvas.height);
      baseCache.draw(context,view,canvas.width,canvas.height);paintCache.draw(context,view,canvas.width,canvas.height);
      if(measurement&&firstPaintPending){measurement.first=performance.now()-measurement.start;canvas.dataset.firstBrushFrameMs=String(Math.round(measurement.first));firstPaintPending=false;}
      if(measurement&&completePaintPending){measurement.done=true;canvas.dataset.brushCompleteMs=String(Math.round(performance.now()-measurement.start));completePaintPending=false;}
      hud.textContent=`Quick mask · x ${Math.round(view.x)}, z ${Math.round(view.z)} · 1 px = ${view.blocksPerPixel.toFixed(2)} blocks`;
    });
  }
  function renderBase(){
    if(!active||!loaded||!currentBase||gesture)return;
    const r=canvas.getBoundingClientRect(),quality=.5;
    baseWorker.postMessage({id:++baseId,source:'mask',configText:JSON.stringify(currentBase),seedText:$('editorSeed').value,
      view:{...view},width:Math.max(1,Math.floor(r.width*quality)),height:Math.max(1,Math.floor(r.height*quality)),cssWidth:Math.max(1,Math.floor(r.width)),cssHeight:Math.max(1,Math.floor(r.height)),quality,heightMode:'surface',shores:false,interactive:false});
  }
  function world(event){const r=canvas.getBoundingClientRect();return {x:Math.max(-29999984,Math.min(29999984,view.x+(event.clientX-r.left-r.width/2)*view.blocksPerPixel)),z:Math.max(-29999984,Math.min(29999984,view.z+(event.clientY-r.top-r.height/2)*view.blocksPerPixel))};}
  function showCursor(event){
    const r=canvas.getBoundingClientRect(),radius=Number($('brushRadius').value);cursor.hidden=!active||space||gesture?.pan;
    cursor.style.left=`${event.clientX-r.left}px`;cursor.style.top=`${event.clientY-r.top}px`;cursor.style.width=cursor.style.height=`${2*radius/view.blocksPerPixel}px`;
  }
  function flushPoints(){if(pointFrame){cancelAnimationFrame(pointFrame);pointFrame=0;}if(points.length){send('points',{points});points=[];}}
  function enqueuePoint(event){points.push(world(event));if(!pointFrame)pointFrame=requestAnimationFrame(()=>{pointFrame=0;flushPoints();});}
  function finishGesture(cancel=false){
    if(!gesture)return;const previous=gesture;gesture=null;
    if(previous.pan){draw();renderBase();}
    else if(cancel){points=[];if(pointFrame)cancelAnimationFrame(pointFrame);pointFrame=0;send('cancel');}
    else{flushPoints();send('end');}
    if(canvas.hasPointerCapture(previous.id))canvas.releasePointerCapture(previous.id);
  }
  canvas.addEventListener('pointerdown',event=>{
    if(!loaded||pendingLoad||gesture||![0,1].includes(event.button))return;
    event.preventDefault();clearTimeout(viewTimer);baseWorker.postMessage({id:++baseId,cancelOnly:true});
    gesture={id:event.pointerId,pan:event.button===1||space,x:event.clientX,y:event.clientY,view:{...view}};canvas.setPointerCapture(event.pointerId);
    if(!gesture.pan){
      measurement={operation:++operation,start:performance.now(),first:null,done:false};firstPaintPending=false;completePaintPending=false;
      delete canvas.dataset.firstBrushFrameMs;delete canvas.dataset.brushCompleteMs;
      send('begin',{operation,brush:{radius:Number($('brushRadius').value),roughness:Number($('brushRoughness').value)/100,tool}});enqueuePoint(event);
    }
    showCursor(event);
  });
  canvas.addEventListener('pointermove',event=>{
    showCursor(event);if(!gesture||gesture.id!==event.pointerId)return;
    if(gesture.pan){view.x=Math.max(-29999984,Math.min(29999984,gesture.view.x-(event.clientX-gesture.x)*view.blocksPerPixel));view.z=Math.max(-29999984,Math.min(29999984,gesture.view.z-(event.clientY-gesture.y)*view.blocksPerPixel));draw();}
    else enqueuePoint(event);
  });
  canvas.addEventListener('pointerup',event=>{if(gesture?.id===event.pointerId){if(!gesture.pan)enqueuePoint(event);finishGesture();}});
  canvas.addEventListener('pointercancel',()=>finishGesture(true));
  canvas.addEventListener('lostpointercapture',()=>finishGesture(true));
  canvas.addEventListener('pointerleave',()=>{cursor.hidden=true;});
  canvas.addEventListener('wheel',event=>{
    event.preventDefault();if(gesture)return;
    const before=world(event);view.blocksPerPixel=Math.max(1,Math.min(96,view.blocksPerPixel*(event.deltaY<0?.82:1.22)));
    const after=world(event);view.x=Math.max(-29999984,Math.min(29999984,view.x+before.x-after.x));view.z=Math.max(-29999984,Math.min(29999984,view.z+before.z-after.z));
    baseWorker?.postMessage({id:++baseId,cancelOnly:true});draw();showCursor(event);clearTimeout(viewTimer);viewTimer=setTimeout(renderBase,120);
  },{passive:false});
  function updateBrushLabels(){$('brushRadiusValue').textContent=$('brushRadius').value;$('brushRoughnessValue').textContent=$('brushRoughness').value+'%';}
  function saveBrushSettings(){
    updateBrushLabels();if(!loaded||pendingLoad)return;
    send('settings',{editor:{radius:Number($('brushRadius').value),roughness:Number($('brushRoughness').value)/100}});
    dirty=true;updateStatus();scheduleSave();
  }
  $('brushRadius').addEventListener('input',saveBrushSettings);$('brushRoughness').addEventListener('input',saveBrushSettings);
  function chooseTool(value){tool=value;$('landBrush').setAttribute('aria-pressed',String(tool==='land'));$('oceanBrush').setAttribute('aria-pressed',String(tool==='ocean'));}
  $('landBrush').addEventListener('click',()=>chooseTool('land'));$('oceanBrush').addEventListener('click',()=>chooseTool('ocean'));
  $('undoBrush').addEventListener('click',()=>{if(!gesture)send('undo');});$('redoBrush').addEventListener('click',()=>{if(!gesture)send('redo');});
  $('editorTab').addEventListener('click',()=>switchTab(true));$('previewTab').addEventListener('click',()=>switchTab(false));
  window.addEventListener('wge-preview-applied',event=>{
    if(!loaded||event.detail.fromEditor)return;
    if(dirty||gesture||pendingLoad){previewDiverged=true;updateStatus();}
    else open(event.detail.document,event.detail.seed,event.detail.view);
  });
  $('editorSeed').addEventListener('change',()=>{finishGesture();send('seed',{seed:$('editorSeed').value});});
  $('newMapButton').addEventListener('click',()=>{if(okayToReplace())open({enabled:true,entries:[]},$('editorSeed').value,{x:0,z:0,blocksPerPixel:4});});
  $('importPreviewButton').addEventListener('click',()=>{if(okayToReplace()){const p=WgePreview.snapshot();open(p.document,p.seed,p.view);}});
  $('projectInput').addEventListener('change',async event=>{
    const file=event.target.files[0];event.target.value='';if(!file||!okayToReplace())return;
    try{if(file.size>32*1024*1024)throw new Error('File exceeds 32 MiB');open(await file.text(),$('editorSeed').value);}catch(error){tell(error.message,true);}
  });
  function exportDocument(kind){
    if(!loaded||pendingLoad||gesture)return Promise.reject(new Error('Finish the current action and wait for the map to load'));
    return new Promise((resolve,reject)=>{const id=++exportId;exports.set(id,{resolve,reject});send('export',{id,kind,view:{...view}});});
  }
  function download(text,name){const url=URL.createObjectURL(new Blob([text],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
  $('saveProjectButton').addEventListener('click',async()=>{try{const result=await exportDocument('project');download(result.text,'island-map.wge.json');if(result.revision===revision)dirty=false;updateStatus();}catch(error){tell(error.message,true);}});
  $('exportPresetButton').addEventListener('click',async()=>{try{const result=await exportDocument('preset');download(result.text,'custom_map.json');tell(`Preset exported. Create a new WGE: Custom Map (v3) world with seed ${result.seed}.`);}catch(error){tell(error.message,true);}});
  $('applyEditorButton').addEventListener('click',async()=>{
    try{const result=await exportDocument('apply');WgePreview.applyPainted(result,view);appliedRevision=result.revision;previewDiverged=false;updateStatus();switchTab(false);}catch(error){tell(error.message,true);}
  });
  window.addEventListener('keydown',event=>{
    if(!active||/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName))return;
    if(event.code==='Space'){event.preventDefault();space=true;cursor.hidden=true;}
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();if(!gesture)send(event.shiftKey?'redo':'undo');}
    if(event.key==='Escape')finishGesture(true);
  });
  window.addEventListener('keyup',event=>{if(event.code==='Space')space=false;});
  window.addEventListener('blur',()=>{space=false;finishGesture(true);});
  window.addEventListener('resize',()=>{draw();clearTimeout(viewTimer);viewTimer=setTimeout(renderBase,120);});
  window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
  function scheduleSave(){clearTimeout(saveTimer);saveTimer=setTimeout(async()=>{
    if(!db||gesture||pendingLoad)return;
    try{const result=await exportDocument('project');const tx=db.transaction('drafts','readwrite');tx.objectStore('drafts').put(result.text,'current');
      tx.oncomplete=()=>{draftText=result.text;$('restoreDraftButton').disabled=false;};tx.onerror=()=>tell('Could not save the local draft',true);
    }catch(error){tell(error.message,true);}
  },600);}
  $('restoreDraftButton').addEventListener('click',()=>{if(draftText&&okayToReplace())open(draftText,'0',view,true);});
  try{
    const request=indexedDB.open('wge-map-editor',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('drafts');
    request.onsuccess=()=>{db=request.result;const read=db.transaction('drafts').objectStore('drafts').get('current');read.onsuccess=()=>{if(typeof read.result==='string'){draftText=read.result;$('restoreDraftButton').disabled=false;}};};
    request.onerror=()=>tell('Autosave is unavailable; save your project to a file',true);
  }catch{tell('Autosave is unavailable; save your project to a file',true);}
})();
