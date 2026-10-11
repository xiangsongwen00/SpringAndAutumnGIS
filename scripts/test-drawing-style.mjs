import assert from 'node:assert/strict';
import * as THREE from 'three';
import { EntityCollection,EntityLayer,EntityDrawingController,Ellipsoid,Viewer } from '../dist/spring-and-autumn-gis.es.js';
const entities=new EntityCollection(),changes=[];entities.onChange(change=>changes.push(change));
entities.add({id:'vehicle',type:'point',position:[106.55,29.61,100],symbol:{size:12}});
const rendering=new EntityLayer(Ellipsoid.WGS84,entities),camera=new THREE.PerspectiveCamera();
rendering.update(camera,100,100);const original=rendering.rendered.get('vehicle');
assert.equal(entities.selectById('vehicle').id,'vehicle');assert.equal(entities.selectedId,'vehicle');
assert.equal(rendering.dirty.size,0,'Selection must not rebuild GPU resources');assert.equal(rendering.rendered.get('vehicle'),original);
entities.update('vehicle',{position:[106.56,29.62,101]});assert.equal(entities.selectedEntity.position[0],106.56);
entities.selectById(null);assert.equal(entities.selectedEntity,null);
assert.throws(()=>entities.selectById('absent'),error=>error.code==='NOT_FOUND');
entities.selectById('vehicle');entities.remove('vehicle');assert.equal(entities.selectedId,null);
assert.ok(changes.some(change=>change.type==='selection'));
const handlers=new Map(),canvas={style:{cursor:''},ownerDocument:{addEventListener(){}},addEventListener(name,fn){handlers.set(name,fn)},
  hasPointerCapture(){return false},getBoundingClientRect(){return {left:0,top:0,width:100,height:100}}};
const engine={ellipsoid:Ellipsoid.WGS84,entityGroundSurface:{revision:'fixture',patches:()=>[]},renderer:{domElement:canvas},
  controls:{enabled:true,cancelAnimation(){}},addSceneLayer(){},removeSceneLayer(){},
  pickPositionDetailed(){return {position:{longitude:106.55,latitude:29.61,height:100},source:'ellipsoid',errorPixels:0}}};
const drawing=new EntityDrawingController(engine,entities);
const click=()=>{const event={button:0,pointerId:1,clientX:50,clientY:50,isTrusted:false,preventDefault(){},stopImmediatePropagation(){}};
  handlers.get('pointerdown')(event);handlers.get('pointerup')(event);return entities.getById(drawing.state.lastEntityId);};
const copy=drawing.setStyle('point',{symbol:{size:36,heading:30,icon:{url:'/fixture-icon.png'},occlusion:'overlay'}});
copy.symbol.icon.url='/mutated-copy.png';assert.equal(drawing.getStyle('point').symbol.icon.url,'/fixture-icon.png');
drawing.start({type:'point',symbol:{color:'#ff0000'}});const first=click();assert.equal(first.symbol.icon.url,'/fixture-icon.png');
drawing.setStyle('point',{symbol:{heading:90}});const second=click();assert.equal(second.symbol.heading,90);assert.equal(second.symbol.color,'#ff0000');
assert.equal(second.symbol.icon.url,'/fixture-icon.png');assert.equal(entities.getById(first.id).symbol.heading,30,'Live defaults must not mutate old results');
drawing.stop();drawing.start({type:'point'});assert.equal(click().symbol.heading,90,'Future session inherits defaults');drawing.stop();
assert.throws(()=>drawing.setStyle('point',{symbol:{width:5}}));assert.equal(drawing.getStyle('point').symbol.heading,90);
drawing.start({type:'point',historyGroup:'measurement',symbol:{color:'#ffcc66',size:10}});
drawing.setStyle('point',{symbol:{heading:180,icon:null}});const measurement=click();assert.equal(measurement.symbol.icon,undefined,'Measurement does not inherit icons or live drawing defaults');drawing.stop();
assert.equal(typeof Viewer.prototype.selectEntity,'function');assert.equal(typeof Viewer.prototype.sampleTerrainHeight,'function');
drawing.dispose();rendering.dispose();entities.dispose();
console.log('Drawing defaults/live icon/style isolation, stable ID selection and no selection GPU rebuild passed.');
