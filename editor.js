/* Browser composition only: brush math and project serialization live in editor.worker.js. */
(function(){
  const $=id=>document.getElementById(id),canvas=$('editorCanvas'),context=canvas.getContext('2d',{alpha:false});
  const controls=$('editorControls'),status=$('editorStatus'),hud=$('editorHud'),cursor=$('brushCursor');
  let active=false,worker=null,baseWorker=null,loaded=false,pendingLoad=false,epoch=0,baseId=0,exportId=0,revision=0,appliedRevision=0;
  let dirty=false,space=false,gesture=null,tool='select',view={x:0,z:0,blocksPerPixel:8},currentBase=null,selected=-1;
  let initialFrame=true,sourcePending=false,paintedBounds=null,paintSelection=null,paintPick=0,pickContext=null,pickRelease=null,applying=false,converting=false;
  let pendingView=null;
  let pendingDirty=false;
  let previewDiverged=false;
  let inspectorDirty=false,inspectorEntry=null,enterSubmission=false;
  let points=[],pointFrame=0,drawFrame=0,viewTimer=0,saveTimer=0,draftText=null,db=null;
  const exports=new Map();
  let operation=0,measurement=null,firstPaintPending=false,completePaintPending=false;
  const makeImage=tile=>{const c=document.createElement('canvas');c.width=tile.size;c.height=tile.size;c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(tile.buffer),tile.size,tile.size),0,0);return c;};
  const baseCache=WgeTileCache.create(makeImage),paintCache=WgeTileCache.create(makeImage,4096);
  function setTemperature(select,value){
    if(![...select.options].some(o=>o.value===value)){const option=document.createElement('option');option.value=value;option.textContent=value+' (unavailable)';select.append(option);}
    select.value=value;
  }
  window.addEventListener('wge:climate-catalog',()=>{
    for(const id of ['mapTemperature','shapeTemperature']){
      const select=$(id),value=select.value;select.replaceChildren();
      const choices=window.WgeProfiles?.catalog?.climates||WgeClimate.choices.filter(c=>c.source==='Minecraft');let group=null,source=null;
      for(const choice of choices){if(choice.source!==source){source=choice.source;group=document.createElement('optgroup');group.label=source;select.append(group);}
        const option=document.createElement('option');option.value=choice.id;option.textContent=choice.id==='standard'&&id==='shapeTemperature'?'Inherit map':choice.name;group.append(option);}
      setTemperature(select,value||'standard');
    }
  });
  function tell(text,error=false){status.textContent=text;status.title=text;status.classList.toggle('error',error);}
  function updateStatus(){
    const current=revision===appliedRevision&&!inspectorDirty;
    tell(`${dirty?'Unsaved changes':'Ready'} · ${current?'Biomes current':'Biomes pending'}${previewDiverged?' · Preview differs':''}${currentBase?.enabled===false?' · Generation disabled':''}`);
    $('documentTitle').textContent=$('editorName').value||'Untitled Map';
    $('documentState').textContent=(current?'Applied':'Draft')+(currentBase?.generation_version?' · Gen '+currentBase.generation_version:'');
    $('viewModeLabel').textContent=active?'Map canvas':current?'Applied biomes':'Applied biomes · draft changed';
  }
  function send(type,data={}){worker?.postMessage({type,...data});}
  function ensureWorkers(){
    if(worker)return;
    if(typeof Worker==='undefined')throw new Error('The editor requires a browser with Web Workers');
    worker=new Worker('editor.worker.js');baseWorker=new Worker('renderer.worker.js');
    worker.addEventListener('error',e=>tell(`Editor error: ${e.message}`,true));
    worker.addEventListener('message',({data:m})=>{
      if(m.type==='error'){
        if(m.seed!==undefined)$('editorSeed').value=m.seed;
        if(m.name!==undefined)$('editorName').value=m.name;
        if(m.oceanTemperature!==undefined)$('oceanTemperature').value=m.oceanTemperature;
        if(m.temperature!==undefined)setTemperature($('mapTemperature'),m.temperature);
        pendingLoad=false;epoch=m.epoch;tell(m.error,true);
        if(sourcePending){$('sourceError').textContent=m.error;sourcePending=false;}
        if(converting){converting=false;$('convertPaintButton').disabled=false;}
        if(exports.has(m.id)){exports.get(m.id).reject(new Error(m.error));exports.delete(m.id);}return;
      }
      if(m.type==='loaded'){
        const preserve=m.preserveHistory;pendingLoad=false;loaded=true;epoch=m.epoch;currentBase=m.base;
        paintedBounds=m.paintBounds;paintSelection=null;
        $('editorSeed').value=m.seed;$('brushRadius').value=m.editor.radius;$('brushRoughness').value=Math.round(m.editor.roughness*100);updateBrushLabels();
        if(m.name!==undefined)$('editorName').value=m.name;
        $('oceanTemperature').value=m.base.ocean_temperature??'';
        setTemperature($('mapTemperature'),m.base.temperature??'standard');
        if(!preserve){if(m.editor.profile&&window.WgeProfiles)void WgeProfiles.restore(m.editor.profile).catch(error=>tell(error.message,true));view=m.editor.view||pendingView||view;revision=0;appliedRevision=-1;dirty=pendingDirty;previewDiverged=false;inspectorDirty=false;inspectorEntry=null;}
        if(m.selected!==undefined)selected=m.selected;
        if(selected>=currentBase.entries.length)selected=currentBase.entries.length-1;
        if(!preserve&&currentBase.entries.length)selected=0;
        renderScene();fillInspector();
        if(initialFrame&&!m.editor.view){initialFrame=false;frameAll();}
        if(sourcePending){sourcePending=false;$('sourceDialog').close();}
        if(converting){converting=false;$('convertPaintButton').disabled=false;}
        pendingView=null;
        baseCache.clear();paintCache.clear();renderBase();draw();return;
      }
      if(pendingLoad||m.epoch!==epoch)return;
      if(m.type==='paint-picked'){
        if(m.pick!==paintPick)return;
        const previous=pickContext;pickContext=null;
        if(m.selection){selected=-1;paintSelection=m.selection;renderScene();fillInspector();draw();}
        else if(previous){selectObject(previous.fallback,false);}
        else{paintSelection=null;fillInspector();draw();}
        if(gesture?.paintPending===m.pick){
          delete gesture.paintPending;
          if(m.selection)gesture.paint=true;
          else if(selected>=0){gesture.object=selected;gesture.origin=entryGeometry(currentBase.entries[selected]);}
          else gesture.pan=true;
        }
        if(pickRelease?.pick===m.pick){const release=pickRelease;pickRelease=null;
          if(!release.cancel&&(release.dx||release.dz)){
            if(m.selection)send('paint-move',{pick:paintPick,dx:release.dx,dz:release.dz});
            else if(selected>=0){const g=entryGeometry(currentBase.entries[selected]);send('entry-change',{index:selected,patch:{x:Math.round(g.x+release.dx),z:Math.round(g.z+release.dz)}});}
          }
        }return;
      }
      if(m.type==='patch'){
        paintCache.remember(m.tiles,true);
        if(measurement&&measurement.operation===m.operation&&measurement.first===null)firstPaintPending=true;
        draw();
      }
      if(m.type==='state'){
        if(m.name!==undefined)$('editorName').value=m.name;
        if(m.oceanTemperature!==undefined)$('oceanTemperature').value=m.oceanTemperature;
        if(m.temperature!==undefined)setTemperature($('mapTemperature'),m.temperature);
        const changed=m.revision!==revision;
        if(changed){revision=m.revision;dirty=true;}
        if(paintSelection&&paintSelection.revision!==revision){paintSelection=null;fillInspector();draw();}
        $('undoBrush').disabled=!m.canUndo;$('redoBrush').disabled=!m.canRedo;
        canvas.dataset.revision=String(revision);canvas.dataset.paintedTiles=String(m.tileCount);
        $('paintTileCount').textContent=m.tileCount?`${m.tileCount} painted tiles`:'Empty layer';
        paintedBounds=m.paintBounds;
        $('objectCount').textContent=String((currentBase?.entries.length||0)+(paintedBounds?1:0));
        if(measurement&&measurement.operation===m.operation&&!measurement.done){completePaintPending=true;draw();}
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
  function okayToReplace(){return (!dirty&&!inspectorDirty)||confirm('The current project has not been saved to a file. Replace it?');}
  function switchMode(editor){
    if(editor&&!active&&loaded)view={...WgePreview.snapshot().view};
    if(gesture)finishGesture();active=editor;
    canvas.hidden=!editor;$('previewCanvas').hidden=editor;
    hud.hidden=!editor;$('previewHud').hidden=editor;$('biomeTooltip').hidden=true;cursor.hidden=true;
    $('inspectModeButton').setAttribute('aria-pressed',String(!editor));
    if(editor){
      WgePreview.pause();
      if(!loaded&&!pendingLoad){const current=WgePreview.snapshot();open(current.document,current.seed,current.view);}
      else{renderBase();draw();}
    }else{
      if(baseWorker)baseWorker.postMessage({id:++baseId,cancelOnly:true});
      WgePreview.resume(loaded?view:undefined);
    }
    updateStatus();
  }
  function draw(){
    if(drawFrame||!active)return;
    drawFrame=requestAnimationFrame(()=>{
      drawFrame=0;const r=canvas.getBoundingClientRect();canvas.width=Math.max(1,Math.floor(r.width));canvas.height=Math.max(1,Math.floor(r.height));
      context.fillStyle='#163f68';context.fillRect(0,0,canvas.width,canvas.height);
      baseCache.draw(context,view,canvas.width,canvas.height);paintCache.draw(context,view,canvas.width,canvas.height);
      drawGuides();
      if(measurement&&firstPaintPending){measurement.first=performance.now()-measurement.start;canvas.dataset.firstBrushFrameMs=String(Math.round(measurement.first));firstPaintPending=false;}
      if(measurement&&completePaintPending){measurement.done=true;canvas.dataset.brushCompleteMs=String(Math.round(performance.now()-measurement.start));completePaintPending=false;}
      hud.textContent=`x ${Math.round(view.x)}  z ${Math.round(view.z)} · 1 px = ${view.blocksPerPixel.toFixed(2)} blocks · Quick mask`;
    });
  }
  function renderBase(){
    if(!active||!loaded||!currentBase||gesture)return;
    const r=canvas.getBoundingClientRect(),quality=.5;
    baseWorker.postMessage({id:++baseId,source:'mask',configText:JSON.stringify(currentBase),seedText:$('editorSeed').value,
      view:{...view},width:Math.max(1,Math.floor(r.width*quality)),height:Math.max(1,Math.floor(r.height*quality)),cssWidth:Math.max(1,Math.floor(r.width)),cssHeight:Math.max(1,Math.floor(r.height)),quality,heightMode:'surface',shores:false,interactive:false});
  }
  function entryGeometry(entry){
    return WgeWorkspaceGeometry.geometry(entry);
  }
  function hitObject(point){
    const entries=currentBase?.entries||[];
    for(let i=entries.length-1;i>=0;i--)if(WgeWorkspaceGeometry.hit(entries[i],point))return i;
    return -1;
  }
  function drawGuides(){
    const w=canvas.width,h=canvas.height,left=view.x-w/2*view.blocksPerPixel,top=view.z-h/2*view.blocksPerPixel;
    if($('gridToggle').checked){
      const step=2**Math.ceil(Math.log2(view.blocksPerPixel*100));context.strokeStyle='#d5e4ee12';context.lineWidth=1;context.beginPath();
      for(let x=Math.floor(left/step)*step;x<=left+w*view.blocksPerPixel;x+=step){const px=Math.round((x-left)/view.blocksPerPixel)+.5;context.moveTo(px,0);context.lineTo(px,h);}
      for(let z=Math.floor(top/step)*step;z<=top+h*view.blocksPerPixel;z+=step){const pz=Math.round((z-top)/view.blocksPerPixel)+.5;context.moveTo(0,pz);context.lineTo(w,pz);}context.stroke();
    }
    if(!['select','pan'].includes(tool))return;
    const bounds=paintSelection?.bounds||(selected>=0&&currentBase?.entries[selected]?WgeWorkspaceGeometry.bounds(currentBase.entries[selected]):null);if(!bounds)return;
    const moving=gesture?.paint||gesture?.object===selected,dx=moving?gesture?.dx||0:0,dz=moving?gesture?.dz||0:0;
    const x=(bounds.minX+dx-left)/view.blocksPerPixel,z=(bounds.minZ+dz-top)/view.blocksPerPixel,width=(bounds.maxX-bounds.minX)/view.blocksPerPixel,height=(bounds.maxZ-bounds.minZ)/view.blocksPerPixel;
    // Selection is a world-axis rectangle, independent of the object's own rotation.
    context.save();context.strokeStyle='#e6b18a';context.lineWidth=1;context.setLineDash([4,4]);context.strokeRect(x,z,width,height);context.setLineDash([]);context.restore();
  }
  function frameAll(){
    if(!active){view={...WgePreview.snapshot().view};switchMode(true);}
    let bounds=paintedBounds?{...paintedBounds}:null;
    for(const entry of currentBase?.entries||[]){const g=entryGeometry(entry),r=Math.max(g.rx,g.rz)*1.4+(entry.coast?entry.coast.shallow_ocean_width_blocks+64:0);
      if(!bounds)bounds={minX:g.x-r,maxX:g.x+r,minZ:g.z-r,maxZ:g.z+r};
      else{bounds.minX=Math.min(bounds.minX,g.x-r);bounds.maxX=Math.max(bounds.maxX,g.x+r);bounds.minZ=Math.min(bounds.minZ,g.z-r);bounds.maxZ=Math.max(bounds.maxZ,g.z+r);}}
    if(bounds){const r=canvas.getBoundingClientRect();view={x:(bounds.minX+bounds.maxX)/2,z:(bounds.minZ+bounds.maxZ)/2,blocksPerPixel:Math.max(1,Math.min(96,Math.max((bounds.maxX-bounds.minX)/Math.max(1,r.width-60),(bounds.maxZ-bounds.minZ)/Math.max(1,r.height-60))))};}
    else view={x:0,z:0,blocksPerPixel:4};renderBase();draw();
  }
  function selectObject(index,invalidate=true){
    if(invalidate){paintPick++;pickContext=null;pickRelease=null;}
    selected=index;paintSelection=null;renderScene();fillInspector();draw();
  }
  function renderScene(){
    const list=$('sceneObjects');list.replaceChildren();$('objectCount').textContent=String((currentBase?.entries.length||0)+(paintedBounds?1:0));
    for(const [index,entry]of (currentBase?.entries||[]).entries()){
      const button=document.createElement('button');button.className='scene-object';button.type='button';button.setAttribute('aria-pressed',String(index===selected));
      const symbol=document.createElement('span');symbol.className='object-symbol';symbol.textContent=entry.type==='ocean'?'≈':entry.type==='archipelago'?'⠿':'◇';
      const text=document.createElement('span');text.className='object-text';const name=document.createElement('strong');name.textContent=entry.name||`Island ${index+1}`;
      const meta=document.createElement('small'),g=entryGeometry(entry);meta.textContent=`${Math.round(g.x)}, ${Math.round(g.z)} · ${entry.outline?'outline island':entry.type||'island'}`;text.append(name,meta);
      const kind=document.createElement('span');kind.className='object-type';kind.textContent=entry.outline?'OUTLINE':entry.type==='archipelago'?'GROUP':'SHAPE';button.append(symbol,text,kind);
      button.addEventListener('click',()=>{chooseTool('select');selectObject(index);});button.addEventListener('dblclick',()=>{const g=entryGeometry(entry);view={x:g.x,z:g.z,blocksPerPixel:Math.max(1,Math.min(96,(Math.max(g.rx,g.rz)*3+2*(entry.coast?.shallow_ocean_width_blocks||0))/Math.max(1,Math.min(canvas.clientWidth,canvas.clientHeight))))};renderBase();draw();});list.append(button);
    }
  }
  function fillInspector(){
    const brush=['land','ocean'].includes(tool),entry=currentBase?.entries[selected];
    $('brushProperties').hidden=!brush;$('brushKindLabel').textContent=tool.toUpperCase();$('objectProperties').hidden=brush||!entry;$('noSelection').hidden=brush||!!entry||!!paintSelection;
    $('paintProperties').hidden=brush||!paintSelection;
    $('paintLayerButton').setAttribute('aria-pressed',String(brush||!!paintSelection));
    $('selectionKind').textContent=brush?'BRUSH':paintSelection?'PAINTED':entry?.outline?'OUTLINE':entry?(entry.type||'island').toUpperCase():'MAP';
    if(paintSelection){const b=paintSelection.bounds;for(const [id,value]of Object.entries({paintCenterX:paintSelection.x,paintCenterZ:paintSelection.z,paintWidth:b.maxX-b.minX,paintDepth:b.maxZ-b.minZ}))$(id).value=value;}
    if(!entry){inspectorDirty=false;inspectorEntry=null;return;}
    const identity=selected+':'+JSON.stringify(entry);
    if(inspectorDirty&&inspectorEntry===identity)return;
    inspectorDirty=false;inspectorEntry=identity;
    $('shapeCoastProperties').hidden=!!entry.outline;$('shapeNoiseProperties').hidden=!!entry.outline;
    $('objectHeading').textContent=entry.name||'Island';
    $('objectGeometryKind').textContent=entry.outline?'CUSTOM CONTOUR':'PARAMETRIC';
    const g=entryGeometry(entry),radius=Math.max(g.rx,g.rz),noise=entry.noise||{};
    const values={shapeName:entry.name||`Island ${selected+1}`,shapeX:g.x,shapeZ:g.z,shapeRadiusX:entry.radius_x??entry.x_divisor??entry.radius??entry.size,shapeRadiusZ:entry.radius_z??entry.z_divisor??entry.radius??entry.size,
      shapeStretchX:entry.stretch_x??1,shapeStretchZ:entry.stretch_z??1,shapeRotation:g.rotation,shapePower:entry.shape_power??2,shapeMultiplier:entry.multiplier??entry.size_multiplier??1,
      shapeRoughness:entry.roughness??entry.noise_strength??.18,shapeShore:entry.shore_width??entry.edge_width??.16,shapePatch:entry.biome_patch_size??512,
      shapeCount:entry.count??12,shapeSpread:entry.spread??.9,shapeSpacing:entry.spacing??1.2,shapeMinRadius:entry.min_radius??radius*.08,shapeMaxRadius:entry.max_radius??radius*.18,
      shapeNoiseSeed:noise.seed??entry.name??`island_${selected+1}`,shapeNoiseScale:noise.scale??3.2,shapeOctave:noise.first_octave??-1,shapeAmplitudes:(noise.amplitudes??[1,.78,.55,.34]).join(', ')};
    for(const [id,value]of Object.entries(values))$(id).value=value;
    $('shapeOverlap').checked=!!entry.overlap;let temperature=(entry.temperature??entry.climate??'standard').toLowerCase();
    setTemperature($('shapeTemperature'),({normal:'temperate',hot:'warm'})[temperature]||temperature);
    $('archipelagoProperties').hidden=entry.type!=='archipelago';
    $('customCoastProperties').hidden=entry.type==='ocean';$('customCoast').checked=!!entry.coast;
    $('beachWidth').value=$('beachWidthSlider').value=entry.coast?.beach_width_blocks??16;
    $('oceanWidth').value=$('oceanWidthSlider').value=entry.coast?.shallow_ocean_width_blocks??128;updateCoastControls();
  }
  function world(event){const r=canvas.getBoundingClientRect();return {x:Math.max(-29999984,Math.min(29999984,view.x+(event.clientX-r.left-r.width/2)*view.blocksPerPixel)),z:Math.max(-29999984,Math.min(29999984,view.z+(event.clientY-r.top-r.height/2)*view.blocksPerPixel))};}
  function showCursor(event){
    const r=canvas.getBoundingClientRect(),radius=Number($('brushRadius').value);cursor.hidden=!active||!['land','ocean'].includes(tool)||space||gesture?.pan;
    cursor.style.left=`${event.clientX-r.left}px`;cursor.style.top=`${event.clientY-r.top}px`;cursor.style.width=cursor.style.height=`${2*radius/view.blocksPerPixel}px`;
  }
  function flushPoints(){if(pointFrame){cancelAnimationFrame(pointFrame);pointFrame=0;}if(points.length){send('points',{points});points=[];}}
  function enqueuePoint(event){points.push(world(event));if(!pointFrame)pointFrame=requestAnimationFrame(()=>{pointFrame=0;flushPoints();});}
  function finishGesture(cancel=false){
    if(!gesture)return;const previous=gesture;gesture=null;
    if(previous.pan){draw();renderBase();}
    else if(previous.paintPending!==undefined){pickRelease={pick:previous.paintPending,dx:previous.dx||0,dz:previous.dz||0,cancel};}
    else if(previous.paint){if(!cancel&&(previous.dx||previous.dz))send('paint-move',{pick:paintPick,dx:previous.dx||0,dz:previous.dz||0});draw();}
    else if(previous.object!==undefined){
      if(!cancel&&(previous.dx||previous.dz))send('entry-change',{index:previous.object,patch:{x:Math.round(previous.origin.x+(previous.dx||0)),z:Math.round(previous.origin.z+(previous.dz||0))}});
      draw();
    }
    else if(cancel){points=[];if(pointFrame)cancelAnimationFrame(pointFrame);pointFrame=0;send('cancel');}
    else{flushPoints();send('end');}
    if(canvas.hasPointerCapture(previous.id))canvas.releasePointerCapture(previous.id);
  }
  canvas.addEventListener('pointerdown',event=>{
    if(!loaded||pendingLoad||gesture||![0,1].includes(event.button))return;
    event.preventDefault();clearTimeout(viewTimer);baseWorker.postMessage({id:++baseId,cancelOnly:true});
    gesture={id:event.pointerId,pan:event.button===1||space||tool==='pan',x:event.clientX,y:event.clientY,view:{...view}};canvas.setPointerCapture(event.pointerId);
    if(!gesture.pan&&tool==='select'){
      const point=world(event),fallback=hitObject(point);
      if(paintedBounds&&point.x>=paintedBounds.minX&&point.x<=paintedBounds.maxX&&point.z>=paintedBounds.minZ&&point.z<=paintedBounds.maxZ){
        pickContext={fallback};pickRelease=null;gesture.paintPending=++paintPick;send('paint-pick',{pick:paintPick,...point});
      }else{selectObject(fallback);if(selected<0){gesture.pan=true;return;}gesture.object=selected;gesture.origin=entryGeometry(currentBase.entries[selected]);}
    }else if(!gesture.pan){
      paintSelection=null;
      measurement={operation:++operation,start:performance.now(),first:null,done:false};firstPaintPending=false;completePaintPending=false;
      delete canvas.dataset.firstBrushFrameMs;delete canvas.dataset.brushCompleteMs;
      send('begin',{operation,brush:{radius:Number($('brushRadius').value),roughness:Number($('brushRoughness').value)/100,tool}});enqueuePoint(event);
    }
    showCursor(event);
  });
  canvas.addEventListener('pointermove',event=>{
    showCursor(event);if(!gesture||gesture.id!==event.pointerId)return;
    if(gesture.pan){view.x=Math.max(-29999984,Math.min(29999984,gesture.view.x-(event.clientX-gesture.x)*view.blocksPerPixel));view.z=Math.max(-29999984,Math.min(29999984,gesture.view.z-(event.clientY-gesture.y)*view.blocksPerPixel));draw();}
    else if(gesture.object!==undefined||gesture.paint||gesture.paintPending!==undefined){gesture.dx=(event.clientX-gesture.x)*view.blocksPerPixel;gesture.dz=(event.clientY-gesture.y)*view.blocksPerPixel;draw();}
    else enqueuePoint(event);
  });
  canvas.addEventListener('pointerup',event=>{if(gesture?.id===event.pointerId){if(!gesture.pan&&gesture.object===undefined&&!gesture.paint&&gesture.paintPending===undefined)enqueuePoint(event);finishGesture();}});
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
  function chooseTool(value){
    if(value!=='select'){paintPick++;pickContext=null;pickRelease=null;}
    tool=value;switchMode(true);
    for(const [id,name]of [['selectTool','select'],['landBrush','land'],['oceanBrush','ocean'],['panTool','pan']])$(id).setAttribute('aria-pressed',String(tool===name));
    canvas.style.cursor=tool==='pan'?'grab':['land','ocean'].includes(tool)?'crosshair':'default';fillInspector();draw();
  }
  $('landBrush').addEventListener('click',()=>chooseTool('land'));$('oceanBrush').addEventListener('click',()=>chooseTool('ocean'));
  $('paintLayerButton').addEventListener('click',()=>{selectObject(-1);chooseTool('land');});
  $('frameMapButton').addEventListener('click',frameAll);$('gridToggle').addEventListener('change',draw);
  $('addObjectButton').addEventListener('click',()=>{if(loaded&&!pendingLoad){chooseTool('select');finishGesture();send('entry-add',{kind:$('addObjectType').value,x:Math.round(view.x),z:Math.round(view.z)});}});
  $('duplicateObjectButton').addEventListener('click',()=>{if(selected>=0&&!gesture)send('entry-duplicate',{index:selected});});
  $('deleteObjectButton').addEventListener('click',()=>{if(selected>=0&&!gesture)send('entry-remove',{index:selected});});
  $('deletePaintButton').addEventListener('click',()=>{if(paintSelection&&!gesture)send('paint-remove',{pick:paintPick});});
  $('convertPaintButton').addEventListener('click',()=>{
    if(!paintSelection||gesture||pendingLoad||converting)return;
    converting=true;$('convertPaintButton').disabled=true;tell('Converting coastline to island…');send('paint-convert');
  });
  function updateCoastControls(){
    const enabled=$('customCoast').checked;$('coastWidths').hidden=!enabled;
    for(const id of ['beachWidth','beachWidthSlider','oceanWidth','oceanWidthSlider'])$(id).disabled=!enabled;
  }
  $('customCoast').addEventListener('change',updateCoastControls);
  for(const [field,slider]of [['beachWidth','beachWidthSlider'],['oceanWidth','oceanWidthSlider']]){
    $(slider).addEventListener('input',()=>{$(field).value=$(slider).value;});
    $(field).addEventListener('input',()=>{$(slider).value=$(field).value;});
  }
  function shapePatch(){
    const number=id=>Number($(id).value),entry=currentBase.entries[selected];
    const patch={name:$('shapeName').value.trim(),x:number('shapeX'),z:number('shapeZ'),radius_x:number('shapeRadiusX'),radius_z:number('shapeRadiusZ'),stretch_x:number('shapeStretchX'),stretch_z:number('shapeStretchZ'),rotation:number('shapeRotation'),
      shape_power:number('shapePower'),multiplier:number('shapeMultiplier'),roughness:number('shapeRoughness'),shore_width:number('shapeShore'),overlap:$('shapeOverlap').checked,temperature:$('shapeTemperature').value,biome_patch_size:number('shapePatch'),
      noise:{seed:$('shapeNoiseSeed').value,scale:number('shapeNoiseScale'),first_octave:number('shapeOctave'),amplitudes:$('shapeAmplitudes').value.split(',').map(value=>value.trim()?Number(value):NaN)}};
    if(entry.type==='archipelago')Object.assign(patch,{count:number('shapeCount'),spread:number('shapeSpread'),spacing:number('shapeSpacing'),min_radius:number('shapeMinRadius'),max_radius:number('shapeMaxRadius')});
    if(entry.outline){for(const key of ['noise','shape_power','roughness','shore_width','multiplier'])delete patch[key];patch.overlap=false;}
    patch.coast=entry.type!=='ocean'&&$('customCoast').checked?{beach_width_blocks:number('beachWidth'),shallow_ocean_width_blocks:number('oceanWidth')}:null;
    return patch;
  }
  for(const type of ['input','change'])$('shapeForm').addEventListener(type,()=>{inspectorDirty=true;updateStatus();});
  $('shapeForm').addEventListener('submit',event=>{
    event.preventDefault();if(selected<0||pendingLoad)return;finishGesture();
    const entry={index:selected,patch:shapePatch()};
    if(!active||enterSubmission)void inspectCurrent({entry});
    else{chooseTool('select');send('entry-change',entry);}
  });
  $('sourceButton').addEventListener('click',()=>{
    if(!loaded||pendingLoad)return;finishGesture();const config={...currentBase};delete config.painted_map;
    $('workspaceJsonInput').value=JSON.stringify(config,null,2);$('sourceError').textContent='';$('sourceDialog').showModal();
  });
  $('closeSourceButton').addEventListener('click',()=>$('sourceDialog').close());
  $('applySourceButton').addEventListener('click',()=>{sourcePending=true;$('sourceError').textContent='Validating parameters…';send('configure',{text:$('workspaceJsonInput').value});});
  $('undoBrush').addEventListener('click',()=>{if(!gesture)send('undo');});$('redoBrush').addEventListener('click',()=>{if(!gesture)send('redo');});
  $('selectTool').addEventListener('click',()=>chooseTool('select'));$('panTool').addEventListener('click',()=>chooseTool('pan'));
  $('inspectModeButton').addEventListener('click',inspectCurrent);
  window.addEventListener('wge-preview-applied',event=>{
    if(!loaded||event.detail.fromEditor)return;
    if(dirty||inspectorDirty||gesture||pendingLoad){previewDiverged=true;updateStatus();}
    else open(event.detail.document,event.detail.seed,event.detail.view);
  });
  $('editorSeed').addEventListener('change',()=>{finishGesture();send('seed',{seed:$('editorSeed').value});});
  $('editorName').addEventListener('change',()=>{finishGesture();send('name',{name:$('editorName').value});});
  $('mapTemperature').addEventListener('change',()=>{finishGesture();send('temperature',{value:$('mapTemperature').value});});
  $('oceanTemperature').addEventListener('change',()=>{finishGesture();send('ocean-temperature',{value:$('oceanTemperature').value});});
  $('newMapButton').addEventListener('click',()=>{if(okayToReplace()){chooseTool('land');selected=-1;open({enabled:true,generation_version:5,entries:[]},$('editorSeed').value,{x:0,z:0,blocksPerPixel:4});}});
  $('importPreviewButton').addEventListener('click',()=>{if(okayToReplace()){const p=WgePreview.snapshot();open(p.document,p.seed,p.view);}});
  $('projectInput').addEventListener('change',async event=>{
    const file=event.target.files[0];event.target.value='';if(!file||!okayToReplace())return;
    try{if(file.size>32*1024*1024)throw new Error('File exceeds 32 MiB');chooseTool('select');initialFrame=true;open(await file.text(),$('editorSeed').value);}catch(error){tell(error.message,true);}
  });
  function exportDocument(kind,settings){
    if(!loaded||pendingLoad||gesture)return Promise.reject(new Error('Finish the current action and wait for the map to load'));
    return new Promise((resolve,reject)=>{const id=++exportId;exports.set(id,{resolve,reject});send('export',{id,kind,view:{...view},...(settings?{settings}:{})});});
  }
  window.addEventListener('wge:profile-selected',()=>{previewDiverged=true;updateStatus();});
  function download(text,name){const url=URL.createObjectURL(new Blob([text],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
  $('saveProjectButton').addEventListener('click',async()=>{try{const result=await exportDocument('project');download(result.text,result.filename);if(result.revision===revision)dirty=false;updateStatus();}catch(error){tell(error.message,true);}});
  $('exportPresetButton').addEventListener('click',async()=>{try{const result=await exportDocument('preset');download(result.text,result.filename);tell(`Preset exported · Seed ${result.seed}`);}catch(error){tell(error.message,true);}});
  async function inspectCurrent(options={}){
    if(applying)return;finishGesture();
    const pendingObject=inspectorDirty&&selected>=0;
    if((pendingObject||options.entry)&&!$('shapeForm').reportValidity())return;
    const settings={seed:$('editorSeed').value,name:$('editorName').value,oceanTemperature:$('oceanTemperature').value,temperature:$('mapTemperature').value,profile:window.WgeProfiles?.selection,
      ...(options.entry?{entry:options.entry}:pendingObject?{entry:{index:selected,patch:shapePatch()}}:{})};
    applying=true;$('applyEditorButton').disabled=true;
    try{if(window.WgeProfiles?.ready){await WgeProfiles.ready;settings.profile=WgeProfiles.selection;}const result=await exportDocument('apply',settings);if(window.WgeProfiles)result.profile=await WgeProfiles.validate(result);if(result.revision<revision)throw new Error('Map changed; apply again');WgePreview.applyPainted(result,view);appliedRevision=result.revision;previewDiverged=false;inspectorDirty=false;fillInspector();updateStatus();switchMode(false);}catch(error){tell(error.message,true);}
    finally{applying=false;$('applyEditorButton').disabled=false;}
  }
  $('applyEditorButton').addEventListener('click',inspectCurrent);
  window.addEventListener('keydown',event=>{
    const target=event.target||document.activeElement;
    if(event.key==='Enter'&&!event.isComposing&&!event.repeat&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.shiftKey
      &&!$('sourceDialog').open&&!/^(TEXTAREA|BUTTON|A|SUMMARY)$/.test(target?.tagName)){
      event.preventDefault();
      const form=target?.closest?.('#shapeForm');
      if(form){enterSubmission=true;try{form.requestSubmit();}finally{enterSubmission=false;}}
      else void inspectCurrent();
      return;
    }
    if($('sourceDialog').open||/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName))return;
    if(event.code==='Space'){event.preventDefault();space=true;cursor.hidden=true;}
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();if(!gesture)send(event.shiftKey?'redo':'undo');}
    else if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='d'){event.preventDefault();if(selected>=0&&!gesture)send('entry-duplicate',{index:selected});}
    else if(!event.ctrlKey&&!event.metaKey&&!event.altKey){
      const tools={v:'select',b:'land',e:'ocean',h:'pan'};
      if(tools[event.key.toLowerCase()]){event.preventDefault();chooseTool(tools[event.key.toLowerCase()]);}
      if(event.key.toLowerCase()==='i'){event.preventDefault();void inspectCurrent();}
      if(event.key==='Home'){event.preventDefault();frameAll();}
      if(['Delete','Backspace'].includes(event.key)&&selected>=0&&!gesture){event.preventDefault();send('entry-remove',{index:selected});}
      else if(['Delete','Backspace'].includes(event.key)&&paintSelection&&!gesture){event.preventDefault();send('paint-remove',{pick:paintPick});}
      const arrows={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};
      if(arrows[event.key]&&selected>=0&&!gesture){event.preventDefault();const g=entryGeometry(currentBase.entries[selected]),step=event.shiftKey?64:4;send('entry-change',{index:selected,patch:{x:g.x+arrows[event.key][0]*step,z:g.z+arrows[event.key][1]*step}});}
      else if(arrows[event.key]&&paintSelection&&!gesture){event.preventDefault();const step=event.shiftKey?64:4;send('paint-move',{pick:paintPick,dx:arrows[event.key][0]*step,dz:arrows[event.key][1]*step});}
    }
    if(event.key==='Escape')finishGesture(true);
  });
  window.addEventListener('keyup',event=>{if(event.code==='Space')space=false;});
  window.addEventListener('blur',()=>{space=false;finishGesture(true);});
  window.addEventListener('resize',()=>{draw();clearTimeout(viewTimer);viewTimer=setTimeout(renderBase,120);});
  window.addEventListener('beforeunload',event=>{if(dirty||inspectorDirty){event.preventDefault();event.returnValue='';}});
  function scheduleSave(){clearTimeout(saveTimer);saveTimer=setTimeout(async()=>{
    if(!db||gesture||pendingLoad)return;
    try{const result=await exportDocument('project');const tx=db.transaction('drafts','readwrite');tx.objectStore('drafts').put(result.text,'current');
      tx.oncomplete=()=>{draftText=result.text;$('restoreDraftButton').disabled=false;};tx.onerror=()=>tell('Could not save the local draft',true);
    }catch(error){tell(error.message,true);}
  },600);}
  $('restoreDraftButton').addEventListener('click',()=>{if(draftText&&okayToReplace())open(draftText,'0',view,true);});
  try{
    const review=new URLSearchParams(location.search).get('review');
    const request=indexedDB.open(review!==null?'wge-map-editor-interface-review'+(review==='1'?'':'-'+review.replace(/[^a-z0-9_-]/gi,'').slice(0,32)):'wge-map-editor',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('drafts');
    request.onsuccess=()=>{db=request.result;const read=db.transaction('drafts').objectStore('drafts').get('current');read.onsuccess=()=>{if(typeof read.result==='string'){draftText=read.result;$('restoreDraftButton').disabled=false;}};};
    request.onerror=()=>tell('Autosave is unavailable; save your project to a file',true);
  }catch{tell('Autosave is unavailable; save your project to a file',true);}
  chooseTool('select');
})();
