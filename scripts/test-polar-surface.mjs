import assert from 'node:assert/strict';
import * as THREE from 'three';
import {PolarSurfaceLayer,RasterTileLayer,TerrainTileLayer,Ellipsoid,CoordinateTransform,GlobeCameraController} from '../dist/spring-and-autumn-gis.es.js';
const ellipsoid=Ellipsoid.WGS84,coords=new CoordinateTransform(ellipsoid),limit=85.0511287798066;
const provider={id:'polar-unit',minLevel:0,maxLevel:20,url:()=>'/never-requested'},raster=new RasterTileLayer(ellipsoid,provider,{segments:16});
const camera=new THREE.PerspectiveCamera(50,1.6,.02,1e8),controls=new GlobeCameraController(camera,{style:{},addEventListener(){},removeEventListener(){}},ellipsoid);
const cap=new PolarSurfaceLayer(ellipsoid),textures=[];
assert.notEqual(cap.northColor.getHex(),cap.southColor.getHex());assert.ok(cap.northColor.b>cap.northColor.r,'North fallback is ocean, not southern ice');
const themed=new PolarSurfaceLayer(ellipsoid,{northColor:'#112233',southColor:'#ddeeff'});assert.equal(themed.northColor.getHex(),0x112233);assert.equal(themed.southColor.getHex(),0xddeeff);themed.dispose();
for(const north of [true,false]){
 const id={level:1,x:0,y:north?0:1},geometry=raster.geometryForLevel(1).clone(),count=geometry.getAttribute('position').count;
 geometry.setAttribute('terrainEdgeHigh',new THREE.Float32BufferAttribute(new Float32Array(count*3),3));geometry.setAttribute('terrainEdgeLow',new THREE.Float32BufferAttribute(new Float32Array(count*3),3));geometry.setAttribute('terrainEdgeMask',new THREE.Float32BufferAttribute(new Float32Array(count),1));
 const material=raster.createMaterial(id),dem=new THREE.DataTexture(new Float32Array(9).fill(north?-300:1000),3,3,THREE.RedFormat,THREE.FloatType),image=new THREE.DataTexture(new Uint8Array([20,40,60,255]),1,1);
 material.uniforms.hasTerrain.value=true;material.uniforms.terrainTexture.value=dem;material.uniforms.hasTexture.value=true;material.uniforms.tileTexture.value=image;
 material.uniforms.uvScale.value.set(.5,.5);material.uniforms.uvOffset.value.set(.25,north?0:.5);
 textures.push(dem,image);const mesh=new THREE.Mesh(geometry,material);raster.renderTiles.set(`${north}`,{id,mesh,textureKey:'',terrainKey:'bound-dem'});
}
let disposals=0;for(const texture of textures)texture.addEventListener('dispose',()=>disposals++);
for(const north of [true,false]){
 controls.flyTo({longitude:-90,latitude:north?88:-88,altitude:30000,pitch:-90,heading:0,duration:0});camera.updateMatrixWorld();cap.update(camera,raster);
 const edge=[...cap.edges.values()].find(item=>item.mesh.visible&&Math.sign(item.mesh.position.y)===(north?1:-1));assert.ok(edge);
 const uniforms=edge.mesh.material.uniforms;assert.equal(uniforms.map.value,raster.renderTiles.get(`${north}`).mesh.material.uniforms.tileTexture.value);
 assert.deepEqual(uniforms.scale.value.toArray(),[.5,.5]);assert.deepEqual(uniforms.offset.value.toArray(),[.25,north?0:.5]);
 const uv=edge.mesh.geometry.getAttribute('uv');assert.equal(uv.getY(0),north?0:1,'Do not flip geometry or TMS row in cap UVs');
 const position=edge.mesh.geometry.getAttribute('position'),world=new THREE.Vector3().fromBufferAttribute(position,0).add(edge.mesh.position),expected=coords.geodeticToWorld({longitude:-180,latitude:north?limit:-limit,height:north?-300:1000+.1});
 // Base imagery has its own 0.1m render clearance.
 if(north)expected.copy(coords.geodeticToWorld({longitude:-180,latitude:limit,height:-299.9}));
 assert.ok(world.distanceTo(expected)<.06,'Shared border must match bound displayed DEM, not zero');
 const ray=new THREE.Ray(camera.position,camera.getWorldDirection(new THREE.Vector3())),hit=cap.pickSurface(ray);assert.equal(hit?.approximation,'polar-cap');
 const p=coords.worldToGeodetic(hit.world);assert.ok(Math.abs(Math.abs(p.latitude)-88)<.01);
 if(process.env.POLAR_DEBUG){const caster=new THREE.Raycaster();caster.ray.copy(ray);const raw=caster.intersectObject(edge.mesh)[0],meta=edge.mesh.geometry.userData;console.log({north,columns:meta.columns.length,ends:[meta.columns[0],meta.columns[meta.columns.length-1]],around:meta.columns.slice(Math.floor(meta.columns.length/2)-2,Math.floor(meta.columns.length/2)+3),rows:meta.rows,face:raw?.faceIndex,row:raw?Math.floor(raw.faceIndex/2/(meta.columns.length-1)):null,height:cap.surfaceHeight(-90,north?88:-88),p});}
 assert.ok(north?p.height < -10:p.height>10,'Neutral zero-height cap must not cover borrowed negative/positive-height sectors');
 assert.ok(Math.abs(cap.surfaceHeight(-90,north?88:-88)-p.height)<.02,`Navigation clearance must use the same display triangles: ${cap.surfaceHeight(-90,north?88:-88)} vs ${p.height}`);
 const countTriangles=cap.object3d.children.filter(m=>m.visible).reduce((sum,m)=>sum+m.geometry.index.count/3,0);assert.ok(countTriangles<=150000,'Bounded near-pole completion workload');
 assert.equal(TerrainTileLayer.prototype.sampleHeight.call({},0,north?88:-88),null,'No measured DEM beyond Mercator latitude');
 assert.equal(TerrainTileLayer.prototype.heightVersionAt.call({},0,north?88:-88),'polar-no-dem');
}
// Switching/removing base drops all borrowed imagery references and sector holes.
cap.update(camera,null);assert.equal(cap.edges.size,0);assert.equal(disposals,0);assert.ok(cap.pickSurface(new THREE.Ray(camera.position,camera.getWorldDirection(new THREE.Vector3()))));
for(const latitude of [90,-90]){controls.flyTo({longitude:0,latitude,altitude:30000,pitch:-90,heading:0,duration:0});camera.updateMatrixWorld();cap.update(camera,null);const hit=cap.pickSurface(new THREE.Ray(camera.position,camera.getWorldDirection(new THREE.Vector3())));assert.equal(hit?.approximation,'polar-cap','Both pole tips must close');assert.ok(Math.abs(coords.worldToGeodetic(hit.world).latitude-latitude)<.001);}
cap.dispose();assert.equal(disposals,0,'Cap must never own/dispose base imagery or DEM textures');raster.dispose();for(const t of textures)t.dispose();controls.dispose();
console.log('Polar north/south completion, exact DEM edge, negative heights, UV crops, no false DEM, bounded mesh and borrowed-resource lifecycle passed.');
