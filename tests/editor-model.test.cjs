const {test}=require('node:test'),assert=require('node:assert/strict');
const {Model,validate}=require('../editor-model.js');
const blank=()=>({enabled:true,entries:[]});
async function stroke(model,tool,points,roughness=0){model.begin({tool,radius:32,roughness});for(const [x,z] of points)await model.point(x,z);model.end();}
test('last stroke wins in both directions; undo/redo restore entire strokes',async()=>{
 const m=new Model(blank());await stroke(m,'land',[[0,0],[128,0]]);
 assert.equal(m.grid.apply(0,64,0),1);
 await stroke(m,'ocean',[[64,0]]);assert.equal(m.grid.apply(0,64,0),0);
 m.history();assert.equal(m.grid.apply(0,64,0),1);
 m.history(true);assert.equal(m.grid.apply(0,64,0),0);
 await stroke(m,'land',[[64,0]]);assert.equal(m.grid.apply(0,64,0),1);
 assert.equal(m.undoStack.length,3);
});
test('continuous capsule strokes are independent of pointer event frequency',async()=>{
 const a=new Model(blank()),b=new Model(blank());
 await stroke(a,'land',[[-80,-16],[80,-16]],.5);
 await stroke(b,'land',[[-80,-16],[-40,-16],[0,-16],[40,-16],[80,-16]],.5);
 assert.deepEqual(a.grid.toJSON(),b.grid.toJSON());
});
test('cancel rolls back pending stroke and project roundtrip retains seed, view and procedural base',async()=>{
 const m=new Model({entries:[{x:100,z:200,radius:80}]},'+123');
 m.begin({tool:'land',radius:16});await m.point(-257,-257);const affected=m.cancel();
 assert.ok(affected.length);assert.equal(m.grid.tiles.size,0);assert.equal(m.undoStack.length,0);
 await stroke(m,'land',[[-257,-257]]);
 const view={x:-257,z:-257,blocksPerPixel:2},project=m.project(view),copy=new Model(project);
 assert.equal(copy.seed,'123');assert.deepEqual(copy.editor.view,view);
 assert.deepEqual(copy.preset(),m.preset());assert.equal(copy.undoStack.length,0);
 assert.throws(()=>validate({...project,version:2}));assert.throws(()=>validate({...project,editor:{radius:Infinity}}));
 assert.throws(()=>validate({format:'future-map-project',version:1,config:{entries:[]}}));
});

test('brush settings persist without painting or creating an undo action',()=>{
 const model=new Model(blank());model.settings({radius:384,roughness:.8});
 const copy=new Model(model.project({x:0,z:0,blocksPerPixel:4}));
 assert.equal(copy.editor.radius,384);assert.equal(copy.editor.roughness,.8);
 assert.equal(model.revision,0);assert.equal(model.undoStack.length,0);
 assert.throws(()=>model.settings({radius:Infinity,roughness:.2}));
 assert.equal(model.editor.radius,384);
});

test('map name survives project and preset export independently of its filename',()=>{
 const model=new Model(blank());model.rename('  Hidden Coast  ');
 const project=model.project({x:0,z:0,blocksPerPixel:4}),copy=new Model(project);
 assert.equal(project.name,'Hidden Coast');assert.equal(project.config.name,'Hidden Coast');
 assert.equal(copy.preset().name,'Hidden Coast');assert.equal(model.revision,1);
 assert.throws(()=>model.rename(''));assert.throws(()=>model.rename('bad\nname'));
 assert.equal(model.config.name,'Hidden Coast');
});

