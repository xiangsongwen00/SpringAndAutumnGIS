import assert from 'node:assert/strict';
import * as THREE from 'three';
import { EntityCollection, EntityError, EntityLayer, Ellipsoid, GlobeCameraController } from '../dist/spring-and-autumn-gis.es.js';

const entities = new EntityCollection(), changes=[];
const unsubscribe=entities.onChange(change=>changes.push(change));
const input={id:'point',type:'point',position:[0,0,100],properties:{category:'station',nested:{x:1}},symbol:{color:'#ff0000',size:20}};
const point=entities.add(input); input.position[0]=20; input.properties.nested.x=5;
assert.equal(point.position[0],0);assert.equal(point.properties.nested.x,1);assert.ok(Object.isFrozen(point.symbol));
assert.throws(()=>{point.position[0]=10;},TypeError);
assert.throws(()=>entities.add(point),error=>error instanceof EntityError && error.code==='DUPLICATE_ID');
entities.update('point',{symbol:{shape:'diamond'}});assert.equal(entities.getById('point').symbol.color,'#ff0000');
entities.move('point',{longitude:1,height:100});assert.deepEqual(entities.getById('point').position,[1,0,200]);
entities.update('point',{position:[0,0,100]});
entities.add({id:'line',type:'polyline',positions:[[-0.1,0,100],[0.1,0,100]],symbol:{color:'#00ff00',width:7,dash:[4,3]}});
entities.add({id:'area',type:'polygon',positions:[[1,1,100],[1.2,1,100],[1.2,1.2,100],[1,1.2,100]],holes:[[[1.05,1.05,100],[1.15,1.05,100],[1.15,1.15,100],[1.05,1.15,100]]],symbol:{fill:true}});
assert.equal(entities.query({type:'polygon'}).length,1);
assert.equal(entities.query({properties:{category:'station'}})[0].id,'point');
assert.equal(entities.query({bounds:{west:-0.99,east:0.99,south:-0.99,north:0.99}}).length,2);
assert.throws(()=>entities.update('point',{position:[0,91]}),EntityError);assert.equal(entities.getById('point').position[1],0);
assert.throws(()=>entities.update('point',{id:'oops'}),EntityError);
for(const definition of [
 {id:'bad',type:'point',position:[NaN,0]}, {id:'bad',type:'point',position:[0,0],symbol:{color:'not-a-color'}},
 {id:'bad',type:'point',position:[0,0],symbol:{width:5}}, {id:'bad',type:'label',position:[0,0]},
 {id:'bad',type:'polygon',positions:[[0,0],[1,1],[0,1],[1,0]]},
 {id:'bad',type:'polygon',positions:[[0,0],[1,0],[1,1],[0,1]],holes:[[[2,2],[3,2],[3,3]]]},
 {id:'bad',type:'polygon',positions:[[0,0],[2,0],[2,2],[0,2]],holes:[[[1,1],[2,1],[2,1.5]]]},
 {id:'bad',type:'polygon',positions:[[0,0],[20,0],[20,1]]},
 {id:'bad',type:'polyline',positions:[[0,0]]}, {id:'bad',type:'polyline',positions:[[0,0],[1,1]],holes:[]}
]) assert.throws(()=>entities.add(definition),EntityError);
const camera=new THREE.PerspectiveCamera(50,1,1,100000000);
camera.position.set(0,0,Ellipsoid.WGS84.equatorialRadius+100000);camera.lookAt(0,0,0);camera.updateMatrixWorld();
const layer=new EntityLayer(Ellipsoid.WGS84,entities);
for(let i=0;i<10;i++)layer.update(camera,800,800);
assert.equal(layer.pick({x:400,y:400},camera).id,'point');
entities.setVisibleById('point',false);layer.update(camera,800,800);assert.equal(layer.pick({x:400,y:400},camera).id,'line');
entities.setVisible(false);assert.equal(layer.pick({x:400,y:400},camera),null);entities.setVisible(true);
const meshes=[];layer.object3d.traverse(object=>{if(object.isMesh)meshes.push(object);});
const fill=meshes.find(mesh=>mesh.material.uniforms.color?.value.equals(new THREE.Color('#32e6a1'))&&!mesh.geometry.getAttribute('next'));
assert.ok(fill?.geometry.getAttribute('position').count>6,'Polygon fill must be tessellated, not an outline');
// Area in the local tangent plane excludes the hole (triangulation/closing-ring offsets).
const areaEntity=entities.getById('area'), center=Ellipsoid.WGS84.cartographicToCartesian({longitude:1,latitude:1,height:100});
const right=new THREE.Vector3(Math.cos(Math.PI/180),0,-Math.sin(Math.PI/180));
const up=new THREE.Vector3().crossVectors(center.clone().normalize(),right).normalize();
const positions=fill.geometry.getAttribute('position');let area=0;
for(let i=0;i<positions.count;i+=3){const p=[0,1,2].map(j=>new THREE.Vector3().fromBufferAttribute(positions,i+j));
 area+=Math.abs((p[1].dot(right)-p[0].dot(right))*(p[2].dot(up)-p[0].dot(up))-(p[2].dot(right)-p[0].dot(right))*(p[1].dot(up)-p[0].dot(up)))/2;}
