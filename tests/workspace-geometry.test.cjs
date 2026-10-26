const {test}=require('node:test'),assert=require('node:assert/strict');
const {geometry,bounds,hit}=require('../workspace-geometry.js');

test('selection rectangles stay aligned with world axes and enclose rotated island coordinates',()=>{
 for(const rotation of [-150,-90,-28,0,45,90,135]){
  const entry={x:1600,z:-1350,radius_x:420,radius_z:240,stretch_x:1.4,rotation,roughness:.2,shore_width:.16};
  const b=bounds(entry),g=geometry(entry),angle=-rotation*Math.PI/180;
  for(let i=0;i<32;i++){
   const a=i*Math.PI/16,rx=g.rx*Math.cos(a),rz=g.rz*Math.sin(a),p={x:g.x+rx*Math.cos(angle)-rz*Math.sin(angle),z:g.z+rx*Math.sin(angle)+rz*Math.cos(angle)};
   assert.ok(p.x>=b.minX&&p.x<=b.maxX&&p.z>=b.minZ&&p.z<=b.maxZ);
   assert.ok(hit(entry,p),'hit-test must use the generation rotation direction');
  }
 }
});
