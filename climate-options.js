/* Stable climate IDs shared by documents, workers and profile catalogs. */
(function(root){
  const choices=[['standard','Default','Minecraft'],['natural','Natural','Minecraft'],['cold','Cold','Minecraft'],['temperate','Temperate','Minecraft'],['warm','Warm','Minecraft'],
    ['minecraft:mushroom','Mushroom','Minecraft'],['biomesoplenty:mushroom','Mushroom','Biomes O’ Plenty'],['biomesoplenty:magical','Magical','Biomes O’ Plenty'],
    ['biomesoplenty:haunted','Haunted','Biomes O’ Plenty'],['biomesoplenty:volcanic','Volcanic','Biomes O’ Plenty'],['biomesoplenty:wasteland','Wasteland','Biomes O’ Plenty'],
    ['terralith:mushroom','Mushroom','Terralith'],['terralith:mystical','Mystical','Terralith'],['terralith:volcanic','Volcanic','Terralith']].map(([id,name,source])=>({id,name,source}));
  const ids=new Set(choices.map(c=>c.id));
  function valid(value){return typeof value==='string'&&ids.has(value);}
  function extended(value){return String(value).toLowerCase()==='natural'||String(value).includes(':');}
  function modern(config){return config?.temperature!=null&&!['standard','auto','vanilla','standart'].includes(config.temperature)||config?.entries?.some(e=>extended(e.temperature??e.climate));}
  function inferred(config){return config&&Object.hasOwn(config,'temperature')||config?.entries?.some(e=>extended(e.temperature));}
  root.WgeClimate={choices,valid,modern,inferred};if(typeof module!=='undefined')module.exports=root.WgeClimate;
})(globalThis);
