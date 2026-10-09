import * as THREE from 'three';
import { CoordinateTransform } from '../coordinates/CoordinateTransform';
import type { Cartographic, Ellipsoid } from './Ellipsoid';
import type { ScreenPosition } from '../../sdk/EntityTypes';
import type { TileId } from '../tiling/GeographicTilingScheme';

export type SurfacePickOptions = { mode?: 'surface' | 'ellipsoid' | 'absolute-height'; height?: number };
export type SurfaceRayHit = { world: THREE.Vector3; tile?: TileId };
export type SurfacePickResult = Readonly<{ position: Required<Cartographic>; source: 'rendered-surface'|'ellipsoid'|'absolute-height';
  tile: TileId|null; screen: ScreenPosition; reprojected: ScreenPosition; errorPixels: number; distance: number }>;

/** All entry points use CSS pixels, the same camera ray and the same displayed-surface callback. */
export function pickSurfacePosition(camera:THREE.PerspectiveCamera,ellipsoid:Ellipsoid,width:number,height:number,
  screen:ScreenPosition,options:SurfacePickOptions={},surface?:(ray:THREE.Ray)=>SurfaceRayHit|null):SurfacePickResult|null {
  if(![screen.x,screen.y].every(Number.isFinite))throw new Error('Screen coordinates must be finite CSS pixels.');
  const mode=options.mode??'surface';
  if(!['surface','ellipsoid','absolute-height'].includes(mode))throw new Error('Invalid surface pick mode.');
  if(mode==='absolute-height'&&(!Number.isFinite(options.height)||Math.abs(options.height!)>10000000))throw new Error('Absolute-height picking requires a finite height in metres.');
  if(width<=0||height<=0||screen.x<0||screen.y<0||screen.x>width||screen.y>height)return null;
  camera.updateMatrixWorld();
  const caster=new THREE.Raycaster();caster.setFromCamera(new THREE.Vector2(screen.x/width*2-1,1-screen.y/height*2),camera);
  const ray=caster.ray,coordinates=new CoordinateTransform(ellipsoid);
  let hit=mode==='surface'?surface?.(ray)??null:null;
  let source:SurfacePickResult['source']=hit?'rendered-surface':'ellipsoid';
  if(!hit){
    const wanted=mode==='absolute-height'?options.height!:0;
    const a=ellipsoid.equatorialRadius+wanted,b=ellipsoid.polarRadius+wanted;
    if(a<=0||b<=0)return null;
    const o=new THREE.Vector3(ray.origin.x/a,ray.origin.y/b,ray.origin.z/a),d=new THREE.Vector3(ray.direction.x/a,ray.direction.y/b,ray.direction.z/a);
    const aa=d.lengthSq(),bb=2*o.dot(d),cc=o.lengthSq()-1,disc=bb*bb-4*aa*cc;if(disc<0)return null;
    const near=(-bb-Math.sqrt(disc))/(2*aa),far=(-bb+Math.sqrt(disc))/(2*aa);let distance=near>=0?near:far;if(distance<0)return null;
    if(wanted!==0){
      // Inflating both axes is only a seed, not a constant-geodetic-height surface.
      for(let i=0;i<12;i++){
        const p=ray.at(distance,new THREE.Vector3()),c=coordinates.worldToGeodetic(p),error=c.height-wanted;
        if(Math.abs(error)<0.00001)break;
        const lon=THREE.MathUtils.degToRad(c.longitude),lat=THREE.MathUtils.degToRad(c.latitude);
        const normal=new THREE.Vector3(Math.cos(lat)*Math.sin(lon),Math.sin(lat),Math.cos(lat)*Math.cos(lon));
        const slope=normal.dot(ray.direction);if(Math.abs(slope)<1e-8)return null;distance-=error/slope;if(distance<0)return null;
      }
      if(Math.abs(coordinates.worldToGeodetic(ray.at(distance,new THREE.Vector3())).height-wanted)>0.001)return null;
    }
    hit={world:ray.at(distance,new THREE.Vector3())};if(mode==='absolute-height')source='absolute-height';
  }
  const projected=hit.world.clone().project(camera),reprojected={x:(projected.x+1)*width/2,y:(1-projected.y)*height/2};
  return {position:coordinates.worldToGeodetic(hit.world),source,tile:hit.tile??null,screen:{...screen},reprojected,
    errorPixels:Math.hypot(reprojected.x-screen.x,reprojected.y-screen.y),distance:ray.origin.distanceTo(hit.world)};
}
