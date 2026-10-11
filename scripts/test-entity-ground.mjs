import assert from 'node:assert/strict';
import * as THREE from 'three';
import {buildGroundGeometry,EntityCollection,EntityLayer,Ellipsoid} from '../dist/spring-and-autumn-gis.es.js';
const vertices=new Float64Array([6378000,0,0,6378000,10000,0,6378000,0,10000,6378300,10000,10000]);
const patch={id:{level:0,x:0,y:0},shift:0,signature:'test',vertices,uv:new THREE.Float32BufferAttribute([0,0,1,0,0,1,1,1],2),index:new THREE.Uint16BufferAttribute([0,1,2,1,3,2],1)};
const drain=iterator=>{let value;do{value=iterator.next();}while(!value.done);return value.value;};
const polygon={id:'ground-area',type:'polygon',heightReference:'clamp-to-ground',groundOffset:0,positions:[[89.8,66.4,5000],[90.2,66.4,5000],[90.2,66.6,5000],[89.8,66.6,5000]],holes:[[[89.9,66.45],[90.1,66.45],[90.1,66.55],[89.9,66.55]]],symbol:{color:'#ff0000'}};
const result=drain(buildGroundGeometry(polygon,[patch]));assert.ok(result.fill.length>0);assert.ok(result.paths.length>4,'Boundaries must split at the terrain diagonal');
function planeDistance(p,ids){const a=new THREE.Vector3().fromArray(vertices,ids[0]*3),b=new THREE.Vector3().fromArray(vertices,ids[1]*3),c=new THREE.Vector3().fromArray(vertices,ids[2]*3);return Math.abs(new THREE.Plane().setFromCoplanarPoints(a,b,c).distanceToPoint(p));}
for(let i=0;i<result.fill.length;i+=3){const p=new THREE.Vector3().fromArray(result.fill,i);assert.ok(Math.min(planeDistance(p,[0,1,2]),planeDistance(p,[1,3,2]))<1e-7,'Ground fill must lie on one of the actual display planes');}
const line=drain(buildGroundGeometry({id:'line',type:'polyline',heightReference:'clamp-to-ground',groundOffset:0,positions:[[89.8,66.4,9999],[90.2,66.6,-9999]]},[patch]));
assert.ok(line.paths.length>=2);for(const path of line.paths)for(const p of path)assert.ok(Math.min(planeDistance(p,[0,1,2]),planeDistance(p,[1,3,2]))<1e-7);
// Hole area is removed, not painted over the surface.
const full=drain(buildGroundGeometry({...polygon,holes:[]},[patch]));
const area=fill=>{let sum=0;for(let i=0;i<fill.length;i+=9){const a=new THREE.Vector3().fromArray(fill,i),b=new THREE.Vector3().fromArray(fill,i+3),c=new THREE.Vector3().fromArray(fill,i+6);sum+=b.sub(a).cross(c.sub(a)).length()/2;}return sum;};
assert.ok(area(result.fill)<area(full.fill)*.9);
let revision='1';const source={get revision(){return revision;},patches:()=>[patch]},entities=new EntityCollection();entities.add(polygon);
const layer=new EntityLayer(Ellipsoid.WGS84,entities,source),camera=new THREE.PerspectiveCamera(50,1,1,100000000);camera.position.set(6500000,7500,2500);camera.lookAt(6378000,7500,2500);
for(let i=0;i<10;i++)layer.update(camera,800,800);assert.equal(layer.getGroundState('ground-area').state,'ready');
assert.equal(entities.getById('ground-area').positions[0][2],5000,'Clamping must not rewrite model coordinates');
vertices[9]+=100;revision='2';for(let i=0;i<10;i++)layer.update(camera,800,800);assert.equal(layer.getGroundState('ground-area').revision,'2');
entities.update('ground-area',{heightReference:'absolute'});layer.update(camera,800,800);assert.equal(layer.getGroundState('ground-area').state,'absolute');
layer.dispose();entities.dispose();console.log('Ground entities: exact display-plane clipping, terrain crossings, holes, immutable heights, revision rebuild and mode switching passed.');
