importScripts('climate-options.js','painted-map.js','mask-core.js','document-format.js');
self.onmessage=({data})=>{
  try{self.postMessage({id:data.id,...WgeDocument.prepare(data.text,data.seed)});}
  catch(error){self.postMessage({id:data.id,error:error.message});}
};
