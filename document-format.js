/* Keep large painted payloads out of the main-thread JSON editor and compiler. */
(function(root){
  function split(document){
    const config=document.config||document,paint=config.painted_map;
    const small={...config};delete small.painted_map;
    const metadata=document.config?{...document,config:small}:small;
    let bounds=null;
    if(paint?.tiles.length){
      const xs=paint.tiles.map(t=>t.x*256),zs=paint.tiles.map(t=>t.z*256);
      bounds={minX:Math.min(...xs),maxX:Math.max(...xs)+256,minZ:Math.min(...zs),maxZ:Math.max(...zs)+256,tiles:paint.tiles.length};
    }
    return {metadataText:JSON.stringify(metadata,null,2),paintText:paint?JSON.stringify(paint):null,bounds};
  }
  function attach(document,paintText){
    if(!paintText)return JSON.stringify(document);
    const config=document.config||document,text=JSON.stringify(config);
    const body=text.slice(0,-1)+(text==='{}'?'':',')+'"painted_map":'+paintText+'}';
    if(!document.config)return body;
    const metadata={...document};delete metadata.config;
    const wrapper=JSON.stringify(metadata);
    return wrapper.slice(0,-1)+(wrapper==='{}'?'':',')+'"config":'+body+'}';
  }
  function prepare(text,seedText){
    if(new TextEncoder().encode(text).length>32*1024*1024)throw new Error('Configuration exceeds 32 MiB');
    const mask=root.WgeMask||(typeof require==='function'?require('./mask-core.js'):{});
    const document=JSON.parse(text);
    if(document.format==='wge-map-project')throw new Error('Open map projects in the map editor');
    const parsed=mask.readDocument(document),seed=mask.parseSeed(seedText);
    if(seed===null)throw new Error('Resolve the seed before preparing the map');
    mask.parseConfig(parsed.config,seed);
    return {...split(document),seedText:seed.toString()};
  }
  function filename(name,project=false){
    let stem=String(name||'Island Map').trim().replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/g,'-').replace(/\s+/g,'-').slice(0,100).replace(/[. ]+$/g,'');
    if(!stem||stem==='.'||stem==='..')stem='Island-Map';
    if(/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(stem))stem='Map-'+stem;
    return stem+(project?'.wge.json':'.json');
  }
  root.WgeDocument={split,attach,prepare,filename};
  if(typeof module!=='undefined')module.exports=root.WgeDocument;
})(globalThis);