assert.ok(area>360000000&&area<380000000,`Unexpected hole triangulation area ${area}`);
entities.add({id:'wrapped',type:'polygon',positions:[[179.95,0],[-179.95,0],[-179.95,0.1],[179.95,0.1]]});
entities.move('wrapped',{longitude:0.1});assert.ok(entities.getById('wrapped').positions.every(p=>p[0]>=-180&&p[0]<=180));
assert.equal(entities.remove('line'),true);assert.equal(entities.remove('line'),false);
unsubscribe();layer.dispose();layer.dispose();entities.dispose();entities.dispose();
assert.throws(()=>entities.add(point),error=>error.code==='DESTROYED');assert.ok(changes.some(c=>c.type==='visibility'));
const controller=new GlobeCameraController(camera,{style:{},addEventListener(){},removeEventListener(){}});
controller.flyTo({longitude:10,latitude:20,altitude:100000,duration:1000});
controller.flyTo({longitude:30,latitude:40,altitude:100000,duration:0});
const destination=camera.position.clone();controller.update(performance.now()+2000);
assert.ok(camera.position.distanceTo(destination)<0.001,'Immediate flight was overwritten by old animation');controller.dispose();
const symbols=new EntityCollection();
symbols.add({id:'icon',type:'point',position:[0,0,100],symbol:{icon:{url:'/mylocation_up.png',sourceHeading:0},heading:0,alignment:'map'}});
symbols.update('icon',{symbol:{heading:90}});assert.equal(symbols.getById('icon').symbol.icon.url,'/mylocation_up.png');
symbols.add({id:'flow',type:'polyline',positions:[[0,0,100],[0.1,0,100]],symbol:{width:24,texture:{url:'/Qianjin_left.png',sourceDirection:'left',length:48,speed:30}}});
symbols.update('flow',{symbol:{texture:null}});assert.equal(symbols.getById('flow').symbol.width,24);assert.equal(symbols.getById('flow').symbol.texture,null);
symbols.add({id:'surface',type:'polygon',positions:[[0,0],[0.1,0],[0.1,0.1]],symbol:{texture:{url:'/Qianjin_left.png',repeat:[8,4],speed:[-0.1,0],rotation:90},opacity:0.5}});
for(const symbol of [{icon:{url:'javascript:alert(1)'}},{icon:{url:'/a.png',width:1000}},{heading:Infinity},{alignment:'wrong'}])assert.throws(()=>symbols.update('icon',{symbol}),EntityError);
assert.throws(()=>symbols.update('surface',{symbol:{texture:{url:'/a.png',repeat:[0,1]}}}),EntityError);
symbols.dispose();
// Exercise label-memory admission without allocating real large canvases/GPU textures in Node.
const oldDocument=globalThis.document;
globalThis.document={createElement(){return {width:0,height:0,getContext(){return {font:'',lineWidth:1,measureText(){return {width:1000};},scale(){},strokeText(){},fillText(){},fillRect(){}};}};}};
try{
 const limited=new EntityCollection(),limitedLayer=new EntityLayer(Ellipsoid.WGS84,limited);
 for(let i=0;i<6;i++)limited.add({id:`limit-${i}`,type:'label',position:[0,0,100],label:{text:'line\n'.repeat(7)+'line',fontSize:96}});
 for(let i=0;i<10;i++)limitedLayer.update(camera,800,800);
 assert.equal(limitedLayer.getResourceState('limit-5').state,'error','Label upload estimate must respect shared 64MiB budget');
 for(let i=0;i<5;i++)limited.remove(`limit-${i}`);
 assert.equal(limitedLayer.retryResources('limit-5'),true);limitedLayer.update(camera,800,800);
 assert.equal(limitedLayer.getResourceState('limit-5').state,'none','Released label budget must become available');
 limitedLayer.dispose();limited.dispose();
}finally{if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;}
console.log('Entities: immutable CRUD/query/style/move/visibility, validation, screen selection, fill/holes and lifecycle passed.');
