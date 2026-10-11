import * as THREE from 'three';
import { groundCoordinate, type GroundPatch } from './EntityGroundSurface';
import type { EntityDefinition, EntityPosition } from '../sdk/EntityTypes';

type Triangle={xy:readonly [THREE.Vector2,THREE.Vector2,THREE.Vector2];world:readonly [THREE.Vector3,THREE.Vector3,THREE.Vector3];normal:THREE.Vector3};
export type GroundGeometry={center:THREE.Vector3;anchorReady:boolean;paths:THREE.Vector3[][];normals:THREE.Vector3[];groups:number[];fill:number[];uvs:number[];patches:number;vertices:number};
const cross=(a:THREE.Vector2,b:THREE.Vector2,c:THREE.Vector2)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
function weights(p:THREE.Vector2,t:Triangle):readonly [number,number,number]{const [a,b,c]=t.xy,d=cross(a,b,c);const u=cross(p,b,c)/d,v=cross(a,p,c)/d;return [u,v,1-u-v];}
function world(p:THREE.Vector2,t:Triangle,offset:number):THREE.Vector3 {const w=weights(p,t);return new THREE.Vector3().addScaledVector(t.world[0],w[0]).addScaledVector(t.world[1],w[1]).addScaledVector(t.world[2],w[2]).addScaledVector(t.normal,offset);}
function inside(p:THREE.Vector2,t:Triangle):boolean{return weights(p,t).every(v=>v>=-1e-7);}
function* triangles(patches:readonly GroundPatch[]):Generator<Triangle>{
 for(const patch of patches){const n=2**patch.id.level;
  for(let i=0;i<patch.index.count;i+=3){
   const ids=[patch.index.getX(i),patch.index.getX(i+1),patch.index.getX(i+2)];
   const xy=ids.map(id=>new THREE.Vector2((patch.id.x+patch.uv.getX(id))/n+patch.shift,(patch.id.y+patch.uv.getY(id))/n)) as [THREE.Vector2,THREE.Vector2,THREE.Vector2];
   if(Math.abs(cross(...xy))<1e-25)continue; // zero-width skirts are not surface triangles
   const vertices=ids.map(id=>new THREE.Vector3().fromArray(patch.vertices,id*3)) as [THREE.Vector3,THREE.Vector3,THREE.Vector3];
   const normal=vertices[1].clone().sub(vertices[0]).cross(vertices[2].clone().sub(vertices[0]));if(normal.lengthSq()<1e-20)continue;
   normal.normalize();if(normal.dot(vertices[0])<0)normal.negate();yield {xy,world:vertices,normal};
  }
 }
}
function clipLine(a:THREE.Vector2,b:THREE.Vector2,t:Triangle):readonly [number,number]|null {
 const wa=weights(a,t),wb=weights(b,t);let lo=0,hi=1;
 for(let i=0;i<3;i++){const x=wa[i]!,delta=wb[i]!-x;if(Math.abs(delta)<1e-14){if(x<-1e-7)return null;continue;}
  const at=-x/delta;if(delta>0)lo=Math.max(lo,at);else hi=Math.min(hi,at);}
 return hi-lo>1e-10?[Math.max(0,lo),Math.min(1,hi)]:null;
}
function clipPolygon(input:readonly THREE.Vector2[],t:Triangle):THREE.Vector2[]{
 let result=[...input];const direction=Math.sign(cross(...t.xy));
 for(let edge=0;edge<3;edge++){const a=t.xy[edge]!,b=t.xy[(edge+1)%3]!,previous=result;result=[];if(!previous.length)break;
  for(let i=0;i<previous.length;i++){const p=previous[i]!,q=previous[(i+1)%previous.length]!,dp=cross(a,b,p)*direction,dq=cross(a,b,q)*direction;
   if(dp>=-1e-25)result.push(p);if((dp>=0)!==(dq>=0)){const ratio=dp/(dp-dq);result.push(p.clone().lerp(q,ratio));}}
 }return result;
}
const bbox=(p:readonly THREE.Vector2[])=>[Math.min(...p.map(v=>v.x)),Math.min(...p.map(v=>v.y)),Math.max(...p.map(v=>v.x)),Math.max(...p.map(v=>v.y))] as const;
const overlaps=(a:readonly number[],b:readonly number[])=>a[0]!<=b[2]!&&a[2]!>=b[0]!&&a[1]!<=b[3]!&&a[3]!>=b[1]!;

