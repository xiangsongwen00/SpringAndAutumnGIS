import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Ellipsoid,CoordinateTransform,GlobeCameraController,RasterTileLayer,pickSurfacePosition } from '../dist/spring-and-autumn-gis.es.js';
const e=Ellipsoid.WGS84,coordinates=new CoordinateTransform(e),camera=new THREE.PerspectiveCamera(50,1.6,.02,100000000);
const element={style:{},addEventListener(){},removeEventListener(){}};
const controller=new GlobeCameraController(camera,element,e,{revision:1,enabled:true,sampleHeight:()=>2000});
const provider={id:'pick-unit',minLevel:0,maxLevel:22,url:()=>'/not-requested'};
const layer=new RasterTileLayer(e,provider,{segments:16});
for(const level of [12,16,18,20]){
 const size=2**level,lon=106.55,lat=29.61,id={level,x:Math.floor((lon+180)/360*size),y:Math.floor((1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2*size)};
 const geometry=layer.geometryForLevel(level).clone(),count=geometry.getAttribute('position').count;
 for(const name of ['terrainEdgeHigh','terrainEdgeLow'])geometry.setAttribute(name,new THREE.Float32BufferAttribute(new Float32Array(count*3),3));
 geometry.setAttribute('terrainEdgeMask',new THREE.Float32BufferAttribute(new Float32Array(count),1));
 const material=layer.createMaterial(id),heights=new Float32Array(9).fill(2000),texture=new THREE.DataTexture(heights,3,3,THREE.RedFormat,THREE.FloatType);
 material.uniforms.hasTerrain.value=true;material.uniforms.terrainTexture.value=texture;
 const mesh=new THREE.Mesh(geometry,material),key=`${level}/${id.x}/${id.y}`;
 layer.renderTiles.clear();layer.renderTiles.set(key,{id,mesh,textureKey:'',terrainKey:'unit'});
 for(const pitch of [-90,-55,-20]){
  controller.flyTo({longitude:lon,latitude:lat,altitude:6000,pitch,heading:37,duration:0});camera.updateMatrixWorld();
  const screen={x:640,y:400},hit=pickSurfacePosition(camera,e,1280,800,screen,{},ray=>layer.pickSurface(ray));
  assert.equal(hit?.source,'rendered-surface',`Missing displayed surface z${level}/pitch${pitch}`);
  assert.ok(hit.errorPixels<.001,`Round-trip z${level}/pitch${pitch}: ${hit.errorPixels}px`);assert.ok(Math.abs(hit.position.height-2000)<8,'Pick must use the bound DEM, not zero or current unrelated heights');
  const back=coordinates.geodeticToWorld(hit.position).project(camera);
  assert.ok(Math.hypot((back.x+1)*640-screen.x,(1-back.y)*400-screen.y)<.0001,'Coordinate round-trip drift');
  const reference=pickSurfacePosition(camera,e,1280,800,screen,{mode:'ellipsoid'});
  if(pitch>-80)assert.ok(coordinates.geodeticToWorld(reference.position).distanceTo(coordinates.geodeticToWorld(hit.position))>2200,'Oblique ellipsoid/terrain difference must be observable');
  const fixed=pickSurfacePosition(camera,e,1280,800,screen,{mode:'absolute-height',height:2000});assert.ok(Math.abs(fixed.position.height-2000)<.001);
 }
 // A resource/version change invalidates lazy CPU geometry. No old heights survive.
 heights.fill(2100);texture.needsUpdate=true;
 controller.flyTo({longitude:lon,latitude:lat,altitude:6000,pitch:-90,heading:37,duration:0});camera.updateMatrixWorld();
 const newer=pickSurfacePosition(camera,e,1280,800,{x:640,y:400},{},ray=>layer.pickSurface(ray));assert.ok(newer.position.height>2090);
 mesh.visible=false;assert.equal(layer.pickSurface(new THREE.Ray(camera.position,camera.getWorldDirection(new THREE.Vector3()))),null);
 geometry.dispose();material.dispose();texture.dispose();
}
controller.dispose();layer.renderTiles.clear();layer.dispose();
assert.equal(pickSurfacePosition(camera,e,1280,800,{x:-1,y:10}),null);
assert.throws(()=>pickSurfacePosition(camera,e,1280,800,{x:NaN,y:0}));
console.log('Surface picks: displayed DEM/mesh, oblique ellipsoid mismatch, shader precision branches, cache revisions and WGS84-screen round trips passed.');
