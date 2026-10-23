/* Small world-space images stay available to the UI while generation is paused. */
(function(root){
  function create(makeImage,limit=8192){
    const tiles=new Map();
    return {
      clear(){tiles.clear();},
      size(){return tiles.size;},
      remember(batch,replace=false){
        for(const tile of batch||[]){
          const key=`${tile.step}:${tile.x}:${tile.z}`;
          if(tiles.has(key)&&!replace)continue;
          tiles.delete(key);
          const {x,z,step,size}=tile;
          tiles.set(key,{x,z,step,size,image:makeImage(tile)});
          while(tiles.size>limit)tiles.delete(tiles.keys().next().value);
        }
      },
      draw(context,view,width,height){
        const left=view.x-width/2*view.blocksPerPixel,top=view.z-height/2*view.blocksPerPixel;
        const right=left+width*view.blocksPerPixel,bottom=top+height*view.blocksPerPixel;
        const visible=[...tiles.entries()].filter(([,t])=>{
          const span=t.size*t.step;
          return t.x<right&&t.x+span>left&&t.z<bottom&&t.z+span>top;
        }).sort((a,b)=>b[1].step-a[1].step);
        context.imageSmoothingEnabled=false;
        for(const [key,t] of visible){
          const span=t.size*t.step;
          // Round shared edges together to avoid seams at fractional zoom levels.
          const x=Math.round((t.x-left)/view.blocksPerPixel),z=Math.round((t.z-top)/view.blocksPerPixel);
          const x1=Math.round((t.x+span-left)/view.blocksPerPixel),z1=Math.round((t.z+span-top)/view.blocksPerPixel);
          context.drawImage(t.image,x,z,x1-x,z1-z);
          tiles.delete(key);tiles.set(key,t);
        }
        return visible.length;
      }
    };
  }
  root.WgeTileCache={create};
  if(typeof module!=="undefined")module.exports=root.WgeTileCache;
})(globalThis);