/** Clip business geometry into the SAME displayed terrain triangles. Yields bounded CPU slices, never requests DEM. */
export function* buildGroundGeometry(definition:EntityDefinition,patches:readonly GroundPatch[]):Generator<void,GroundGeometry> {
 const anchor='position' in definition?definition.position:definition.positions[0]!,reference=(anchor[0]+180)/360,anchorXY=groundCoordinate(anchor,reference),offset=definition.groundOffset??0.15;
 const result:GroundGeometry={center:new THREE.Vector3(),anchorReady:false,paths:[],normals:[],groups:[],fill:[],uvs:[],patches:patches.length,vertices:0};
 const rings:THREE.Vector2[][]='positions' in definition?[definition.positions,...(definition.type==='polygon'?definition.holes??[]:[])].map(ring=>{
   const points=ring.map(p=>groundCoordinate(p,reference));if(definition.type==='polygon'&&points.length>3&&points[0]!.equals(points[points.length-1]!))points.pop();return points;
 }):[];
 const segments=rings.flatMap((ring,group)=>{const points=definition.type==='polygon'?[...ring,ring[0]!]:ring;
   return points.slice(1).map((b,index)=>({a:points[index]!,b,group,index,bounds:bbox([points[index]!,b])}));});
 const sourceTriangles:THREE.Vector2[][]=[];
 if(definition.type==='polygon'&&definition.symbol?.fill!==false){const faces=THREE.ShapeUtils.triangulateShape(rings[0]!.map(p=>p.clone()),rings.slice(1).map(r=>r.map(p=>p.clone()))),points=rings.flat();
   for(const f of faces)sourceTriangles.push(f.map(i=>points[i]!) as THREE.Vector2[]);}
 const areaBounds=rings.length?bbox(rings.flat()):bbox([anchorXY]),sourceBoxes=sourceTriangles.map(bbox);
 const size=Math.max(1,Math.min(64,Math.ceil(Math.sqrt(sourceTriangles.length)))),spanX=Math.max(1e-15,areaBounds[2]-areaBounds[0]),spanY=Math.max(1e-15,areaBounds[3]-areaBounds[1]);
 const grid=new Map<string,Set<number>>();
 const segmentGrid=new Map<string,Set<number>>();
 const cells=(bounds:readonly number[])=>{const keys:string[]=[];
   const x0=Math.max(0,Math.floor((bounds[0]!-areaBounds[0])/spanX*size)),x1=Math.min(size-1,Math.floor((bounds[2]!-areaBounds[0])/spanX*size));
   const y0=Math.max(0,Math.floor((bounds[1]!-areaBounds[1])/spanY*size)),y1=Math.min(size-1,Math.floor((bounds[3]!-areaBounds[1])/spanY*size));
   for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++)keys.push(`${x},${y}`);return keys;};
 sourceBoxes.forEach((box,i)=>cells(box).forEach(key=>{const list=grid.get(key)??new Set<number>();list.add(i);grid.set(key,list);}));
 segments.forEach((segment,i)=>cells(segment.bounds).forEach(key=>{const list=segmentGrid.get(key)??new Set<number>();list.add(i);segmentGrid.set(key,list);}));
 const pieces:{group:number;index:number;at:number;path:THREE.Vector3[];normal:THREE.Vector3}[]=[],dedup=new Set<string>();
 let count=0,checks=0,centerFound=false;
 for(const t of triangles(patches)){
   if(!centerFound&&inside(anchorXY,t)){result.center.copy(world(anchorXY,t,offset));centerFound=true;}
   const bounds=bbox(t.xy);
   const segmentIds=new Set<number>();for(const cell of cells(bounds))for(const id of segmentGrid.get(cell)??[])segmentIds.add(id);
   for(const segmentId of segmentIds){const segment=segments[segmentId]!;if(!overlaps(bounds,segment.bounds))continue;
     if(++checks>400000)throw new Error('Ground clipping exceeds 400000 intersection checks; reduce geometry size.');
     const interval=clipLine(segment.a,segment.b,t);if(!interval)continue;
     const key=`${segment.group}/${segment.index}/${interval[0].toFixed(9)}/${interval[1].toFixed(9)}`;if(dedup.has(key))continue;dedup.add(key);
     const a=segment.a.clone().lerp(segment.b,interval[0]),b=segment.a.clone().lerp(segment.b,interval[1]);
     pieces.push({group:segment.group,index:segment.index,at:interval[0],path:[world(a,t,offset),world(b,t,offset)],normal:t.normal});
   }
   const candidates=new Set<number>();for(const cell of cells(bounds))for(const id of grid.get(cell)??[])candidates.add(id);
   for(const id of candidates){if(!overlaps(bounds,sourceBoxes[id]!))continue;if(++checks>400000)throw new Error('Ground clipping budget exceeded.');
     const polygon=clipPolygon(sourceTriangles[id]!,t);
     for(let i=1;i+1<polygon.length;i++)for(const p of [polygon[0]!,polygon[i]!,polygon[i+1]!]){
       const point=world(p,t,offset);result.fill.push(point.x,point.y,point.z);result.uvs.push((p.x-areaBounds[0])/spanX,1-(p.y-areaBounds[1])/spanY);
     }
   }
   if(result.fill.length/3+pieces.length*2>150000)throw new Error('Ground geometry exceeds 150000 output vertices.');
   if(++count%128===0)yield;
 }
 pieces.sort((a,b)=>a.group-b.group||a.index-b.index||a.at-b.at);
 for(const piece of pieces){result.paths.push(piece.path);result.normals.push(piece.normal);result.groups.push(piece.group);}
 if(!centerFound){const p=result.paths[0]?.[0];if(p)result.center.copy(p);else if(result.fill.length)result.center.fromArray(result.fill);}
 result.vertices=result.fill.length/3+pieces.length*2;
 result.anchorReady=centerFound;
 if(!centerFound&&definition.type!=='polyline'&&definition.type!=='polygon')throw new Error('Ground anchor is outside displayed coverage.');
 return result;
}
