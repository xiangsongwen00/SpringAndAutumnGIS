import * as THREE from 'three';
import { Ellipsoid } from '../core/geo/Ellipsoid';

type Cached={signature:string;vertices:Float64Array;bounds:THREE.Box3};
const cache=new WeakMap<THREE.BufferGeometry,Cached>();

/** CPU counterpart of the existing raster vertex shader, including the DISPLAYED DEM and ECEF edge overrides. */
export function intersectRasterSurface(ray:THREE.Ray,mesh:THREE.Mesh<THREE.BufferGeometry,THREE.ShaderMaterial>,
  ellipsoid:Ellipsoid,maximumDistance=Infinity):THREE.Vector3|null {
  const uniforms=mesh.material.uniforms,g=mesh.geometry,position=g.getAttribute('position'),uv=g.getAttribute('uv');
  const mask=g.getAttribute('terrainEdgeMask'),high=g.getAttribute('terrainEdgeHigh'),low=g.getAttribute('terrainEdgeLow');
  const value=<T>(name:string):T=>uniforms[name]!.value as T;
  const texture=value<THREE.DataTexture|null>('terrainTexture'),image=texture?.image as {data:Float32Array;width:number;height:number}|undefined;
  const scale=value<THREE.Vector2>('terrainUvScale'),offset=value<THREE.Vector2>('terrainUvOffset');
  const signature=[texture?.uuid,texture?.version,value('hasTerrain'),scale.x,scale.y,offset.x,offset.y,value('terrainExaggeration'),
    (mask as THREE.BufferAttribute).version,(high as THREE.BufferAttribute).version,(low as THREE.BufferAttribute).version].join('|');
  let state=cache.get(g);
  if(!state||state.signature!==signature){
    const vertices=new Float64Array(position.count*3),bounds=new THREE.Box3();
    const lon=value<THREE.Vector2>('tileLongitudeSinCos'),lat=value<THREE.Vector2>('tileLatitudeSinCos'),merc=value<THREE.Vector2>('tileMercatorSinhCosh');
    const centerLon=Math.atan2(lon.x,lon.y),centerMerc=Math.asinh(merc.x),lonSpan=value<number>('tileLongitudeSpan'),mercSpan=value<number>('tileMercatorSpan');
    const origin=value<THREE.Vector3>('sag_originHigh').clone().add(value<THREE.Vector3>('sag_originLow'));
    const east=value<THREE.Vector3>('sag_east'),north=value<THREE.Vector3>('sag_north'),up=value<THREE.Vector3>('sag_up'),radii=value<THREE.Vector2>('sag_curvatureRadii');
    const point=new THREE.Vector3();
    for(let i=0;i<position.count;i++){
      if(mask.getX(i)>.5)point.set(high.getX(i)+low.getX(i),high.getY(i)+low.getY(i),high.getZ(i)+low.getZ(i));
      else{
        const du=(position.getX(i)-.5)*lonSpan,dm=(position.getY(i)-.5)*mercSpan;
        let h=0;if(value<boolean>('hasTerrain')&&image){
          const x=THREE.MathUtils.clamp(offset.x+uv.getX(i)*scale.x,0,1)*(image.width-1),y=THREE.MathUtils.clamp(offset.y+uv.getY(i)*scale.y,0,1)*(image.height-1);
          const x0=Math.floor(x),y0=Math.floor(y),x1=Math.min(image.width-1,x0+1),y1=Math.min(image.height-1,y0+1),tx=x-x0,ty=y-y0;
          h=(texture?.magFilter===THREE.NearestFilter?image.data[Math.min(image.height-1,Math.floor(y+.5))*image.width+Math.min(image.width-1,Math.floor(x+.5))]!:
            THREE.MathUtils.lerp(THREE.MathUtils.lerp(image.data[y0*image.width+x0]!,image.data[y0*image.width+x1]!,tx),
            THREE.MathUtils.lerp(image.data[y1*image.width+x0]!,image.data[y1*image.width+x1]!,tx),ty))*value<number>('terrainExaggeration');
          h-=g.getAttribute('skirt').getX(i)*value<number>('terrainSkirtDepth');
        }
        if(value<boolean>('sag_useLocalCoordinates')){
          const dlat=lat.y*dm-.5*lat.x*lat.y*dm*dm,mid=dlat*.5;
          const e=radii.x*(lat.y*Math.cos(mid)-lat.x*Math.sin(mid))*du,n=radii.y*dlat,z=-.5*(e*e/radii.x+n*n/radii.y)+h;
          point.copy(origin).addScaledVector(east,e).addScaledVector(north,n).addScaledVector(up,z);
        }else ellipsoid.cartographicToCartesian({longitude:THREE.MathUtils.radToDeg(centerLon+du),latitude:THREE.MathUtils.radToDeg(Math.atan(Math.sinh(centerMerc+dm))),height:h+value<number>('sag_heightOffset')},point);
      }
      vertices.set([point.x,point.y,point.z],i*3);bounds.expandByPoint(point);
    }state={signature,vertices,bounds};cache.set(g,state);
  }
  const boxHit=ray.intersectBox(state.bounds,new THREE.Vector3());if(!boxHit||!state.bounds.containsPoint(ray.origin)&&ray.origin.distanceTo(boxHit)>maximumDistance)return null;
  const a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3(),hit=new THREE.Vector3();let best:THREE.Vector3|null=null;
  const index=g.index;if(!index)return null;
  for(let i=0;i<index.count;i+=3){a.fromArray(state.vertices,index.getX(i)*3);b.fromArray(state.vertices,index.getX(i+1)*3);c.fromArray(state.vertices,index.getX(i+2)*3);
    if(ray.intersectTriangle(a,b,c,false,hit)){const distance=ray.origin.distanceTo(hit);if(distance<maximumDistance){maximumDistance=distance;best=hit.clone();}}}
  return best;
}