test('ocean temperature persists without changing paint and joins the shared undo history',async()=>{
 const model=new Model(blank(),'2');await stroke(model,'land',[[-257,-257],[16,16]]);
 const paint=model.grid.toJSON(),history=model.undoStack.length;
 for(const value of ['temperate','cold','warm','']){
  const revision=model.revision;model.oceanTemperature(value);assert.equal(model.revision,revision+1);
  assert.equal(model.config.ocean_temperature,value||undefined);
  assert.deepEqual(new Model(model.project({x:0,z:0,blocksPerPixel:4})).preset(),model.preset());
  assert.deepEqual(model.grid.toJSON(),paint);assert.equal(model.undoStack.filter(item=>item.kind!=='document').length,history);
 }
 assert.equal(Object.hasOwn(model.preset(),'ocean_temperature'),false);
 const before=model.preset();assert.throws(()=>model.oceanTemperature('auto'));assert.deepEqual(model.preset(),before);
 for(const ocean_temperature of [null,{},true,2,'standard','hot','WARM'])assert.throws(()=>validate({...blank(),ocean_temperature}));
});

test('mixed object, parameter and brush operations undo and redo in one chronological history',async()=>{
 const model=new Model(blank(),'2'),index=model.addEntry('island',100,-200),initial=model.preset();
 await stroke(model,'land',[[600,600]]);const painted=model.grid.toJSON();
 model.changeEntry(index,{x:-512,z:256,temperature:'warm',rotation:45});const changed=model.preset();
 model.rename('Coast Study');model.oceanTemperature('cold');
 model.history();assert.equal(model.config.ocean_temperature,undefined);
 model.history();assert.deepEqual(model.preset(),changed);
 model.history();assert.equal(model.config.entries[0].x,100);assert.deepEqual(model.grid.toJSON(),painted);
 model.history();assert.deepEqual(model.preset(),initial);
 model.history();assert.equal(model.config.entries.length,0);
 for(let i=0;i<5;i++)model.history(true);
 assert.equal(model.config.name,'Coast Study');assert.equal(model.config.ocean_temperature,'cold');assert.equal(model.config.entries[0].x,-512);assert.deepEqual(model.grid.toJSON(),painted);
 const before=model.preset(),count=model.undoStack.length;
 assert.throws(()=>model.changeEntry(0,{radius_x:-1}));assert.deepEqual(model.preset(),before);assert.equal(model.undoStack.length,count);
 const duplicate=model.duplicateEntry(0);assert.equal(duplicate,1);assert.equal(model.config.entries[1].x,-448);
 model.removeEntry(1);assert.equal(model.config.entries.length,1);model.history();assert.equal(model.config.entries.length,2);
});

test('legacy geometry aliases are replaced atomically and seed/source edits preserve painted data',async()=>{
 const model=new Model({entries:[{center_x:1,center_z:2,x_divisor:100,z_divisor:200,rotation_degrees:5}]},'2');
 await stroke(model,'land',[[600,600]]);const paint=model.grid.toJSON();
 model.changeEntry(0,{x:10,z:20,radius_x:300,radius_z:400,rotation:90});assert.equal(model.config.entries[0].center_x,undefined);assert.equal(model.config.entries[0].x_divisor,undefined);
 model.configure({...model.config,name:'Seed study'},'3');assert.equal(model.seed,'3');assert.deepEqual(model.grid.toJSON(),paint);
 model.history();assert.equal(model.seed,'2');assert.equal(model.config.entries[0].x,10);
});

test('a connected painted island is selectable across tile seams and moves as one undo action',async()=>{
 const model=new Model(blank(),'2');await stroke(model,'land',[[-257,-257],[-200,-257]]);await stroke(model,'land',[[600,600]]);
 const before=model.grid.toJSON(),selection=await model.selectPaint(-257,-257);
 assert.ok(selection.samples>0);assert.ok(selection.bounds.minX<-256&&selection.bounds.maxX>-256);
 assert.equal(await model.selectPaint(4000,4000),null);
 await model.selectPaint(-257,-257);const count=model.undoStack.length;
 model.transformPaint(512,256);assert.equal(model.undoStack.length,count+1);
 assert.equal(model.grid.apply(0,-257,-257),0);assert.equal(model.grid.apply(0,255,-1),1);assert.equal(model.grid.apply(0,600,600),1);
 const sorted=grid=>({...grid,tiles:grid.tiles.slice().sort((a,b)=>a.x-b.x||a.z-b.z)});
 model.history();assert.deepEqual(sorted(model.grid.toJSON()),sorted(before));model.history(true);assert.equal(model.grid.apply(0,255,-1),1);
 await model.selectPaint(255,-1);model.transformPaint(0,0,true);assert.equal(model.grid.apply(0,255,-1),0);assert.equal(model.grid.apply(0,600,600),1);
 model.history();assert.equal(model.grid.apply(0,255,-1),1);
});

