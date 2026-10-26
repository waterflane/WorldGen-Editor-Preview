/* Geometry for axis-aligned selection guides. Generation uses the shared mask implementation. */
(function(root){
  function geometry(entry){
    return {x:entry.x??entry.center_x,z:entry.z??entry.center_z,
      rx:(entry.radius_x??entry.x_divisor??entry.radius??entry.size)*(entry.stretch_x??1),
      rz:(entry.radius_z??entry.z_divisor??entry.radius??entry.size)*(entry.stretch_z??1),rotation:entry.rotation??entry.rotation_degrees??0};
  }
  function bounds(entry){
    const g=geometry(entry),a=g.rotation*Math.PI/180;
    const reach=entry.outline?(entry.multiplier??1)*Math.max(1+4/entry.outline.radius_x,1+4/entry.outline.radius_z):(entry.multiplier??entry.size_multiplier??1)*(1+(entry.roughness??entry.noise_strength??.18))+(entry.shore_width??entry.edge_width??.16);
    const ex=(Math.abs(Math.cos(a))*g.rx+Math.abs(Math.sin(a))*g.rz)*reach;
    const ez=(Math.abs(Math.sin(a))*g.rx+Math.abs(Math.cos(a))*g.rz)*reach;
    return {minX:g.x-ex,maxX:g.x+ex,minZ:g.z-ez,maxZ:g.z+ez};
  }
  function hit(entry,point){
    if(entry.outline){const b=bounds(entry);return point.x>=b.minX&&point.x<=b.maxX&&point.z>=b.minZ&&point.z<=b.maxZ;}
    const g=geometry(entry),a=g.rotation*Math.PI/180,dx=point.x-g.x,dz=point.z-g.z;
    const x=(dx*Math.cos(a)-dz*Math.sin(a))/g.rx,z=(dx*Math.sin(a)+dz*Math.cos(a))/g.rz;
    const power=entry.shape_power??2,reach=(entry.multiplier??entry.size_multiplier??1)*(1+(entry.roughness??entry.noise_strength??.18));
    return (Math.abs(x)**power+Math.abs(z)**power)**(1/power)<=reach;
  }
  root.WgeWorkspaceGeometry={geometry,bounds,hit};
  if(typeof module!=='undefined')module.exports=root.WgeWorkspaceGeometry;
})(globalThis);
