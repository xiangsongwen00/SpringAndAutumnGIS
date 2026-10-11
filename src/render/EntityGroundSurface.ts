import * as THREE from 'three';
import type { TileId } from '../core/tiling/GeographicTilingScheme';
import type { EntityPosition } from '../sdk/EntityTypes';

export type GroundBounds={west:number;east:number;north:number;south:number};
export type GroundPatch={id:TileId;shift:number;signature:string;vertices:Float64Array;uv:THREE.BufferAttribute;index:THREE.BufferAttribute};
export interface EntityGroundSurface {
  /** Actual displayed base topology/DEM/edge generation; not downloaded/requested DEM. */
  readonly revision:string;
  patches(bounds:GroundBounds):readonly GroundPatch[];
}
export function groundCoordinate(p:EntityPosition,reference:number):THREE.Vector2 {
  let x=(p[0]+180)/360;while(x-reference>.5)x--;while(x-reference<-.5)x++;
  const lat=THREE.MathUtils.degToRad(THREE.MathUtils.clamp(p[1],-85.0511287798066,85.0511287798066));
  return new THREE.Vector2(x,(1-Math.asinh(Math.tan(lat))/Math.PI)/2);
}
export function groundBounds(positions:readonly EntityPosition[]):GroundBounds {
  const reference=(positions[0]![0]+180)/360,points=positions.map(p=>groundCoordinate(p,reference));
  return {west:Math.min(...points.map(p=>p.x)),east:Math.max(...points.map(p=>p.x)),north:Math.min(...points.map(p=>p.y)),south:Math.max(...points.map(p=>p.y))};
}
