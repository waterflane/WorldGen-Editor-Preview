/* Cartographic colors, keyed by exact registry ID rather than name fragments. */
(function(root){
  const colors={
    plains:"8fba63",sunflower_plains:"c6ce58",meadow:"79ba91",
    forest:"3d8748",flower_forest:"8caa80",birch_forest:"88b76b",old_growth_birch_forest:"65a77c",dark_forest:"305b49",
    cherry_grove:"db91b2",grove:"92b8ac",
    taiga:"4d8a79",old_growth_pine_taiga:"697d43",old_growth_spruce_taiga:"3a6b65",snowy_taiga:"a0c5c0",
    jungle:"278840",sparse_jungle:"6fa343",bamboo_jungle:"63b760",
    swamp:"657c42",mangrove_swamp:"387665",
    desert:"e9cf83",badlands:"be7149",eroded_badlands:"df955b",wooded_badlands:"967b41",
    savanna:"b8b75b",savanna_plateau:"a69b48",windswept_savanna:"c4a97b",
    windswept_hills:"8d9b81",windswept_gravelly_hills:"aaa49a",windswept_forest:"5f8666",
    stony_peaks:"9297a4",jagged_peaks:"b6c6d6",frozen_peaks:"b0d8e6",snowy_slopes:"d4dce9",
    snowy_plains:"dce9e5",ice_spikes:"8fc8e4",
    beach:"e8d999",snowy_beach:"c2d7d8",stony_shore:"8b999e",
    river:"3d95d5",frozen_river:"85c5e2",
    ocean:"286da1",deep_ocean:"193e68",cold_ocean:"417eac",deep_cold_ocean:"294e7e",
    frozen_ocean:"8cb9ca",deep_frozen_ocean:"587e9e",lukewarm_ocean:"238baf",deep_lukewarm_ocean:"216081",warm_ocean:"36b5bb",
    mushroom_fields:"af6ba5",lush_caves:"6eae73",dripstone_caves:"a5896b",deep_dark:"3e5165",
    nether_wastes:"a95348",crimson_forest:"962f50",warped_forest:"309b98",soul_sand_valley:"8e7770",basalt_deltas:"5a5965",
    the_end:"cfc58f",end_highlands:"b6b475",end_midlands:"a19c72",end_barrens:"88816b",small_end_islands:"d9ceac",the_void:"665a7c"
  };
  const vanilla=Object.freeze(Object.fromEntries(Object.entries(colors).map(([id,hex])=>[
    `minecraft:${id}`,Object.freeze([0,2,4].map(i=>parseInt(hex.slice(i,i+2),16)))
  ])));
  const fallback=new Map();
  function biomeColor(id){
    if(typeof id!=="string"||!id)return [48,53,60];
    const known=vanilla[id.includes(":")?id:`minecraft:${id}`];
    if(known)return known;
    if(fallback.has(id))return fallback.get(id);
    // Include the namespace: unrelated mods with the same path need independent colors.
    let hash=2166136261;
    for(let i=0;i<id.length;i++)hash=Math.imul(hash^id.charCodeAt(i),16777619)>>>0;
    const hue=hash%360,saturation=.55+((hash>>>9)%20)/100,lightness=.46+((hash>>>17)%15)/100;
    const a=saturation*Math.min(lightness,1-lightness);
    const color=Object.freeze([0,8,4].map(n=>{
      const k=(n+hue/30)%12;
      return Math.round(255*(lightness-a*Math.max(-1,Math.min(k-3,9-k,1))));
    }));
    fallback.set(id,color);
    if(fallback.size>512)fallback.delete(fallback.keys().next().value);
    return color;
  }
  root.WgeBiomeColors={biomeColor,vanilla};
  if(typeof module!=="undefined")module.exports=root.WgeBiomeColors;
})(globalThis);