test('paint selection is invalidated by edits and cancelled selection leaves the document untouched',async()=>{
 const model=new Model(blank());await stroke(model,'land',[[0,0]]);await model.selectPaint(0,0);const before=model.preset();
 model.rename('Renamed');assert.throws(()=>model.transformPaint(128,0),/Select the painted island again/);
 await model.selectPaint(0,0);assert.throws(()=>model.transformPaint(30000000,0),/world bounds/);assert.deepEqual(model.preset().painted_map,before.painted_map);
});

test('moving a donut moves its ocean cutout and every fractional coast sample',async()=>{
 const m=new Model(blank(),'2');
 for(const [tool,radius,x,z] of [['land',160,0,0],['ocean',64,24,12]]){m.begin({tool,radius,roughness:.25});await m.point(x,z);m.end();}
 await stroke(m,'land',[[800,800]]);await stroke(m,'ocean',[[-700,-700]]);
 const before=m.grid.toJSON(),snapshot=[];
 for(let z=-200;z<=200;z+=4)for(let x=-200;x<=200;x+=4)snapshot.push([x,z,m.grid.apply(0,x,z)]);
 await m.selectPaint(-80,0);m.transformPaint(512,0);
 for(const [x,z,v]of snapshot){assert.equal(m.grid.apply(0,x,z),0,`residual at ${x},${z}`);assert.equal(m.grid.apply(0,x+512,z),v,`moved mask at ${x},${z}`);}
 assert.equal(m.grid.apply(0,800,800),1);assert.ok(m.grid.node(-175,-175)>>>16);
 const sorted=grid=>({...grid,tiles:grid.tiles.slice().sort((a,b)=>a.x-b.x||a.z-b.z)});
 m.history();assert.deepEqual(sorted(m.grid.toJSON()),sorted(before));m.history(true);
 await m.selectPaint(432,0);m.transformPaint(0,0,true);
 for(const [x,z]of snapshot)assert.equal(m.grid.apply(0,x+512,z),0);
});

test('open ocean channels move without stealing disconnected islands or outside ocean paint',async()=>{
 const m=new Model(blank(),'2');
 m.begin({tool:'land',radius:96,roughness:.5});await m.point(-257,-257);m.end();
 m.begin({tool:'ocean',radius:28,roughness:0});await m.point(-257,-257);await m.point(-257,-100);m.end();
 await stroke(m,'land',[[40,-257]]);await stroke(m,'ocean',[[-500,-257]]);
 const outside=m.grid.node(-125,-64),neighbor=m.grid.apply(0,40,-257),before=m.grid.toJSON();
 const noSelection=await m.selectPaint(-300,-257,()=>false);assert.equal(noSelection,null);assert.deepEqual(m.grid.toJSON(),before);
 await m.selectPaint(-300,-257);m.transformPaint(-512,-256);
 for(let z=-380;z<-130;z+=4)for(let x=-380;x<-130;x+=4)assert.equal(m.grid.apply(0,x,z),0,`open cut residue ${x},${z}`);
 assert.equal(m.grid.node(-125,-64),outside);assert.equal(m.grid.apply(0,40,-257),neighbor);
 await m.selectPaint(-812,-513);m.transformPaint(1024,0);assert.ok(m.grid.apply(0,212,-513)>.5);
 const restored=new Model(m.project());assert.deepEqual(restored.preset(),m.preset());
});
