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
});

test('brush settings persist without painting or creating an undo action',()=>{
 const model=new Model(blank());model.settings({radius:384,roughness:.8});
 const copy=new Model(model.project({x:0,z:0,blocksPerPixel:4}));
 assert.equal(copy.editor.radius,384);assert.equal(copy.editor.roughness,.8);
 assert.equal(model.revision,0);assert.equal(model.undoStack.length,0);
 assert.throws(()=>model.settings({radius:Infinity,roughness:.2}));
 assert.equal(model.editor.radius,384);
});
