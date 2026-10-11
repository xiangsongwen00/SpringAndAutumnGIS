import assert from 'node:assert/strict';
import * as THREE from 'three';
import {measureDistance,measureArea,GlobeCameraController,CoordinateTransform,Ellipsoid,MeasurementController,EntityCollection} from '../dist/spring-and-autumn-gis.es.js';
assert.ok(Math.abs(measureDistance([[0,0],[1,0]]).metres-111319.49079327357)<1e-6);
assert.ok(Math.abs(measureDistance([[179,0],[-179,0]]).metres-222638.981586547)<1e-6);
assert.ok(measureDistance([[0,0],[180,0]]).metres>20003000);
const ring=[[0,0],[1,0],[1,1],[0,1]],area=measureArea(ring);
assert.ok(Math.abs(area.squareMetres-12308778361.469452)<.01);
assert.ok(Math.abs(area.squareMetres-measureArea([...ring].reverse()).squareMetres)<.01);
const hole=[[.2,.2],[.4,.2],[.4,.4],[.2,.4]];
assert.ok(Math.abs(measureArea(ring,[hole]).squareMetres+measureArea(hole).squareMetres-area.squareMetres)<.01);
assert.ok(measureArea([[179,0],[-179,0],[-179,1],[179,1]]).squareMetres>2e10);
assert.deepEqual(measureDistance([[0,0,0],[1,0,5000]]),measureDistance([[0,0],[1,0]]));
assert.throws(()=>measureDistance([[NaN,0],[1,0]]));assert.throws(()=>measureArea([[0,0],[1,0]]));
for(const [lon,lat] of [[103.43968,32.04231],[179,80],[-110,-45],[0,90]]){
 const camera=new THREE.PerspectiveCamera(45,1.4,.1,1e8),coordinates=new CoordinateTransform(Ellipsoid.WGS84);
 camera.position.copy(coordinates.geodeticToWorld({longitude:lon,latitude:lat,height:15000}));camera.lookAt(0,0,0);
 const element={style:{},addEventListener(){},removeEventListener(){},clientHeight:900};
 const controls=new GlobeCameraController(camera,element),old=camera.position.clone(),projection=camera.projectionMatrix.clone(),quaternion=camera.quaternion.clone();
 controls.flyTo({longitude:lon,latitude:lat,altitude:10000,pitch:-10,heading:70,duration:0});
 const before=camera.position.clone();controls.orientNorthUp();assert.ok(camera.position.distanceTo(before)<1e-9);assert.ok(camera.projectionMatrix.equals(projection));
 const p=coordinates.worldToGeodetic(camera.position),rad=Math.PI/180,l=p.longitude*rad,t=p.latitude*rad;
 const north=new THREE.Vector3(-Math.sin(t)*Math.sin(l),Math.cos(t),-Math.sin(t)*Math.cos(l));
 const down=new THREE.Vector3(-Math.cos(t)*Math.sin(l),-Math.sin(t),-Math.cos(t)*Math.cos(l));
 assert.ok(camera.up.dot(north)>1-1e-12);assert.ok(camera.getWorldDirection(new THREE.Vector3()).dot(down)>1-1e-12);
 controls.resetView();assert.ok(camera.position.distanceTo(old)<1e-9);assert.ok(camera.quaternion.angleTo(quaternion)<1e-7);controls.dispose();
}
// Controller ownership: switches/cancellation/clearing do not delete unrelated user objects.
const entities=new EntityCollection(),listeners=new Set();let options=null,state={active:false,positions:[],vertexCount:0,lastEntityId:null};
const draw={get isActive(){return !!options},get state(){return state},onChange(fn){listeners.add(fn);return()=>listeners.delete(fn)},
 cancel(){options=null;state={...state,active:false,lastEntityId:null};for(const fn of listeners)fn(state)},
 start(o){options=o;state={active:true,type:o.type,positions:[],vertexCount:0,lastEntityId:null};for(const fn of listeners)fn(state)},
 finish(){entities.add({...options,positions:[[0,0],[.1,0]],type:'polyline'});const id=options.id;options=null;state={...state,active:false,lastEntityId:id};for(const fn of listeners)fn(state)},undo(){}};
entities.add({id:'user-object',type:'point',position:[0,0],properties:{measurement:'distance'}});
const measurement=new MeasurementController(draw,entities);measurement.start('distance');const result=measurement.finish();assert.ok(result.metres>10000);
assert.equal(entities.length,2);measurement.clear();assert.equal(entities.length,1);assert.ok(entities.has('user-object'));
measurement.start('area');draw.cancel();assert.equal(measurement.state.active,false);measurement.dispose();assert.equal(listeners.size,0);entities.dispose();
console.log('WGS84 distance/area/holes/dateline, measurement ownership and orientation-only compass/reset passed.');
