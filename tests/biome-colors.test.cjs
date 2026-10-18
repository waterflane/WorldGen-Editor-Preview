const {test}=require('node:test');
const assert=require('node:assert/strict');
const {biomeColor,vanilla}=require('../biome-colors.js');

// Registry names extracted from data/minecraft/worldgen/biome in the prepared 1.21.1 server jar.
const registry=`badlands bamboo_jungle basalt_deltas beach birch_forest cherry_grove cold_ocean crimson_forest dark_forest deep_cold_ocean deep_dark deep_frozen_ocean deep_lukewarm_ocean deep_ocean desert dripstone_caves end_barrens end_highlands end_midlands eroded_badlands flower_forest forest frozen_ocean frozen_peaks frozen_river grove ice_spikes jagged_peaks jungle lukewarm_ocean lush_caves mangrove_swamp meadow mushroom_fields nether_wastes ocean old_growth_birch_forest old_growth_pine_taiga old_growth_spruce_taiga plains river savanna savanna_plateau small_end_islands snowy_beach snowy_plains snowy_slopes snowy_taiga soul_sand_valley sparse_jungle stony_peaks stony_shore sunflower_plains swamp taiga the_end the_void warm_ocean warped_forest windswept_forest windswept_gravelly_hills windswept_hills windswept_savanna wooded_badlands`.split(' ').map(id=>'minecraft:'+id);

test('every 1.21.1 biome has a distinct explicit color',()=>{
 assert.deepEqual(Object.keys(vanilla).sort(),registry.sort());
 assert.equal(new Set(registry.map(id=>biomeColor(id).join(','))).size,64);
 for(const id of registry){
  const rgb=biomeColor(id);assert.equal(rgb.length,3);
  assert.ok(rgb.every(c=>Number.isInteger(c)&&c>=0&&c<=255));
 }
});

test('cherry groves are pink; frozen oceans, caves and forest variants remain distinct',()=>{
 const cherry=biomeColor('minecraft:cherry_grove');assert.ok(cherry[0]>cherry[1]+40&&cherry[2]>cherry[1]);
 for(const ids of [['grove','cherry_grove','snowy_plains'],['deep_ocean','deep_frozen_ocean','frozen_ocean'],
  ['forest','flower_forest','dark_forest'],['lush_caves','dripstone_caves','deep_dark']])
  assert.equal(new Set(ids.map(id=>biomeColor('minecraft:'+id).join(','))).size,ids.length);
});

test('unknown registry IDs have reproducible saturated colors, independent of registry ordering',()=>{
 const id='example:cherry_grove',expected=[...biomeColor(id)];
 for(let i=0;i<1000;i++){
  const c=biomeColor('another_mod:biome_'+i);
  assert.ok(Math.max(...c)-Math.min(...c)>60,'unknown biomes must not collapse to white/gray');
 }
 assert.deepEqual(biomeColor(id),expected,'cache eviction cannot change a biome color');
 assert.notDeepEqual(biomeColor(id),biomeColor('minecraft:cherry_grove'));
 assert.notDeepEqual(biomeColor(id),biomeColor('different_mod:cherry_grove'));
 assert.deepEqual(biomeColor(undefined),[48,53,60],'missing data stays neutral');
});
