/* Local profile operations are explicit; editing never restarts the runtime. */
(function(){
  const $=id=>document.getElementById(id),select=$('generationProfile'),status=$('profileStatus');
  const state={selection:{id:'vanilla',worldPreset:'minecraft:normal',fingerprint:''},catalog:null,profiles:[],ready:null};
  let sequence=0,job=null;
  async function api(path,body){const r=await fetch('/api/'+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}),v=await r.json();if(!r.ok)throw new Error(v.error||'Profile request failed');return v;}
  function tell(text,error=false){status.textContent=text;status.classList.toggle('error',error);}
  function showAccuracy(){
    const vanilla=state.selection.id==='vanilla';
    const verified=state.catalog?.accuracy==='verified'&&state.selection.worldPreset==='minecraft:normal';
    $('accuracyProfile').textContent=vanilla?'Minecraft + WGE':verified?'Verified modpack':'Unverified modpack';
    tell(vanilla?'Minecraft + WGE':verified?'Verified profile':'Unverified world preset or modpack');
  }
  async function list(){const data=await api('profiles/list');state.profiles=data.profiles;const value=select.value;select.replaceChildren();for(const p of data.profiles){const option=document.createElement('option');option.value=p.id;option.textContent=p.name;select.append(option);}select.value=value||'vanilla';}
  async function loadCatalog(id,serial){
    const catalog=await api('catalog?profile='+encodeURIComponent(id));if(serial!==sequence)return;
    const selectedWorldPreset=state.selection.id===id?state.selection.worldPreset:'minecraft:normal';
    const presets=catalog.world_presets||['minecraft:normal'];$('worldPreset').replaceChildren();for(const id of presets){const o=document.createElement('option');o.value=id;o.textContent=id;$('worldPreset').append(o);}
    $('worldPreset').value=presets.includes(selectedWorldPreset)?selectedWorldPreset:presets.includes('minecraft:normal')?'minecraft:normal':presets[0];
    $('worldPresetField').hidden=presets.length<2;
    const palette=await fetch('biome-palette.json').then(r=>r.json());if(serial!==sequence)return;
    state.unavailableReference=null;state.catalog=catalog;state.selection={id,worldPreset:$('worldPreset').value,fingerprint:catalog.resources||''};
    WgeBiomeColors.installCatalog(catalog.biomes?.map(b=>({...b,color:b.color||palette[b.id]}))||[]);
    state.colors=Object.fromEntries((catalog.biomes||[]).filter(b=>b.color||palette[b.id]).map(b=>[b.id,b.color||palette[b.id]]));
    state.biomes=new Map((catalog.biomes||[]).map(b=>[b.id,b]));
    window.dispatchEvent(new CustomEvent('wge:climate-catalog'));window.dispatchEvent(new CustomEvent('wge:profile-selected'));
    showAccuracy();
  }
  async function prepare(request){
    const serial=++sequence;job=null;select.disabled=true;$('importModpackButton').disabled=true;$('reloadProfileButton').disabled=true;$('cancelProfileButton').hidden=false;
    try{
      tell('Preparing profile…');const started=await api('profiles/prepare',request);job=started.job;
      for(;;){await new Promise(r=>setTimeout(r,500));const result=await api('profiles/status?id='+encodeURIComponent(job));if(serial!==sequence)return;
        if(result.state==='failed'||result.state==='cancelled')throw new Error(result.error||'Profile preparation cancelled');
        if(result.state==='ready'){
          await list();const id=result.profile.id;select.value=id;$('profileHeap').value=result.profile.heap_mib;
          renderDetails(result.profile);await loadCatalog(id,serial);return;
        }tell(result.state.charAt(0).toUpperCase()+result.state.slice(1)+'…');
      }
    }catch(error){tell(error.message,true);select.value=state.selection.id;state.ready=null;throw error;}
    finally{job=null;select.disabled=false;$('importModpackButton').disabled=false;$('reloadProfileButton').disabled=false;$('cancelProfileButton').hidden=true;}
  }
  function renderDetails(profile){const container=$('profileDetails');container.replaceChildren();
    const lines=[`Minecraft ${profile.minecraft||'1.21.1'} · NeoForge ${profile.neoforge||'21.1.230'} · WGE ${profile.wge_version||'0.4.0'}`,...(profile.loaded_mods||profile.mods||[]).map(m=>`${m.id||m.file} ${m.version||''}`),...(profile.excluded||[]).map(m=>`${m.id||m.file} — ${m.reason}`)];
    for(const text of lines){const row=document.createElement('div');row.textContent=text;container.append(row);}
  }
  async function choose(id){const serial=++sequence,p=state.profiles.find(p=>p.id===id);
    if(id!=='vanilla'&&['not prepared','outdated'].includes(p?.status))return prepare({profile:id,heap_mib:Number($('profileHeap').value)});
    if(p){if(id!=='vanilla')$('profileHeap').value=p.heap_mib;renderDetails(p);}tell('Loading profile…');await loadCatalog(id,serial);
  }
  select.addEventListener('change',()=>{state.ready=choose(select.value);state.ready.catch(e=>tell(e.message,true));});
  $('importModpackButton').addEventListener('click',()=>{state.ready=prepare({heap_mib:Number($('profileHeap').value)});state.ready.catch(()=>{});});
  $('reloadProfileButton').addEventListener('click',()=>{if(select.value==='vanilla'){state.ready=choose('vanilla');state.ready.catch(e=>tell(e.message,true));return;}state.ready=prepare({profile:select.value,heap_mib:Number($('profileHeap').value)});state.ready.catch(()=>{});});
  $('cancelProfileButton').addEventListener('click',()=>{if(job)void api('profiles/cancel',{job}).catch(e=>tell(e.message,true));});
  $('worldPreset').addEventListener('change',()=>{state.selection.worldPreset=$('worldPreset').value;showAccuracy();window.dispatchEvent(new CustomEvent('wge:profile-selected'));});
  state.validate=async result=>{
    if(state.ready)await state.ready;
    if(state.unavailableReference)throw new Error('Select an available generation profile before applying this project');
    const profile={...state.selection};
    const config=WgeDocument.attach(JSON.parse(result.metadataText),result.paintText);
    const request='{"seed":'+JSON.stringify(result.seed)+',"config":'+config+',"generation_version":'+(JSON.parse(result.metadataText).generation_version||3)+',"coast_revision":3,"profile":'+JSON.stringify(profile.id)+',"world_preset":'+JSON.stringify(profile.worldPreset)+',"expected_resources":'+JSON.stringify(profile.fingerprint)+'}';
    const response=await fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:request});const value=await response.json();if(!response.ok)throw new Error(value.error||'Preview configuration rejected');if(JSON.stringify(profile)!==JSON.stringify(state.selection))throw new Error('Generation profile changed; apply again');return profile;
  };
  state.restore=reference=>{
    if(!reference)return Promise.resolve();const previous=state.ready;
    const operation=(async()=>{if(previous)await previous;
      if(state.profiles.some(p=>p.id===reference.id)){
        select.value=reference.id;await choose(reference.id);
        if([...$('worldPreset').options].some(o=>o.value===reference.worldPreset)){$('worldPreset').value=reference.worldPreset;state.selection.worldPreset=reference.worldPreset;showAccuracy();}
        if(reference.fingerprint&&reference.fingerprint!==state.selection.fingerprint)tell('Profile resources changed; apply again',true);
      }else{
        state.unavailableReference=reference;const option=document.createElement('option');option.value='unavailable';option.textContent='Unavailable project profile';select.append(option);select.value='unavailable';tell('Project generation profile is not available',true);
      }
    })();state.ready=operation;operation.catch(error=>tell(error.message,true));return operation;
  };
  window.WgeProfiles=state;
  state.ready=(async()=>{await list();await loadCatalog('vanilla',++sequence);})().catch(error=>{tell(error.message,true);throw error;});
  state.ready.catch(()=>{});
})();
