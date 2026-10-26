/* Portable sparse mask format, shared by the renderer and brush worker. */
(function(root){
  const STEP=4,SIZE=64,MAX_TILES=4096;
  const integer=(n,min,max)=>{if(!Number.isInteger(n)||n<min||n>max)throw new Error('Invalid painted_map integer');return n;};
  class Grid {
    constructor(input={version:1,step:STEP,size:SIZE,tiles:[]}){
      if(input?.version!==1||input.step!==STEP||input.size!==SIZE||!Array.isArray(input.tiles)||input.tiles.length>MAX_TILES)throw new Error('Unsupported painted_map format');
      this.tiles=new Map();
      for(const tile of input.tiles){
        const x=integer(tile.x,-117188,117187),z=integer(tile.z,-117188,117187),key=`${x}:${z}`;
        if(this.tiles.has(key)||!Array.isArray(tile.runs)||!tile.runs.length||tile.runs.length%3||tile.runs.length>SIZE*SIZE*3)throw new Error('Invalid or duplicate painted_map tile');
        const data=new Uint32Array(SIZE*SIZE);let offset=0;
        for(let i=0;i<tile.runs.length;i+=3){
          const count=integer(tile.runs[i],1,SIZE*SIZE),alpha=integer(tile.runs[i+1],0,65535),value=integer(tile.runs[i+2],0,65535);
          if(count>data.length-offset)throw new Error('painted_map run overflow');
          data.fill(((alpha<<16)|value)>>>0,offset,offset+count);offset+=count;
        }
        if(offset!==data.length)throw new Error('Incomplete painted_map tile');this.tiles.set(key,data);
      }
    }
    node(x,z){const tx=Math.floor(x/SIZE),tz=Math.floor(z/SIZE);return this.tiles.get(`${tx}:${tz}`)?.[(z-tz*SIZE)*SIZE+x-tx*SIZE]??0;}
    field(x,z){
      const gx=x/STEP,gz=z/STEP,ix=Math.floor(gx),iz=Math.floor(gz),fx=gx-ix,fz=gz-iz;let alpha=0,weightedValue=0;
      for(let dz=0;dz<2;dz++)for(let dx=0;dx<2;dx++){
        const p=this.node(ix+dx,iz+dz),weight=(dx?fx:1-fx)*(dz?fz:1-fz),a=(p>>>16)/65535;
        alpha+=weight*a;weightedValue+=weight*a*(p&65535)/65535;
      }return {alpha,weightedValue};
    }
    bounds(){
      let minX=Infinity,minZ=Infinity,maxX=-Infinity,maxZ=-Infinity;
      for(const [key,data]of this.tiles){const [tx,tz]=key.split(':').map(Number);
        for(let i=0;i<data.length;i++)if(data[i]>>>16){const x=(tx*SIZE+i%SIZE)*STEP,z=(tz*SIZE+Math.floor(i/SIZE))*STEP;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minZ=Math.min(minZ,z);maxZ=Math.max(maxZ,z);}}
      return minX===Infinity?null:{minX,minZ,maxX,maxZ};
    }
    apply(base,x,z){
      const gx=x/STEP,gz=z/STEP,ix=Math.floor(gx),iz=Math.floor(gz),fx=gx-ix,fz=gz-iz;let result=0;
      for(let dz=0;dz<2;dz++)for(let dx=0;dx<2;dx++){
        const p=this.node(ix+dx,iz+dz),a=(p>>>16)/65535,v=(p&65535)/65535;
        result+=(dx?fx:1-fx)*(dz?fz:1-fz)*(base+(v-base)*a);
      }return result;
    }
    toJSON(){
      const tiles=[];
      for(const [key,data] of this.tiles){
        if(!data.some(p=>p>>>16))continue;
        const [x,z]=key.split(':').map(Number),runs=[];
        for(let i=0;i<data.length;){let end=i+1;while(end<data.length&&data[end]===data[i])end++;runs.push(end-i,data[i]>>>16,data[i]&65535);i=end;}
        tiles.push({x,z,runs});
      }return {version:1,step:STEP,size:SIZE,tiles};
    }
  }
  root.WgePaintedMap={Grid,STEP,SIZE,MAX_TILES};
  if(typeof module!=='undefined')module.exports=root.WgePaintedMap;
})(globalThis);
