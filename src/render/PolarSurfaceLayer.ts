import * as THREE from 'three';
import { Ellipsoid } from '../core/geo/Ellipsoid';
import { CoordinateTransform,WEB_MERCATOR_MAX_LATITUDE } from '../core/coordinates/CoordinateTransform';
import type { RasterTileLayer } from './RasterTileLayer';
import { rasterSurfaceGeometry } from './RasterSurfacePicker';
import { globeCoordinateShader } from './shaders/coordinates';
import type { SurfaceRayHit } from '../core/geo/SurfacePicker';
import {PolarAppearance,type PolarAppearanceOptions,type PolarAppearanceState} from './PolarAppearance';

type CapMesh=THREE.Mesh<THREE.BufferGeometry,THREE.ShaderMaterial>;
type Border=ReturnType<RasterTileLayer['polarBorderMeshes']>[number];
export type PolarSurfaceLayerOptions=PolarAppearanceOptions&{northColor?:THREE.ColorRepresentation;southColor?:THREE.ColorRepresentation};
/** Display completion only, NOT an Arctic/Antarctic imagery or DEM provider. */
export class PolarSurfaceLayer {
  readonly object3d=new THREE.Group();
  private readonly coordinates:CoordinateTransform;
  private readonly caps=new Map<boolean,CapMesh>();
  private readonly edges=new Map<string,{signature:string;mesh:CapMesh}>();
  private detail=0;
  private source:string|null=null;
  private generation=0;
  get revision():number{return this.generation;}
  private readonly coverageSignatures=new Map<boolean,string>();
  private readonly cameraHigh=new THREE.Vector3();
  private readonly cameraLow=new THREE.Vector3();
  private readonly northColor:THREE.Color;
  private readonly southColor:THREE.Color;
  private readonly appearance:PolarAppearance;
  get appearanceState():PolarAppearanceState{return this.appearance.state;}
  setRenderer(renderer:THREE.WebGLRenderer):void{this.appearance.setRenderer(renderer);}
  constructor(private readonly ellipsoid=Ellipsoid.WGS84,options:PolarSurfaceLayerOptions={}){
    this.coordinates=new CoordinateTransform(ellipsoid);
    // Distinct no-data semantics: Arctic ocean versus Antarctic ice/land.
    // These colours are not a claim about actual sea-ice extent or imagery.
    this.northColor=new THREE.Color(options.northColor??'#244d66');
    this.southColor=new THREE.Color(options.southColor??'#edf2f6');
    this.appearance=new PolarAppearance(this.northColor,this.southColor,options);
  }
  update(camera:THREE.PerspectiveCamera,raster:RasterTileLayer|null):void{
    this.appearance.update(raster);
    const p=this.coordinates.worldToGeodetic(camera.position),horizon=THREE.MathUtils.radToDeg(Math.acos(this.ellipsoid.polarRadius/(this.ellipsoid.polarRadius+Math.max(0,p.height))));
    const visibility=new Map([[true,p.latitude+horizon+6>=WEB_MERCATOR_MAX_LATITUDE],[false,-p.latitude+horizon+6>=WEB_MERCATOR_MAX_LATITUDE]]);
    const near=Math.abs(p.latitude)>80&&p.height<100000;
    // Two bounded quality tiers; no network LOD, hysteresis avoids zoom oscillation.
    const detail=near?2:this.detail===2&&Math.abs(p.latitude)>79&&p.height<140000?2:1;
    if(detail!==this.detail){this.generation++;this.detail=detail;this.coverageSignatures.clear();for(const m of this.caps.values())this.release(m);this.caps.clear();
      for(const north of [true,false]){const m=this.makeMesh(north);m.geometry.dispose();m.geometry=this.capGeometry(north,detail===2?512:128,detail===2?64:16);this.caps.set(north,m);this.object3d.add(m);}}
    for(const [north,m] of this.caps)m.visible=visibility.get(north)!;
    split(camera.position,this.cameraHigh,this.cameraLow);
    const source=raster?.object3d.uuid??null;if(source!==this.source){for(const item of this.edges.values())this.release(item.mesh);this.edges.clear();this.source=source;}
    const wanted=new Set<string>();
    const covered=new Map<boolean,[number,number][]>([[true,[]],[false,[]]]);
    if(raster)for(const border of raster.polarBorderMeshes()){
      if(!visibility.get(border.north))continue;
      const u=border.mesh.material.uniforms,key=`${border.north}/${border.id.level}/${border.id.x}`;
      wanted.add(key);
      const n=2**border.id.level;covered.get(border.north)!.push([border.id.x/n*360-180,(border.id.x+1)/n*360-180]);
      // Reuse the displayed vertex mirror. Not the newest/unpublished DEM.
      const data=rasterSurfaceGeometry(border.mesh,this.ellipsoid);
      const signature=`${data.signature}/${detail}`;
      let item=this.edges.get(key);
      if(!item){item={signature:'',mesh:this.makeMesh(border.north)};item.mesh.renderOrder=1;this.edges.set(key,item);this.object3d.add(item.mesh);}
      if(item.signature!==signature){this.generation++;const next=this.edgeGeometry(border,data.vertices,detail===2?64:16);item.mesh.geometry.dispose();item.mesh.geometry=next;item.signature=signature;}
      const uniforms=item.mesh.material.uniforms;uniforms.map!.value=u.tileTexture!.value;uniforms.hasMap!.value=u.hasTexture!.value;
      uniforms.scale!.value.copy(u.uvScale!.value);uniforms.offset!.value.copy(u.uvOffset!.value);
      // Source imagery is borrowed only until the next raster update, with no extra texture allocation/cache ownership.
      item.mesh.visible=true;
    }
    for(const [key,item] of this.edges)if(!wanted.has(key)){this.release(item.mesh);this.edges.delete(key);}
    // Remove the neutral background beneath borrowed sectors, including negative
    // heights. Otherwise zero-height completion could cover a valid below-sea DEM.
    for(const north of [true,false]){const ranges=covered.get(north)!,signature=JSON.stringify(ranges);
      if(signature!==this.coverageSignatures.get(north)){this.generation++;const cap=this.caps.get(north)!;cap.geometry.dispose();cap.geometry=this.capGeometry(north,detail===2?512:128,detail===2?64:16,ranges);this.coverageSignatures.set(north,signature);}}
    for(const [north,mesh] of this.caps){mesh.material.uniforms.atlas!.value=this.appearance.texture(north);mesh.material.uniforms.hasAtlas!.value=!!this.appearance.texture(north);}
    for(const item of this.edges.values()){const north=item.mesh.position.y>0;item.mesh.material.uniforms.atlas!.value=this.appearance.texture(north);item.mesh.material.uniforms.hasAtlas!.value=!!this.appearance.texture(north);}
  }
  /** Navigation clearance on the DISPLAYED completion, never exposed as measured DEM. */
  surfaceHeight(longitude:number,latitude:number):number|null{
    if(Math.abs(latitude)<=WEB_MERCATOR_MAX_LATITUDE||Math.abs(latitude)>90)return null;
    if(Math.abs(latitude)===90)return 0; // All cap sectors share this exact tip.
    const north=latitude>0,lon=((longitude+180)%360+360)%360-180,lat=THREE.MathUtils.degToRad(latitude),l=THREE.MathUtils.degToRad(longitude);
    const ray=new THREE.Ray(this.ellipsoid.cartographicToCartesian({longitude,latitude,height:100000}),new THREE.Vector3(-Math.cos(lat)*Math.sin(l),-Math.sin(lat),-Math.cos(lat)*Math.cos(l)));
    let height:number|null=null;
    for(const mesh of [...this.edges.values()].map(item=>item.mesh).concat([...this.caps.values()])){
      if(!mesh.visible||Math.sign(mesh.position.y)!==(north?1:-1))continue;
      const {columns,rows,skipped}=mesh.geometry.userData as {columns:number[];rows:number;skipped:Set<number>};let x=lon;if(x<columns[0]!)x+=360;
      if(x<columns[0]!||x>columns[columns.length-1]!)continue;
      let lo=0,hi=columns.length-1;while(hi-lo>1){const m=(lo+hi)>>1;if(columns[m]!<=x)lo=m;else hi=m;}
      const row=Math.min(rows-1,Math.floor((Math.abs(latitude)-WEB_MERCATOR_MAX_LATITUDE)/(90-WEB_MERCATOR_MAX_LATITUDE)*rows)),positions=mesh.geometry.getAttribute('position');
      const localRay=ray.clone();localRay.origin.sub(mesh.position);const vertex=(i:number)=>new THREE.Vector3().fromBufferAttribute(positions,i);
      for(let r=Math.max(0,row-1);r<=Math.min(rows-1,row+1);r++)for(let c=Math.max(0,lo-1);c<=Math.min(columns.length-2,lo+1);c++){
        if(skipped.has(c))continue;const a=r*columns.length+c,b=a+1,d=a+columns.length,e=d+1;
        for(const ids of [[a,d,b],[b,d,e]]){const hit=localRay.intersectTriangle(vertex(ids[0]!),vertex(ids[1]!),vertex(ids[2]!),false,new THREE.Vector3());
          if(hit){const h=this.coordinates.worldToGeodetic(hit.add(mesh.position)).height;height=height===null?h:Math.max(height,h);}}
      }
    }
    return height;
  }
  pickSurface(ray:THREE.Ray):SurfaceRayHit|null{
    this.object3d.updateMatrixWorld(true);const caster=new THREE.Raycaster();caster.ray.copy(ray);
    const meshes=[...this.edges.values()].map(item=>item.mesh).concat([...this.caps.values()]).filter(m=>m.visible);
    const hit=caster.intersectObjects(meshes,false).find(h=>h.point.clone().normalize().dot(ray.origin.clone().sub(h.point))>=0);
    if(hit)return {world:hit.point,approximation:'polar-cap'};
    // Numerical edge tests can miss the common tip of a triangle fan. Snap only
    // a sub-millimetre ray miss to the actual displayed vertex, never a broad area.
    for(const cap of this.caps.values())if(cap.visible&&ray.direction.dot(cap.position.clone().sub(ray.origin))>=0&&cap.position.dot(ray.origin.clone().sub(cap.position))>=0&&ray.distanceSqToPoint(cap.position)<1e-6)
      return {world:cap.position.clone(),approximation:'polar-cap'};
    return null;
  }
  dispose():void{for(const m of this.caps.values())this.release(m);for(const item of this.edges.values())this.release(item.mesh);this.caps.clear();this.edges.clear();this.appearance.dispose();}
  private release(mesh:CapMesh):void{mesh.removeFromParent();mesh.geometry.dispose();mesh.material.uniforms.map!.value=null;mesh.material.uniforms.atlas!.value=null;mesh.material.dispose();}
  private makeMesh(north:boolean):CapMesh{
    const origin=new THREE.Vector3(0,(north?1:-1)*this.ellipsoid.polarRadius,0),high=new THREE.Vector3(),low=new THREE.Vector3();split(origin,high,low);
    const material=new THREE.ShaderMaterial({side:THREE.DoubleSide,depthTest:true,depthWrite:true,depthFunc:THREE.LessEqualDepth,toneMapped:false,
      uniforms:{sag_cameraHigh:{value:this.cameraHigh},sag_cameraLow:{value:this.cameraLow},originHigh:{value:high},originLow:{value:low},
        map:{value:null},hasMap:{value:false},scale:{value:new THREE.Vector2(1,1)},offset:{value:new THREE.Vector2()},capColor:{value:(north?this.northColor:this.southColor).clone()},atlas:{value:null},hasAtlas:{value:false}},
      vertexShader:`#include <common>
        #include <logdepthbuf_pars_vertex>
        ${globeCoordinateShader}
        uniform vec3 originHigh;uniform vec3 originLow;attribute float capProgress;attribute float capLongitude;varying float progress;varying float mapU;varying vec2 edgeUv;
        void main(){progress=capProgress;mapU=capLongitude;edgeUv=uv;gl_Position=sag_projectLocalToEye(position,originHigh,originLow);
        #include <logdepthbuf_vertex>
        }`,
      fragmentShader:`#include <logdepthbuf_pars_fragment>
        uniform sampler2D map;uniform bool hasMap;uniform sampler2D atlas;uniform bool hasAtlas;uniform vec2 scale;uniform vec2 offset;uniform vec3 capColor;varying float progress;varying float mapU;varying vec2 edgeUv;
        void main(){vec2 q=offset+edgeUv*scale;vec4 texel=hasMap?texture2D(map,vec2(q.x,1.0-q.y)):vec4(capColor,1.0);vec3 edge=mix(capColor,texel.rgb,texel.a);
          // The WHOLE cap uses the current provider's prepared atlas. Only the
          // exact seam keeps direct UV sampling; centre pixels converge per map.
          vec3 interior=hasAtlas?texture2D(atlas,vec2(mapU,progress*(31.0/32.0)+0.5/32.0)).rgb:capColor;
          gl_FragColor=vec4(hasMap?mix(edge,interior,smoothstep(0.0,0.08,progress)):interior,1.0);
          #include <logdepthbuf_fragment>
          #include <colorspace_fragment>
        }`});
    const mesh=new THREE.Mesh(new THREE.BufferGeometry(),material);mesh.position.copy(origin);mesh.frustumCulled=false;mesh.renderOrder=0;return mesh;
  }
  private capGeometry(north:boolean,segments:number,rows:number,ranges:readonly [number,number][]=[]):THREE.BufferGeometry{
    const longitudes=new Set<number>();for(let i=0;i<=segments;i++)longitudes.add(-180+360*i/segments);for(const [west,east] of ranges){longitudes.add(west);longitudes.add(east);}
    const points=[...longitudes].sort((a,b)=>a-b).map(longitude=>({longitude,latitude:(north?1:-1)*WEB_MERCATOR_MAX_LATITUDE,height:0}));
    const skipped=new Set<number>();for(let i=0;i<points.length-1;i++){const mid=(points[i]!.longitude+points[i+1]!.longitude)/2;if(ranges.some(([west,east])=>mid>west&&mid<east))skipped.add(i);}
    return this.geometry(north,points,rows,undefined,undefined,undefined,skipped);
  }
  private edgeGeometry(border:Border,vertices:Float64Array,rows:number):THREE.BufferGeometry{
    const uv=border.mesh.geometry.getAttribute('uv'),ids:number[]=[];
    for(let i=0;i<uv.count;i++)if(Math.abs(uv.getY(i)-(border.north?0:1))<1e-8)ids.push(i);
    ids.sort((a,b)=>uv.getX(a)-uv.getX(b));
    // Raster geometry includes duplicate perimeter/skirt vertices at the same
    // UV (skirt depth is zero). Keep one copy, otherwise cap cells degenerate
    // and binary-search navigation can land on a run of zero-width columns.
    for(let i=ids.length-1;i>0;i--)if(Math.abs(uv.getX(ids[i]!)-uv.getX(ids[i-1]!))<1e-10)ids.splice(i,1);
    const points:Array<{longitude:number;latitude:number;height:number}>=[],xs:number[]=[],worlds:number[]=[],denseIds:number[]=[];
    for(let j=0;j<ids.length-1;j++){
      const a=ids[j]!,b=ids[j+1]!,wa=new THREE.Vector3().fromArray(vertices,a*3),wb=new THREE.Vector3().fromArray(vertices,b*3),pa=this.coordinates.worldToGeodetic(wa),pb=this.coordinates.worldToGeodetic(wb);
      const delta=((pb.longitude-pa.longitude+540)%360)-180,steps=Math.max(1,Math.ceil(Math.abs(delta)/(360/(rows>=64?512:128))));
      for(let k=0;k<steps;k++){const t=k/steps,p=wa.clone().lerp(wb,t);denseIds.push(points.length);worlds.push(p.x,p.y,p.z);xs.push(uv.getX(a)+(uv.getX(b)-uv.getX(a))*t);
        points.push({longitude:pa.longitude+delta*t,latitude:pa.latitude+(pb.latitude-pa.latitude)*t,height:pa.height+(pb.height-pa.height)*t});}
    }
    const last=ids[ids.length-1]!;denseIds.push(points.length);worlds.push(vertices[last*3]!,vertices[last*3+1]!,vertices[last*3+2]!);points.push(this.coordinates.worldToGeodetic(new THREE.Vector3().fromArray(vertices,last*3)));xs.push(uv.getX(last));
    const span=360/2**border.id.level,west=border.id.x*span-180;
    for(let i=0;i<points.length;i++){const p=points[i]!,reference=west+xs[i]!*span;p.longitude+=Math.round((reference-p.longitude)/360)*360;}
    return this.geometry(border.north,points,rows,xs,new Float64Array(worlds),denseIds);
  }
  private geometry(north:boolean,points:readonly {longitude:number;latitude:number;height:number}[],rows:number,xs?:number[],edge?:Float64Array,ids?:number[],skipped=new Set<number>()):THREE.BufferGeometry{
    const origin=new THREE.Vector3(0,(north?1:-1)*this.ellipsoid.polarRadius,0),positions:number[]=[],uv:number[]=[],progress:number[]=[],longitudes:number[]=[],index:number[]=[],count=points.length;
    for(let r=0;r<=rows;r++){const t=r/rows,fade=(1-t)**2*(1+2*t);
      for(let i=0;i<count;i++){const p=points[i]!,world=r===rows?origin.clone():r===0&&edge&&ids?new THREE.Vector3().fromArray(edge,ids[i]!*3):this.ellipsoid.cartographicToCartesian({longitude:p.longitude,
        latitude:p.latitude+( (north?90:-90)-p.latitude)*t,height:p.height*fade});world.sub(origin);positions.push(world.x,world.y,world.z);uv.push(xs?.[i]??i/(count-1),north?0:1);progress.push(t);longitudes.push((p.longitude+180)/360);}}
    for(let r=0;r<rows;r++)for(let i=0;i<count-1;i++){if(skipped.has(i))continue;const a=r*count+i,b=a+1,c=a+count,d=c+1;index.push(a,c,b,b,c,d);}
    const geometry=new THREE.BufferGeometry();geometry.userData={columns:points.map(p=>p.longitude),rows,skipped};geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));geometry.setAttribute('capProgress',new THREE.Float32BufferAttribute(progress,1));geometry.setAttribute('capLongitude',new THREE.Float32BufferAttribute(longitudes,1));geometry.setIndex(index);return geometry;
  }
}
function split(p:THREE.Vector3,high:THREE.Vector3,low:THREE.Vector3):void{high.set(Math.fround(p.x),Math.fround(p.y),Math.fround(p.z));low.copy(p).sub(high);}
