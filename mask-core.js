/* Shared deterministic mask implementation, used in workers, fallback rendering and tests. */
(function(root) {
"use strict";
const {Grid:PaintedGrid}=root.WgePaintedMap||(typeof require==='function'?require('./painted-map.js'):{});
const DEFAULT_AMPLITUDES = [1.0, 0.78, 0.55, 0.34];
const DEFAULT_NOISE_SCALE = 3.2;
const DEFAULT_FIRST_OCTAVE = -1;
const DEFAULT_MULTIPLIER = 1.0;
const DEFAULT_NOISE_STRENGTH = 0.18;
const DEFAULT_EDGE_WIDTH = 0.16;
const DEFAULT_SHAPE_POWER = 2.0;
const MIN_SHAPE_POWER = 0.75;
const MAX_SHAPE_POWER = 8.0;
const DEFAULT_ARCHIPELAGO_COUNT = 12;
const DEFAULT_ARCHIPELAGO_SPREAD = 0.9;
const DEFAULT_ARCHIPELAGO_SPACING = 1.2;
const DEFAULT_ARCHIPELAGO_MIN_STRETCH = 0.65;
const DEFAULT_ARCHIPELAGO_MAX_STRETCH = 1.6;
const DEFAULT_ARCHIPELAGO_MIN_SHAPE_POWER = 1.2;
const DEFAULT_ARCHIPELAGO_MAX_SHAPE_POWER = 3.8;
const FULL_OCEAN_MASK = 0.30;
const LAND_MASK = 0.58;
const BEACH_START_MASK = 0.50;
const BEACH_END_MASK = 0.56;
const DEEP_OCEAN_MASK = 0.08;
const SPATIAL_CELL_SIZE = 512;

function readDocument(input) {
  if(input?.format!==undefined)throw new Error('Unsupported preview document format; open map projects in the map editor');
  if(input?.config){
    const version=input.generation_version===undefined?1:input.generation_version;
    if(!Number.isInteger(version)||version<1||version>4)throw new Error("Unsupported generation_version");
    if(input.config.entries?.some?.(entry=>entry?.coast!==undefined)&&version<4)throw new Error("Custom coasts require generation_version 4");
    if(input.config.painted_map&&version<3)throw new Error("Painted maps require generation_version 3");
    if(input.config.entries?.some?.(entry=>entry?.outline!==undefined)&&version<3)throw new Error('Island outlines require generation_version 3');
    if(input.enabled!=null&&typeof input.enabled!=="boolean")throw new Error("World enabled must be boolean");
    return {config:{...input.config,enabled:(input.config.enabled??true)&&input.enabled!==false},generationVersion:version};
  }
  const outlines=input?.entries?.some?.(entry=>entry?.outline!==undefined);
  const coasts=input?.entries?.some?.(entry=>entry?.coast!==undefined);
  const version=input?.generation_version??(coasts?4:input?.painted_map||outlines?3:2);
  if(!Number.isInteger(version)||version<1||version>4)throw new Error("Unsupported generation_version");
  if(coasts&&version<4)throw new Error("Custom coasts require generation_version 4");
  if(input?.painted_map&&version<3)throw new Error("Painted maps require generation_version 3");
  if(outlines&&version<3)throw new Error('Island outlines require generation_version 3');
  return {config:input,generationVersion:version};
}

function parseConfig(input, seed) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Root must be an object");
  }
  if (!Array.isArray(input.entries)) {
    throw new Error(input.active_preset ? "Open the selected presets/*.json file or a world snapshot" : "entries must be an array");
  }

  if (input.enabled != null && typeof input.enabled !== "boolean") throw new Error("enabled must be boolean");
  if(input.name!=null&&(typeof input.name!=='string'||!input.name.trim()||input.name.trim().length>120||/[\u0000-\u001f\u007f-\u009f]/.test(input.name)))throw new Error('name must contain 1–120 characters without control characters');
  if (input.outer_ocean != null && (typeof input.outer_ocean !== "string" || !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(input.outer_ocean))) throw new Error("outer_ocean is invalid");
  if (Object.hasOwn(input,'ocean_temperature') && !['temperate','cold','warm'].includes(input.ocean_temperature)) throw new Error('ocean_temperature must be temperate, cold or warm; omit it for default behavior');
  const compiledEntries = [];
  const landShapes = [];
  const oceanShapes = [];
  const sourceSummaries = [];
  const outlines=[];
  const paintedMap=input.painted_map==null?null:new PaintedGrid(input.painted_map);let paintedTiles=paintedMap?.tiles.size||0;

  input.entries.forEach((entry, index) => {
    const parsed = parseEntry(entry, index, seed);
    if(parsed.outline){paintedTiles+=parsed.outline.mask.tiles.size;if(paintedTiles>4096)throw new Error('Combined painted map and island outlines exceed 4096 tiles');}
    if(parsed.outline){outlines.push(parsed);compiledEntries.push(parsed);sourceSummaries.push({...parsed,childCount:0});}
    else if (parsed.type === "archipelago") {
      const children = compileArchipelago(parsed, seed);
      compiledEntries.push(...children);
      landShapes.push(...children);
      sourceSummaries.push({ ...parsed, childCount: children.length });
    } else {
      compiledEntries.push(parsed);
      if (parsed.type === "ocean") oceanShapes.push(parsed);
      else landShapes.push(parsed);
      sourceSummaries.push({ ...parsed, childCount: 0 });
    }
  });

  compiledEntries.landShapes = landShapes;
  compiledEntries.oceanShapes = oceanShapes;
  compiledEntries.landGrid = buildSpatialGrid(landShapes);
  compiledEntries.oceanGrid = buildSpatialGrid(oceanShapes);
  compiledEntries.sourceSummaries = sourceSummaries;
  compiledEntries.paintedMap=paintedMap;
  compiledEntries.outlines=outlines;
  if(sourceSummaries.some(e=>e.coast))compiledEntries.coastField=new CoastField(configPoint=>rawCoastInfo(input,compiledEntries,...configPoint),compiledEntries);
  return compiledEntries;
}

function parseEntry(entry, index, seed) {
  const path = `entries[${index}]`;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${path} must be an object`);
  if (entry.overlap != null && typeof entry.overlap !== "boolean") throw new Error(`${path}.overlap must be boolean`);
  if (entry.noise != null && (typeof entry.noise !== "object" || Array.isArray(entry.noise))) throw new Error(`${path}.noise must be an object`);
  if (entry.exclude_biomes != null && (!Array.isArray(entry.exclude_biomes) || entry.exclude_biomes.some(id => typeof id !== "string" || !/^#?[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(id)))) throw new Error(`${path}.exclude_biomes is invalid`);
  const temperature=stringValue(entry.temperature ?? entry.climate,"standard").toLowerCase();
  if (!["cold","temperate","normal","warm","hot","standard","standart","vanilla","auto"].includes(temperature)) throw new Error(`${path}.temperature is invalid`);
  const patch=entry.biome_patch_size ?? 512;
  if (!Number.isInteger(patch) || patch<4 || patch>4096) throw new Error(`${path}.biome_patch_size must be between 4 and 4096`);
  const name = stringValue(entry.name, `island_${index + 1}`);
  const type = parseEntryType(stringValue(entry.type, "island"), path);
  if((String(entry.type??'island').toLowerCase()==='outlined_island')!==Object.hasOwn(entry,'outline'))throw new Error(`${path}.outline requires type outlined_island with outline data`);
  const noise = entry.noise && typeof entry.noise === "object" ? entry.noise : {};
  const radius = positiveNumber(entry.radius ?? entry.size, -1, `${path}.radius`);
  const radiusX = positiveNumber(entry.radius_x ?? entry.x_divisor, radius, `${path}.radius_x`);
  const radiusZ = positiveNumber(entry.radius_z ?? entry.z_divisor, radius, `${path}.radius_z`);
  if (radiusX <= 0 || radiusZ <= 0) {
    throw new Error(`${path} must define radius or both radius_x and radius_z`);
  }

  const centerX = finiteNumber(entry.x ?? entry.center_x, `${path}.x`);
  const centerZ = finiteNumber(entry.z ?? entry.center_z, `${path}.z`);
  const stretchX = positiveNumber(entry.stretch_x, 1, `${path}.stretch_x`);
  const stretchZ = positiveNumber(entry.stretch_z, 1, `${path}.stretch_z`);
  if (noise.amplitudes != null && !Array.isArray(noise.amplitudes)) throw new Error(`${path}.noise.amplitudes must be an array`);
  const amplitudes = Array.isArray(noise.amplitudes) ? noise.amplitudes.map((value, amplitudeIndex) => {
    const parsed = finiteNumber(value, `${path}.noise.amplitudes[${amplitudeIndex}]`);
    if (parsed < 0) throw new Error(`${path}.noise.amplitudes[${amplitudeIndex}] must be >= 0`);
    return parsed;
  }) : DEFAULT_AMPLITUDES;
  if (!amplitudes.length) throw new Error(`${path}.noise.amplitudes must not be empty`);

  const rotation = finiteNumber(entry.rotation ?? entry.rotation_degrees ?? 0, `${path}.rotation`);
  const radians = rotation * Math.PI / 180;
  const noiseSeed = stringValue(noise.seed, name);
  const xDivisor = radiusX * stretchX;
  const zDivisor = radiusZ * stretchZ;
  const clusterRadius = Math.max(xDivisor, zDivisor);
  const minRadius = type === "archipelago" ? positiveNumber(entry.min_radius, clusterRadius * 0.08, `${path}.min_radius`) : 0;
  const maxRadius = type === "archipelago" ? positiveNumber(entry.max_radius, clusterRadius * 0.18, `${path}.max_radius`) : 0;
  if (type === "archipelago" && minRadius > maxRadius) throw new Error(`${path}.min_radius must be <= max_radius`);
  const minStretch = type === "archipelago" ? positiveNumber(entry.min_stretch, DEFAULT_ARCHIPELAGO_MIN_STRETCH, `${path}.min_stretch`) : 0;
  const maxStretch = type === "archipelago" ? positiveNumber(entry.max_stretch, DEFAULT_ARCHIPELAGO_MAX_STRETCH, `${path}.max_stretch`) : 0;
  if (type === "archipelago" && minStretch > maxStretch) throw new Error(`${path}.min_stretch must be <= max_stretch`);
  const minShapePower = type === "archipelago" ? rangeNumber(entry.min_shape_power, DEFAULT_ARCHIPELAGO_MIN_SHAPE_POWER, MIN_SHAPE_POWER, MAX_SHAPE_POWER, `${path}.min_shape_power`) : 0;
  const maxShapePower = type === "archipelago" ? rangeNumber(entry.max_shape_power, DEFAULT_ARCHIPELAGO_MAX_SHAPE_POWER, MIN_SHAPE_POWER, MAX_SHAPE_POWER, `${path}.max_shape_power`) : 0;
  if (type === "archipelago" && minShapePower > maxShapePower) throw new Error(`${path}.min_shape_power must be <= max_shape_power`);

  const parsed = {
    type,
    temperature,
    excludedBiomes:entry.exclude_biomes||[],
    coast:parseCoast(entry,path,type),
    name,
    overlap: Boolean(entry.overlap),
    centerX,
    centerZ,
    xDivisor,
    zDivisor,
    rotation,
    cos: Math.cos(radians),
    sin: Math.sin(radians),
    shapePower: rangeNumber(entry.shape_power, DEFAULT_SHAPE_POWER, MIN_SHAPE_POWER, MAX_SHAPE_POWER, `${path}.shape_power`),
    multiplier: positiveNumber(entry.multiplier ?? entry.size_multiplier, DEFAULT_MULTIPLIER, `${path}.multiplier`),
    noiseStrength: rangeNumber(entry.roughness ?? entry.noise_strength, DEFAULT_NOISE_STRENGTH, 0, 1, `${path}.roughness`),
    edgeWidth: positiveNumber(entry.shore_width ?? entry.edge_width, DEFAULT_EDGE_WIDTH, `${path}.shore_width`),
    noise: {
      seed: noiseSeed,
      firstOctave: integerNumber(noise.first_octave, DEFAULT_FIRST_OCTAVE, `${path}.noise.first_octave`),
      scale: positiveNumber(noise.scale, DEFAULT_NOISE_SCALE, `${path}.noise.scale`),
      amplitudes,
    },
    seed: mix(seed, stableStringSeed(noiseSeed)),

    exactNoiseCache: new Map(),
    count: type === "archipelago" ? positiveInteger(entry.count, DEFAULT_ARCHIPELAGO_COUNT, `${path}.count`) : 0,
    minRadius,
    maxRadius,
    spread: type === "archipelago" ? rangeNumber(entry.spread, DEFAULT_ARCHIPELAGO_SPREAD, 0.05, 1, `${path}.spread`) : 0,
    spacing: type === "archipelago" ? positiveNumber(entry.spacing, DEFAULT_ARCHIPELAGO_SPACING, `${path}.spacing`) : 0,
    minStretch,
    maxStretch,
    minShapePower,
    maxShapePower,
  };
  if (![xDivisor,zDivisor].every(n=>Number.isFinite(n)&&n>=0.001&&n<=60000000)) throw new Error(`${path}: compiled radii outside supported range`);
  if (parsed.noise.firstOctave < -20 || parsed.noise.firstOctave > 20 || parsed.noise.scale>1024 || amplitudes.length>16 || !Number.isFinite(amplitudes.reduce((a,b)=>a+b,0)) || parsed.multiplier>100 || parsed.edgeWidth>10 || parsed.count>4096 || parsed.noise.firstOctave+amplitudes.length-1>12 || Math.abs(centerX)>30000000 || Math.abs(centerZ)>30000000 || Math.abs(rotation)>360000 || parsed.maxRadius*Math.max(1,parsed.maxStretch)>60000000 || parsed.maxStretch>100 || parsed.spacing>1000 || (type==="archipelago"&&parsed.minRadius*Math.min(1,parsed.minStretch)<0.001)) throw new Error(`${path}: noise or shape exceeds supported limits`);
  attachBounds(parsed);
  if(Object.hasOwn(entry,'outline')){
    if(type!=='island'||parsed.overlap)throw new Error(`${path}.outline requires type outlined_island and overlap false`);
    const value=entry.outline;
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`${path}.outline must be an object`);
    const rx=positiveNumber(value.radius_x,-1,`${path}.outline.radius_x`),rz=positiveNumber(value.radius_z,-1,`${path}.outline.radius_z`);
    if(rx<.001||rz<.001||rx>60000000||rz>60000000)throw new Error(`${path}.outline reference radii outside supported range`);
    if(!value.mask)throw new Error(`${path}.outline.mask is required`);
    const mask=new PaintedGrid(value.mask),b=mask.bounds();
    if(!b||b.minX < -rx||b.maxX>rx||b.minZ < -rz||b.maxZ>rz)throw new Error(`${path}.outline samples exceed reference radii or are empty`);
    parsed.outline={radiusX:rx,radiusZ:rz,mask};
    parsed.outlineScaleX=rx/(parsed.xDivisor*parsed.multiplier);parsed.outlineScaleZ=rz/(parsed.zDivisor*parsed.multiplier);
    const extentX=(Math.max(Math.abs(b.minX),Math.abs(b.maxX))+4)/parsed.outlineScaleX,extentZ=(Math.max(Math.abs(b.minZ),Math.abs(b.maxZ))+4)/parsed.outlineScaleZ;
    parsed.outlineExtentX=Math.abs(parsed.cos)*extentX+Math.abs(parsed.sin)*extentZ+8;
    parsed.outlineExtentZ=Math.abs(parsed.sin)*extentX+Math.abs(parsed.cos)*extentZ+8;
  }
  return parsed;
}

function parseEntryType(value, path) {
  const type = String(value).toLowerCase();
  if(type==='outlined_island')return 'island';
  if (type === "island" || type === "ocean" || type === "archipelago") return type;
  throw new Error(`${path}.type must be one of island, outlined_island, ocean, archipelago`);
}

function parseCoast(entry,path,type){
  if(!Object.hasOwn(entry,'coast'))return null;
  const c=entry.coast;
  if(type==='ocean'||!c||typeof c!=='object'||Array.isArray(c))throw new Error(`${path}.coast requires a land object and both block widths`);
  for(const key of ['beach_width_blocks','shallow_ocean_width_blocks'])if(!Number.isInteger(c[key])||c[key]<0||c[key]>4096)throw new Error(`${path}.coast.${key} must be an integer between 0 and 4096`);
  return {beach_width_blocks:c.beach_width_blocks,shallow_ocean_width_blocks:c.shallow_ocean_width_blocks};
}
function rawCoastInfo(config,compiled,x,z){
  const value=sampleRawMask(config,compiled,x,z);let owner=null,strongest=0;
  for(const shape of shapesNear(compiled,'land',x,z)){const v=sampleIsland(shape,x,z);if(v>strongest){strongest=v;owner=shape;}}
  const ix=Math.floor(x/4),iz=Math.floor(z/4),fx=x/4-ix,fz=z/4-iz;let best=0,overlay=null;
  for(let dz=0;dz<2;dz++)for(let dx=0;dx<2;dx++){
    const bx=(ix+dx)*4,bz=(iz+dz)*4;let influence=0,nodeOwner=null;
    for(const shape of compiled.outlines){const px=bx-shape.centerX,pz=bz-shape.centerZ;if(Math.abs(px)>shape.outlineExtentX||Math.abs(pz)>shape.outlineExtentZ)continue;
      const f=shape.outline.mask.field((px*shape.cos-pz*shape.sin)*shape.outlineScaleX,(px*shape.sin+pz*shape.cos)*shape.outlineScaleZ);
      influence*=1-f.alpha;if(f.alpha>=influence&&f.alpha>0){nodeOwner=shape;influence=f.alpha;}}
    if(compiled.paintedMap)influence*=1-(compiled.paintedMap.node(ix+dx,iz+dz)>>>16)/65535;
    const weight=(dx?fx:1-fx)*(dz?fz:1-fz);if(nodeOwner&&weight*influence>best){best=weight*influence;overlay=nodeOwner;}
  }
  if(overlay)owner=overlay;
  return {value,owner};
}
const COAST_RECOVERY=256;
function coastSmooth(t){t=clamp(t,0,1);return t*t*(3-2*t);}
function coastValue(sample,raw){
  const width=sample.distance>=0?sample.owner.coast.beach_width_blocks:sample.owner.coast.shallow_ocean_width_blocks;
  const progress=sample.terrainProgress??sample.distance/(width+COAST_RECOVERY);
  return .54+(raw-.54)*coastSmooth(Math.abs(progress));
}

class CoastField {
  constructor(raw,compiled){
    this.raw=raw;this.emptyTiles=new Set();this.deadline=Infinity;this.tiles=new Map();this.hints=new Map();this.bounds=[];this.landReach=COAST_RECOVERY;this.waterReach=COAST_RECOVERY;
    for(const shape of [...compiled.landShapes,...compiled.outlines])if(shape.coast){
      let ex,ez;if(shape.outline){ex=shape.outlineExtentX;ez=shape.outlineExtentZ;}
      else{const reach=shape.multiplier*(1+shape.noiseStrength)+shape.edgeWidth,rx=shape.xDivisor*reach,rz=shape.zDivisor*reach;ex=Math.abs(shape.cos)*rx+Math.abs(shape.sin)*rz+4;ez=Math.abs(shape.sin)*rx+Math.abs(shape.cos)*rz+4;}
      this.bounds.push({minX:shape.centerX-ex,minZ:shape.centerZ-ez,maxX:shape.centerX+ex,maxZ:shape.centerZ+ez});
      this.landReach=Math.max(this.landReach,shape.coast.beach_width_blocks+COAST_RECOVERY);this.waterReach=Math.max(this.waterReach,shape.coast.shallow_ocean_width_blocks+COAST_RECOVERY);
    }
  }
  remember(cache,key,value,max){cache.delete(key);cache.set(key,value);while(cache.size>max)cache.delete(cache.keys().next().value);return value;}
  distance(s,x,z){const dx=s.bx-s.ax,dz=s.bz-s.az,t=Math.max(0,Math.min(1,((x-s.ax)*dx+(z-s.az)*dz)/(dx*dx+dz*dz)));return Math.hypot(x-s.ax-t*dx,z-s.az-t*dz);}
  band(segment,land){return land?segment.owner.coast.beach_width_blocks:segment.owner.coast.shallow_ocean_width_blocks;}
  sample(x,z,raw){
    const land=raw.value>=.54;if(land&&!raw.owner?.coast)return null;
    const reach=land?this.landReach:this.waterReach,maxBand=reach-COAST_RECOVERY;let best=reach,bestScore=Infinity,bestDistance=reach,terrainScore=1;const key=`${Math.floor(x/64)}:${Math.floor(z/64)}`;let nearest=this.hints.get(key);
    if(nearest){const d=this.distance(nearest,x,z);const width=this.band(nearest,land);if(width>0&&d<=width){bestScore=d/width+1e-12;best=reach;}nearest=null;}
    let recovery=null,recoveryDistance=reach,recoveryProgress=Infinity;
    const seen=new Set(),candidates=[];
    for(const b of this.bounds){
      const minX=Math.floor(Math.max(b.minX,x-best)/64),maxX=Math.floor(Math.min(b.maxX,x+best)/64),minZ=Math.floor(Math.max(b.minZ,z-best)/64),maxZ=Math.floor(Math.min(b.maxZ,z+best)/64);
      for(let tz=minZ;tz<=maxZ;tz++)for(let tx=minX;tx<=maxX;tx++){
        const distance=Math.hypot(Math.max(0,tx*64-x,x-(tx+1)*64),Math.max(0,tz*64-z,z-(tz+1)*64)),id=`${tx}:${tz}`;
        if(distance<=best&&!seen.has(id)){seen.add(id);candidates.push({x:tx,z:tz,distance});}
      }
    }
    candidates.sort((a,b)=>a.distance-b.distance||a.z-b.z||a.x-b.x);
    for(const candidate of candidates){if(candidate.distance>best)break;for(const segment of this.tile(candidate.x,candidate.z)){const d=this.distance(segment,x,z),width=this.band(segment,land);terrainScore=Math.min(terrainScore,d/(width+COAST_RECOVERY));if(width>0&&d<=width){const score=d/width;if(score<bestScore){bestScore=score;best=Math.min(reach,Math.max(score*maxBand,terrainScore*reach)+1e-8);bestDistance=d;nearest=segment;}}else if(d<=width+COAST_RECOVERY&&d-width<recoveryProgress){recoveryProgress=d-width;recoveryDistance=d;recovery=segment;}}}
    if(!nearest){nearest=recovery;bestDistance=recoveryDistance;}
    if(nearest){this.remember(this.hints,key,nearest,1024);const limit=(land?nearest.owner.coast.beach_width_blocks:nearest.owner.coast.shallow_ocean_width_blocks)+COAST_RECOVERY;if(bestDistance<=limit)return {distance:land?bestDistance:-Math.max(1e-9,bestDistance),owner:nearest.owner,terrainProgress:land?terrainScore:-terrainScore};}
    return raw.owner?.coast?{distance:land?Infinity:-Infinity,owner:raw.owner}:null;
  }
  tile(tx,tz){
    const key=`${tx}:${tz}`;if(this.emptyTiles.has(key))return [];if(this.tiles.has(key)){const value=this.tiles.get(key);return this.remember(this.tiles,key,value,512);}
    if(performance.now()>this.deadline)throw COAST_YIELD;
    const nodes=[],segments=[];for(let z=0;z<=16;z++)for(let x=0;x<=16;x++)nodes.push(this.raw([tx*64+x*4,tz*64+z*4]));
    for(let z=0;z<16;z++)for(let x=0;x<16;x++){
      const bx=tx*64+x*4,bz=tz*64+z*4,a=nodes[z*17+x],b=nodes[z*17+x+1],c=nodes[(z+1)*17+x+1],d=nodes[(z+1)*17+x];
      this.triangle(segments,[bx,bz,a],[bx+4,bz,b],[bx+4,bz+4,c]);this.triangle(segments,[bx,bz,a],[bx+4,bz+4,c],[bx,bz+4,d]);
    }if(!segments.length){this.emptyTiles.add(key);if(this.emptyTiles.size>32768)this.emptyTiles.delete(this.emptyTiles.values().next().value);return segments;}return this.remember(this.tiles,key,segments,512);
  }
  triangle(output,...points){
    if(points.every(p=>p[2].value>=.54)||points.every(p=>p[2].value<.54))return;
    const crossings=[];for(let i=0;i<3;i++){const a=points[i],b=points[(i+1)%3];if((a[2].value>=.54)===(b[2].value>=.54))continue;
      const t=(.54-a[2].value)/(b[2].value-a[2].value);crossings.push([a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1])]);}
    const owner=points.find(p=>p[2].value>=.54)[2].owner;
    if(crossings.length===2&&owner?.coast&&Math.hypot(crossings[1][0]-crossings[0][0],crossings[1][1]-crossings[0][1])>1e-12)output.push({ax:crossings[0][0],az:crossings[0][1],bx:crossings[1][0],bz:crossings[1][1],owner});
  }
}

const COAST_YIELD={};
async function sampleMaskAsync(config,compiled,x,z,details,active,yieldWork){
  if(!compiled.coastField)return sampleMask(config,compiled,x,z,details);
  for(;;){
    if(!active())return null;
    compiled.coastField.deadline=performance.now()+8;
    try{return sampleMask(config,compiled,x,z,details);}catch(error){if(error!==COAST_YIELD)throw error;}
    finally{compiled.coastField.deadline=Infinity;}
    await yieldWork();
  }
}
function sampleMask(config,compiled,x,z,details){
  if(config.enabled===false)return 0;
  if(!compiled.coastField)return sampleRawMask(config,compiled,x,z);
  const raw=rawCoastInfo(config,compiled,x,z),coast=compiled.coastField.sample(x,z,raw);
  if(details&&coast){const d=coast.distance,c=coast.owner.coast;details.zone=d<0?(-d<=c.shallow_ocean_width_blocks?2:1):d<=c.beach_width_blocks&&c.beach_width_blocks>0?3:4;}
  return coast?coastValue(coast,raw.value):raw.value;
}
function sampleRawMask(config, compiled, blockX, blockZ) {
  if (config.enabled === false) return 0;
  let union = 0;
  let additive = 0;
  const landCandidates = shapesNear(compiled, "land", blockX, blockZ);
  for (const island of landCandidates) {
    if (!containsPoint(island, blockX, blockZ)) continue;
    const value = sampleIsland(island, blockX, blockZ);
    if (island.overlap) additive += value;
    else union = Math.max(union, value);
  }
  const land = Math.max(union, additive);
  if (land <= 0) {
    return applyOverlays(0,compiled,blockX,blockZ);
  }
  let ocean = 0;
  for (const oceanShape of shapesNear(compiled, "ocean", blockX, blockZ)) {
    if (!containsPoint(oceanShape, blockX, blockZ)) continue;
    ocean = Math.max(ocean, sampleIsland(oceanShape, blockX, blockZ));
  }
  const base=clamp(Math.min(land, 1 - ocean), 0, 1);
  return applyOverlays(base,compiled,blockX,blockZ);
}

function applyOverlays(base,compiled,x,z){
  if(!compiled.outlines.length)return compiled.paintedMap?compiled.paintedMap.apply(base,x,z):base;
  const ix=Math.floor(x/4),iz=Math.floor(z/4),fx=x/4-ix,fz=z/4-iz;let result=0;
  for(let dz=0;dz<2;dz++)for(let dx=0;dx<2;dx++){
    const bx=(ix+dx)*4,bz=(iz+dz)*4;let alpha=0,weighted=0;
    for(const shape of compiled.outlines){
      const px=bx-shape.centerX,pz=bz-shape.centerZ;if(Math.abs(px)>shape.outlineExtentX||Math.abs(pz)>shape.outlineExtentZ)continue;
      const field=shape.outline.mask.field((px*shape.cos-pz*shape.sin)*shape.outlineScaleX,(px*shape.sin+pz*shape.cos)*shape.outlineScaleZ);
      weighted=field.weightedValue+weighted*(1-field.alpha);alpha=field.alpha+alpha*(1-field.alpha);
    }
    if(compiled.paintedMap){const p=compiled.paintedMap.node(ix+dx,iz+dz),a=(p>>>16)/65535,v=(p&65535)/65535;weighted=a*v+weighted*(1-a);alpha=a+alpha*(1-a);}
    result+=(dx?fx:1-fx)*(dz?fz:1-fz)*(base*(1-alpha)+weighted);
  }return clamp(result,0,1);
}

function sampleIsland(island, blockX, blockZ) {
  const dx = blockX - island.centerX;
  const dz = blockZ - island.centerZ;
  const rotatedX = dx * island.cos - dz * island.sin;
  const rotatedZ = dx * island.sin + dz * island.cos;
  const normalizedX = rotatedX / island.xDivisor;
  const normalizedZ = rotatedZ / island.zDivisor;
  const distance = superellipseDistance(normalizedX, normalizedZ, island.shapePower ?? DEFAULT_SHAPE_POWER);
  if(distance>island.multiplier*(1+island.noiseStrength)+island.edgeWidth)return 0;
  const edgeNoise = normalizedNoise(island, normalizedX * island.noise.scale, normalizedZ * island.noise.scale) * island.noiseStrength;
  const field = island.multiplier * (1 + edgeNoise) - distance;
  return smoothstep(-island.edgeWidth, island.edgeWidth, field);
}

function normalizedNoise(island, x, z) {
  let sum = 0;
  let amplitudeSum = 0;
  let frequency = 2 ** island.noise.firstOctave;
  for (const amplitude of island.noise.amplitudes) {
    sum += interpolatedValueNoise(island, x * frequency, z * frequency) * amplitude;
    amplitudeSum += amplitude;
    frequency *= 2;
  }
  return amplitudeSum === 0 ? 0 : sum / amplitudeSum;
}

function interpolatedValueNoise(island, x, z) {
  const x0 = fastFloor(x);
  const z0 = fastFloor(z);
  const tx = smoothFraction(x - x0);
  const tz = smoothFraction(z - z0);
  const a = valueNoise(island, x0, z0);
  const b = valueNoise(island, x0 + 1, z0);
  const c = valueNoise(island, x0, z0 + 1);
  const d = valueNoise(island, x0 + 1, z0 + 1);
  return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
}

function valueNoise(island, x, z) { return exactValueNoise(island,x,z); }

function exactValueNoise(island, x, z) {
  const key = `${x},${z}`;
  const cached = island.exactNoiseCache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  if (island.exactNoiseCache.size > 60000) {
    island.exactNoiseCache.clear();
  }

  let mixed = island.seed;
  mixed = mix(mixed, BigInt(x) * 341873128712n);
  mixed = mix(mixed, BigInt(z) * 132897987541n);
  const unsigned = BigInt.asUintN(64, mixed);
  const top53 = Number(unsigned >> 11n);
  const value = top53 * 2 ** -53 * 2 - 1;
  island.exactNoiseCache.set(key, value);
  return value;
}

function compileArchipelago(entry, seed) {
  const children = [];
  const placed = [];
  const baseSeed = stableStringSeed(entry.noise.seed);
  const parentRadians = entry.rotation * Math.PI / 180;
  const parentCos = Math.cos(parentRadians);
  const parentSin = Math.sin(parentRadians);

  for (let index = 0; index < entry.count; index++) {
    let accepted = false;
    for (let attempt = 0; attempt < 64; attempt++) {
      const attemptSeed = mix(baseSeed, BigInt(index * 4099 + attempt * 131));
      const angle = randomUnit(attemptSeed, 1n) * Math.PI * 2;
      const distance = Math.sqrt(randomUnit(attemptSeed, 2n)) * entry.spread;
      const localX = Math.cos(angle) * distance * entry.xDivisor;
      const localZ = Math.sin(angle) * distance * entry.zDivisor;
      const centerX = entry.centerX + localX * parentCos - localZ * parentSin;
      const centerZ = entry.centerZ + localX * parentSin + localZ * parentCos;
      const radius = lerp(entry.minRadius, entry.maxRadius, randomUnit(attemptSeed, 3n));
      const stretch = lerp(entry.minStretch, entry.maxStretch, randomUnit(attemptSeed, 4n));
      const stretchX = randomUnit(attemptSeed, 5n) < 0.5;
      const xDivisor = stretchX ? radius * stretch : radius;
      const zDivisor = stretchX ? radius : radius * stretch;
      const rotation = randomUnit(attemptSeed, 6n) * 360;
      const shapePower = lerp(entry.minShapePower, entry.maxShapePower, randomUnit(attemptSeed, 7n));
      const approximateRadius = Math.max(xDivisor, zDivisor);

      if (!hasSpacingConflict(placed, centerX, centerZ, approximateRadius, entry.spacing)) {
        const noiseSeed = `${entry.noise.seed}_${index + 1}`;
        const radians = rotation * Math.PI / 180;
        children.push({
          type: "island",
          name: `${entry.name} ${index + 1}`,
          overlap: entry.overlap,
          coast:entry.coast,
          temperature:entry.temperature,
          excludedBiomes:entry.excludedBiomes,
          centerX,
          centerZ,
          xDivisor,
          zDivisor,
          rotation,
          cos: Math.cos(radians),
          sin: Math.sin(radians),
          shapePower,
          multiplier: entry.multiplier,
          noiseStrength: entry.noiseStrength,
          edgeWidth: entry.edgeWidth,
          noise: { ...entry.noise, seed: noiseSeed },
          seed: mix(0n, stableStringSeed(noiseSeed)),

          exactNoiseCache: new Map(),
        });
        attachBounds(children[children.length - 1]);
        placed.push({ centerX, centerZ, radius: approximateRadius });
        accepted = true;
        break;
      }
    }
    if (!accepted) return children;
  }
  return children;
}

function attachBounds(shape) {
  const reach = Math.max(0.1, shape.multiplier * (1 + shape.noiseStrength) + shape.edgeWidth + 0.25);
  const rx = shape.xDivisor * reach;
  const rz = shape.zDivisor * reach;
  const extentX = Math.abs(shape.cos) * rx + Math.abs(shape.sin) * rz;
  const extentZ = Math.abs(shape.sin) * rx + Math.abs(shape.cos) * rz;
  shape.bounds = {
    minX: shape.centerX - extentX,
    maxX: shape.centerX + extentX,
    minZ: shape.centerZ - extentZ,
    maxZ: shape.centerZ + extentZ,
  };
  return shape;
}

function buildSpatialGrid(shapes) {
  const grid = new Map();
  grid.large=[];
  for (const shape of shapes) {
    const bounds = shape.bounds || attachBounds(shape).bounds;
    const minCellX = Math.floor(bounds.minX / SPATIAL_CELL_SIZE);
    const maxCellX = Math.floor(bounds.maxX / SPATIAL_CELL_SIZE);
    const minCellZ = Math.floor(bounds.minZ / SPATIAL_CELL_SIZE);
    const maxCellZ = Math.floor(bounds.maxZ / SPATIAL_CELL_SIZE);
    if ((maxCellX-minCellX+1)*(maxCellZ-minCellZ+1)>4096) {grid.large.push(shape);continue;}
    for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
      for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
        const key = `${cellX},${cellZ}`;
        let bucket = grid.get(key);
        if (!bucket) {
          bucket = [];
          grid.set(key, bucket);
        }
        bucket.push(shape);
      }
    }
  }
  return grid;
}

function shapesNear(compiledShapes, kind, blockX, blockZ) {
  const grid = kind === "ocean" ? compiledShapes.oceanGrid : compiledShapes.landGrid;
  const fallback = kind === "ocean" ? compiledShapes.oceanShapes || [] : compiledShapes.landShapes || compiledShapes;
  if (!grid) {
    return fallback;
  }
  const bucket = grid.get(`${Math.floor(blockX / SPATIAL_CELL_SIZE)},${Math.floor(blockZ / SPATIAL_CELL_SIZE)}`);
  if (!bucket || bucket.length === 0) {
    return grid.large || [];
  }
  return grid.large?.length ? bucket.concat(grid.large) : bucket;
}

function containsPoint(shape, blockX, blockZ) {
  const bounds = shape.bounds;
  return !bounds || blockX >= bounds.minX && blockX <= bounds.maxX && blockZ >= bounds.minZ && blockZ <= bounds.maxZ;
}

function hasSpacingConflict(placed, centerX, centerZ, radius, spacing) {
  return placed.some((child) => {
    const dx = centerX - child.centerX;
    const dz = centerZ - child.centerZ;
    const minDistance = (radius + child.radius) * spacing;
    return dx * dx + dz * dz < minDistance * minDistance;
  });
}

function parseSeed(value) {
  const text=String(value??"").replace(/^[\x00-\x20]+|[\x00-\x20]+$/g,"");
  if (!text) return null;
  const sign=text[0]==="-"?"-":"";
  const start=text[0]==="-"||text[0]==="+"?1:0;
  let decimal="",numeric=start<text.length;
  for(let i=start;i<text.length&&numeric;i++){
    const c=text[i],code=text.charCodeAt(i);
    if(code>=48&&code<=57)decimal+=c;
    else if(/\p{Decimal_Number}/u.test(c)){
      let zero=code;while(zero>0&&/\p{Decimal_Number}/u.test(String.fromCharCode(zero-1)))zero--;
      decimal+=String((code-zero)%10);
    }else numeric=false;
  }
  if(numeric){
    decimal=decimal.replace(/^0+/,"")||"0";
    if(decimal.length<=19){const number=BigInt(sign+decimal);if(number>=-(1n<<63n)&&number<=(1n<<63n)-1n)return number;}
  }
  let hash=0;
  for(let i=0;i<text.length;i++) hash=(Math.imul(hash,31)+text.charCodeAt(i))|0;
  return BigInt(hash);
}

function finiteNumber(value, path) {
  if (typeof value !== "number") throw new Error(`${path} must be a number`);
  const number = value;
  if (!Number.isFinite(number)) throw new Error(`${path} must be a number`);
  return number;
}

function positiveNumber(value, fallback, path) {
  if (value === undefined || value === null) return fallback;
  const number = finiteNumber(value, path);
  if (number <= 0) throw new Error(`${path} must be positive`);
  return number;
}

function rangeNumber(value, fallback, min, max, path) {
  if (value === undefined || value === null) return fallback;
  const number = finiteNumber(value, path);
  if (number < min || number > max) throw new Error(`${path} must be between ${min} and ${max}`);
  return number;
}

function integerNumber(value, fallback, path) {
  if (value === undefined || value === null) return fallback;
  const number = finiteNumber(value, path);
  if (number !== Math.round(number)) throw new Error(`${path} must be an integer`);
  if (number < -2147483648 || number > 2147483647) throw new Error(`${path} must fit a Java int`);
  return number;
}

function positiveInteger(value, fallback, path) {
  const number = integerNumber(value, fallback, path);
  if (number <= 0) throw new Error(`${path} must be positive`);
  return number;
}

function stringValue(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== "string") throw new Error("Expected a string");
  return value;
}

function mix(seed, value) {
  let mixed = BigInt.asIntN(64, seed ^ value);
  mixed = BigInt.asIntN(64, mixed ^ (BigInt.asUintN(64, mixed) >> 33n));
  mixed = BigInt.asIntN(64, mixed * -49064778989728563n);
  mixed = BigInt.asIntN(64, mixed ^ (BigInt.asUintN(64, mixed) >> 33n));
  mixed = BigInt.asIntN(64, mixed * -4265267296055464877n);
  mixed = BigInt.asIntN(64, mixed ^ (BigInt.asUintN(64, mixed) >> 33n));
  return mixed;
}

function randomUnit(seed, salt) {
  const mixed = mix(seed, salt * 0x9e3779b97f4a7c15n);
  return Number(BigInt.asUintN(64, mixed) >> 11n) * 2 ** -53;
}

function stableStringSeed(value) {
  let hash = 1125899906842597n;
  for (let index = 0; index < value.length; index++) {
    hash = BigInt.asIntN(64, 31n * hash + BigInt(value.charCodeAt(index)));
  }
  return hash;
}

function fastFloor(value) {
  const floor = Math.trunc(value);
  return value < floor ? floor - 1 : floor;
}

function smoothFraction(value) {
  return value * value * value * (value * (value * 6 - 15) + 10);
}

function smoothstep(min, max, value) {
  const x = clamp((value - min) / (max - min), 0, 1);
  return x * x * (3 - 2 * x);
}

function superellipseDistance(x, z, power) {
  return (Math.abs(x) ** power + Math.abs(z) ** power) ** (1 / power);
}

function lerp(start, end, delta) {
  return start + (end - start) * delta;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}


const api={readDocument,parseConfig,parseSeed,sampleMask,sampleMaskAsync,sampleRawMask,rawCoastInfo,coastValue,sampleIsland,clamp,smoothstep,lerp,stableStringSeed,FULL_OCEAN_MASK,LAND_MASK,BEACH_START_MASK,DEEP_OCEAN_MASK};
root.WgeMask=api;
if(typeof module!=="undefined") module.exports=api;
})(globalThis);
