import * as THREE from 'three';
import { Ellipsoid } from '../core/geo/Ellipsoid';
import { EntityCollection, entityAnchor, wrapLongitude } from '../sdk/EntityCollection';
import type { EntityDefinition, EntityPosition, EntityPickOptions, ScreenPosition, LabelSymbol, LineTexture, EntityResourceState } from '../sdk/EntityTypes';
import type { GlobeSceneLayer } from '../engine/GlobeEngine';

type Rendered = { definition: EntityDefinition; group: THREE.Group; center: THREE.Vector3; radius: number;
  geometries: THREE.BufferGeometry[]; materials: THREE.ShaderMaterial[]; textures: THREE.Texture[];
  paths: THREE.Vector3[][]; images: ImageEntry[]; imageBindings: { entry: ImageEntry; ready: THREE.IUniform }[]; labelBytes:number; limited:boolean;
  iconRotation?: THREE.IUniform; animations: { uniform: THREE.IUniform; repeat: number; speed: number | readonly [number,number]; base: readonly [number,number] }[];
  stroke?: { attribute: THREE.BufferAttribute; version: number };
  label?: { mesh: THREE.Mesh; width: number; height: number; offset: readonly [number, number] } };
type ImageEntry = { url: string; texture: THREE.Texture; references: number; bytes:number; controller: AbortController; state: 'loading'|'ready'|'error' };
const projection = /* glsl */ `
uniform vec3 originHigh, originLow, eyeHigh, eyeLow;
vec4 projectWorld(vec3 p) {
  vec3 relative = (originHigh - eyeHigh) + (originLow - eyeLow) + p;
  return projectionMatrix * vec4(mat3(viewMatrix) * relative, 1.0);
}`;
const fragmentStart = `#include <logdepthbuf_pars_fragment>\nuniform vec3 color; uniform float opacity;`;
const fragmentEnd = `\n#include <logdepthbuf_fragment>\n#include <colorspace_fragment>\n`;

/** SDK objects are independent scene overlays. No imagery/DEM request or LOD selection is changed. */
export class EntityLayer implements GlobeSceneLayer {
  readonly object3d = new THREE.Group();
  private readonly rendered = new Map<string, Rendered>();
  private readonly dirty = new Set<string>();
  private ordered: Rendered[] = [];
  private orderDirty = true;
  private readonly imageCache = new Map<string,ImageEntry>();
  private readonly imageQueue = new Set<ImageEntry>();
  private activeImages = 0;
  /** Shared estimated RGBA upload budget, including labels; excludes transient decode buffers. */
  private textureBytes = 0;
  private readonly animationStart = performance.now();
  private readonly previousMatrix = new THREE.Matrix4();
  private cameraVersion = 0;
  private lastWidth = 0;
  private lastHeight = 0;
  private readonly eyeHigh = new THREE.Vector3();
  private readonly eyeLow = new THREE.Vector3();
  private readonly viewport = new THREE.Vector2(1, 1);
  private readonly frustum = new THREE.Frustum();
  private readonly matrix = new THREE.Matrix4();
  private readonly unsubscribe: () => void;
  private readonly ellipsoidRay = new THREE.Vector3();
  private disposed = false;
  constructor(private readonly ellipsoid: Ellipsoid, private readonly entities: EntityCollection) {
    for (const value of entities.values) this.dirty.add(value.id);
    this.unsubscribe = entities.onChange(change => {
      if (change.type === 'clear') { this.ordered=[]; for (const id of this.rendered.keys()) this.release(id); this.dirty.clear(); }
      else if (change.id && change.type === 'remove') { this.dirty.delete(change.id); this.release(change.id); }
      else if (change.id) {
        // A hidden object must disappear immediately, even while a geometry update waits its turn.
        const item = this.rendered.get(change.id);
        if (item) item.group.visible = entities.getById(change.id)?.visible !== false;
        const latest=entities.getById(change.id);
        const directionOnly=item?.definition.type==='point' && latest?.type==='point' && change.fields?.length===1 && change.fields[0]==='symbol' &&
          JSON.stringify({...item.definition.symbol,heading:0,alignment:0})===JSON.stringify({...latest.symbol,heading:0,alignment:0});
        if(item && (directionOnly || change.fields?.every(field=>['visible','name','properties'].includes(field)))) item.definition=latest!;
        else this.dirty.add(change.id);
      }
      this.object3d.visible = !entities.isDestroyed && entities.visible;
    });
  }
  update(camera: THREE.PerspectiveCamera, width: number, height: number): void {
    if (this.disposed || this.entities.isDestroyed) return;
    split(camera.position, this.eyeHigh, this.eyeLow); this.viewport.set(width, height);
    // Rebuild only changed entities, not all geometry/text every frame. Soft, not preemptive, budget.
    const started = performance.now(); let built = 0;
    for (const id of this.dirty) {
      const definition = this.entities.getById(id);
      if (definition) {
        const next = this.build(definition);
        this.release(id); this.rendered.set(id, next); this.object3d.add(next.group); this.orderDirty=true;
      }
      this.dirty.delete(id);
      if (++built >= 8 || performance.now() - started >= 2) break;
    }
    camera.updateMatrixWorld();
    this.frustum.setFromProjectionMatrix(this.matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    if(!this.matrix.equals(this.previousMatrix)||width!==this.lastWidth||height!==this.lastHeight){this.previousMatrix.copy(this.matrix);this.cameraVersion++;this.lastWidth=width;this.lastHeight=height;}
    const elapsed=(performance.now()-this.animationStart)/1000;
    const occupied = new Set<string>(); let labelCount = 0;
    if(this.orderDirty){this.ordered=[...this.rendered.values()].sort((a,b)=>(b.definition.order??500)-(a.definition.order??500));this.orderDirty=false;}
    for (const item of this.ordered) {
      const overlay=item.definition.type==='label'?item.definition.label.occlusion==='overlay':item.definition.symbol?.occlusion==='overlay';
      item.group.visible = item.definition.visible !== false && this.frustum.intersectsSphere(new THREE.Sphere(item.center, item.radius + 100)) &&
        (item.radius > 100000&&!overlay || !this.occluded(camera.position, item.center, item.radius));
      if(item.group.visible){
        for(const binding of item.imageBindings)binding.ready.value=binding.entry.state==='ready'?1:0;
        for(const animation of item.animations){
          if(typeof animation.speed==='number')animation.uniform.value=(elapsed*animation.speed)%animation.repeat;
          else (animation.uniform.value as THREE.Vector2).set((animation.base[0]+elapsed*animation.speed[0])%1,(animation.base[1]+elapsed*animation.speed[1])%1);
        }
        if(item.stroke&&item.stroke.version!==this.cameraVersion)this.updateStroke(item,camera);
        if(item.iconRotation&&item.definition.type==='point'){
          const s=item.definition.symbol;
          item.iconRotation.value=(s?.alignment==='screen'?0:this.northAngle(item,camera))+THREE.MathUtils.degToRad((s?.heading??0)-(s?.icon?.sourceHeading??0));
        }
      }
      if (!item.label) continue;
      const box = this.labelBox(item, camera);
      item.label.mesh.visible = false;
      if (!item.group.visible || !box || (item.definition.label?.opacity ?? 1) === 0 || labelCount >= 256) continue;
      const cells: string[] = [];
      for (let x = Math.floor(box[0] / 32); x <= Math.floor(box[2] / 32); x++)
        for (let y = Math.floor(box[1] / 32); y <= Math.floor(box[3] / 32); y++) cells.push(`${x},${y}`);
      if (cells.some(cell => occupied.has(cell))) continue;
      cells.forEach(cell => occupied.add(cell)); item.label.mesh.visible = true; labelCount++;
    }
  }
  /** Screen-space object selection; excludes hidden, behind-globe and label-collision-suppressed objects. */
  pick(screen: ScreenPosition, camera: THREE.PerspectiveCamera, options: EntityPickOptions = {},surfaceDepth:number|null=null): EntityDefinition | null {
    const tolerance = options.tolerance ?? 6;
    if (!Number.isFinite(screen.x) || !Number.isFinite(screen.y) || !Number.isFinite(tolerance) || tolerance < 0 || tolerance > 64) throw new Error('Invalid screen position or pick tolerance.');
    if (!this.object3d.visible) return null;
    const hits: { definition: EntityDefinition; distance: number; order: number }[] = [];
    for (const item of this.rendered.values()) {
      if (!item.group.visible || this.entities.getById(item.definition.id)?.visible === false) continue;
      let hit = false;
      const depth=-item.center.clone().applyMatrix4(camera.matrixWorldInverse).z;
      const depthVisible=surfaceDepth===null||depth<=surfaceDepth+0.5;
      if (item.label?.mesh.visible) {
        const b = this.labelBox(item, camera);
        hit = (depthVisible||!(item.label.mesh.material as THREE.ShaderMaterial).depthTest) && !!b && screen.x >= b[0] - tolerance && screen.y >= b[1] - tolerance && screen.x <= b[2] + tolerance && screen.y <= b[3] + tolerance;
      }
      const definition = item.definition;
      const geometryVisible=definition.type!=='label' && (definition.symbol?.opacity ?? 1)>0;
      if (definition.type === 'point' && geometryVisible && (depthVisible||definition.symbol?.occlusion==='overlay')) {
        const p = this.project(item.center, camera);
        const dx=p ? Math.abs(screen.x-p.x) : Infinity,dy=p ? Math.abs(screen.y-p.y) : Infinity;
        const shape=definition.symbol?.shape ?? 'circle',distance=shape==='square'?Math.max(dx,dy):shape==='diamond'?dx+dy:Math.hypot(dx,dy);
        const icon=definition.symbol?.icon;
        if(icon){const angle=item.iconRotation?.value ?? 0,c=Math.cos(angle),s=Math.sin(angle),x=p?screen.x-p.x:Infinity,y=p?screen.y-p.y:Infinity;
          hit ||=!!p && !this.occluded(camera.position,item.center) && Math.abs(c*x+s*y)<=(icon.width??definition.symbol?.size??32)/2+tolerance && Math.abs(s*x-c*y)<=(icon.height??definition.symbol?.size??32)/2+tolerance;
        }else hit ||= !!p && !this.occluded(camera.position, item.center) && distance <= (definition.symbol?.size ?? 12) / 2 + tolerance;
      } else if ((definition.type === 'polygon' || definition.type === 'polyline') && geometryVisible) {
        const projected = item.paths.map(path => path.map(p => this.occluded(camera.position, p) ? null : this.project(p, camera)));
        const width = definition.type === 'polyline' ? definition.symbol?.width ?? 3 : definition.symbol?.outlineWidth ?? 2;
        for (const path of projected) for (let index = 1; index < path.length; index++) {
          const a = path[index - 1], b = path[index];
          if (width > 0 && a && b && segmentDistance(screen, a, b) <= tolerance + width / 2) hit = true;
        }
        if (definition.type === 'polygon' && definition.symbol?.fill !== false && projected.every(path => path.every(Boolean))) {
          const rings = projected as ScreenPosition[][];
          hit ||= inRing(screen, rings[0]!) && !rings.slice(1).some(ring => inRing(screen, ring));
        }
      }
      if (hit) hits.push({ definition: this.entities.getById(definition.id)!, distance: camera.position.distanceToSquared(item.center), order: definition.order ?? 500 });
    }
    hits.sort((a, b) => b.order - a.order || a.distance - b.distance);
    return hits[0]?.definition ?? null;
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true; this.unsubscribe();
    this.ordered=[];
    for (const id of this.rendered.keys()) this.release(id);
    this.dirty.clear(); this.object3d.clear();
  }
  getResourceState(id:string): EntityResourceState|null {
    if(!this.entities.has(id))return null;
    const item=this.rendered.get(id);
    if(this.dirty.has(id))return {state:'pending',images:item?.images.length??0};
    const images=item?.images??[];
    return {state:item?.limited||images.some(e=>e.state==='error')?'error':!images.length?'none':images.some(e=>e.state==='loading')?'loading':'ready',images:images.length};
  }
  retryResources(id:string):boolean {
    if(!this.entities.has(id))return false;
    const item=this.rendered.get(id);let retried=false;
    for(const entry of item?.images??[])if(entry.state==='error'&&[...this.imageCache.values()].filter(image=>image.state!=='error').length<256){
      entry.controller=new AbortController();entry.state='loading';this.imageQueue.add(entry);retried=true;
    }
    if(item?.limited){this.dirty.add(id);retried=true;}
    this.pumpImages();return retried;
  }
  private release(id: string): void {
    const item = this.rendered.get(id); if (!item) return;
    this.object3d.remove(item.group); item.geometries.forEach(g => g.dispose()); item.materials.forEach(m => m.dispose()); item.textures.forEach(t => t.dispose());
    this.textureBytes-=item.labelBytes;
    for(const entry of item.images){if(--entry.references===0){entry.controller.abort();this.imageQueue.delete(entry);this.imageCache.delete(entry.url);this.textureBytes-=entry.bytes;entry.texture.dispose();const image=entry.texture.image as ImageBitmap|undefined;image?.close?.();}}
    item.group.clear();this.ordered=this.ordered.filter(value=>value!==item);
    this.rendered.delete(id); this.orderDirty=true;
  }
  private project(world: THREE.Vector3, camera: THREE.PerspectiveCamera): ScreenPosition | null {
    const view = world.clone().applyMatrix4(camera.matrixWorldInverse);
    if (-view.z < camera.near || -view.z > camera.far) return null;
    const p = view.applyMatrix4(camera.projectionMatrix);
    return { x: (p.x + 1) * this.viewport.x / 2, y: (1 - p.y) * this.viewport.y / 2 };
  }
  private labelBox(item: Rendered, camera: THREE.PerspectiveCamera): readonly [number, number, number, number] | null {
    const label = item.label!, p = this.project(item.center, camera);
    if (!p || this.occluded(camera.position, item.center)) return null;
    const x = p.x + label.offset[0], y = p.y + label.offset[1];
    if (x + label.width / 2 < 0 || x - label.width / 2 > this.viewport.x || y + label.height / 2 < 0 || y - label.height / 2 > this.viewport.y) return null;
    return [x - label.width / 2, y - label.height / 2, x + label.width / 2, y + label.height / 2];
  }
  private occluded(eye: THREE.Vector3, target: THREE.Vector3, margin = 0): boolean {
    const a = this.ellipsoid.equatorialRadius, b = this.ellipsoid.polarRadius;
    const origin = new THREE.Vector3(eye.x / a, eye.y / b, eye.z / a);
    const direction = this.ellipsoidRay.set((target.x - eye.x) / a, (target.y - eye.y) / b, (target.z - eye.z) / a);
    const aa = direction.lengthSq(), bb = 2 * origin.dot(direction), cc = origin.lengthSq() - 1;
    const discriminant = bb * bb - 4 * aa * cc;
    if (aa === 0 || discriminant < 0) return false;
    const t = (-bb - Math.sqrt(discriminant)) / (2 * aa);
    // Coarse displayed globe triangles lie below the analytic ellipsoid. Let GPU surface depth
    // decide their near-side occlusion rather than hiding a correctly picked negative-height anchor.
    const below=Math.max(0,1-Math.sqrt((target.x/a)**2+(target.y/b)**2+(target.z/a)**2))*a;
    return t > 0 && t < 1 - (margin + below + 5) / Math.max(1, eye.distanceTo(target));
  }
  private build(definition: EntityDefinition): Rendered {
    const anchor = entityAnchor(definition), center = this.world(anchor);
    const item: Rendered = { definition, center, radius: 0, group: new THREE.Group(), geometries: [], materials: [], textures: [], paths: [],images:[],imageBindings:[],animations:[],labelBytes:0,limited:false };
    if (definition.type === 'point') this.point(item);
    else if (definition.type !== 'label') {
      const rings = [definition.positions, ...(definition.type === 'polygon' ? definition.holes ?? [] : [])];
      item.paths = rings.map(ring => densify(ring, definition.type === 'polygon').map(p => this.world(p)));
      if (definition.type === 'polygon' && definition.symbol?.fill !== false) this.fill(item, definition);
      const color = definition.type === 'polyline' ? definition.symbol?.color ?? (definition.symbol?.texture?'#ffffff':'#32e6a1') : definition.symbol?.outlineColor ?? '#32e6a1';
      const width = definition.type === 'polyline' ? definition.symbol?.width ?? 3 : definition.symbol?.outlineWidth ?? 2;
      if (width > 0) this.lines(item, color, width, definition.symbol?.opacity ?? 1, definition.type === 'polyline' ? definition.symbol?.dash : undefined,definition.type==='polyline'?definition.symbol?.texture??undefined:undefined);
    }
    if (definition.label?.text) this.label(item, definition.label);
    for (const path of item.paths) for (const p of path) item.radius = Math.max(item.radius, center.distanceTo(p));
    item.group.visible = definition.visible !== false;
    return item;
  }
  private world(p: EntityPosition): THREE.Vector3 { return this.ellipsoid.cartographicToCartesian({ longitude: p[0], latitude: p[1], height: p[2] ?? 30 }); }
  private material(item: Rendered, vertexShader: string, fragmentShader: string, uniforms: Record<string, THREE.IUniform>,depthTest=true): THREE.ShaderMaterial {
    const high = new THREE.Vector3(), low = new THREE.Vector3(); split(item.center, high, low);
    const result = new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms: {
      originHigh: { value: high }, originLow: { value: low }, eyeHigh: { value: this.eyeHigh }, eyeLow: { value: this.eyeLow }, viewport: { value: this.viewport }, ...uniforms },
      transparent: true, depthTest, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    item.materials.push(result); return result;
  }
  private mesh(item: Rendered, geometry: THREE.BufferGeometry, material: THREE.ShaderMaterial, label = false): THREE.Mesh {
    item.geometries.push(geometry); const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false; mesh.renderOrder = Math.min(9000, (item.definition.order ?? 500) + (label ? 1 : 0)); item.group.add(mesh); return mesh;
  }
  private point(item: Rendered): void {
    if (item.definition.type !== 'point') return;
    const s = item.definition.symbol ?? {};
    const image=s.icon?this.acquireImage(item,s.icon.url):undefined,ready={value:0},rotation={value:0};
    if(image){item.imageBindings.push({entry:image,ready});item.iconRotation=rotation;}
    const material = this.material(item, billboardVertex, `${fragmentStart}
varying vec2 vUv; uniform int shape; uniform vec3 outlineColor; uniform float outlineWidth, size; uniform sampler2D image; uniform int imageReady;
void main() { vec2 p = abs(vUv * 2.0 - 1.0); float d = shape == 0 ? length(p) : shape == 1 ? max(p.x,p.y) : p.x+p.y;
if(imageReady==1){gl_FragColor=texture2D(image,vUv)*vec4(color,opacity);if(gl_FragColor.a<0.01)discard;}
else{if (d > 1.0) discard; gl_FragColor = vec4(d > 1.0 - 2.0*outlineWidth/size ? outlineColor : color, opacity);} ${fragmentEnd} }`, {
      image:{value:image?.texture??null},imageReady:ready,rotation,
      dimensions: { value: new THREE.Vector2(s.icon?.width??s.size??(s.icon?32:12),s.icon?.height??s.size??(s.icon?32:12)) }, offset: { value: new THREE.Vector2() }, size: { value: s.size ?? 12 },
      color: { value: new THREE.Color(s.color ?? (s.icon?'#ffffff':'#ffd166')) }, outlineColor: { value: new THREE.Color(s.outlineColor ?? '#ffffff') }, outlineWidth: { value: s.outlineWidth ?? 1 },
      opacity: { value: s.opacity ?? 1 }, shape: { value: s.shape === 'square' ? 1 : s.shape === 'diamond' ? 2 : 0 } },s.occlusion!=='overlay');
    this.mesh(item, quad(), material);
  }
  private lines(item: Rendered, color: string, width: number, opacity: number, dash?: readonly [number, number],pattern?:LineTexture): void {
    const positions: number[] = [], next: number[] = [], sides: number[] = [], distances: number[] = [];
    for (const path of item.paths) for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!.clone().sub(item.center), b = path[i]!.clone().sub(item.center);
      // Each quad is independent: bounded simple strokes with butt ends, no platform linewidth limitation.
      for (const [p, q, sign, along] of [[a,b,1,0],[a,b,-1,0],[b,a,-1,1],[a,b,-1,0],[b,a,1,1],[b,a,-1,1]] as const) {
        positions.push(p.x,p.y,p.z); next.push(q.x,q.y,q.z); sides.push(sign); distances.push(along);
      }
    }
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions,3));
    geometry.setAttribute('next', new THREE.Float32BufferAttribute(next,3)); geometry.setAttribute('side',new THREE.Float32BufferAttribute(sides,1)); geometry.setAttribute('along',new THREE.Float32BufferAttribute(distances,1));
    const travel=new THREE.BufferAttribute(new Float32Array(distances.length),1);travel.setUsage(THREE.DynamicDrawUsage);geometry.setAttribute('travel',travel);
    if(pattern||dash)item.stroke={attribute:travel,version:-1};
    const image=pattern?this.acquireImage(item,pattern.url):undefined,ready={value:0},phase={value:0};
    if(image)item.imageBindings.push({entry:image,ready});
    if(pattern?.speed)item.animations.push({uniform:phase,repeat:pattern.length??64,speed:pattern.speed,base:[0,0]});
    const material = this.material(item, `#include <common>\n#include <logdepthbuf_pars_vertex>\n${projection}
uniform vec2 viewport; uniform float width; attribute vec3 next; attribute float side, along, travel; varying vec2 vTravel; varying float vSide;
void main() { vec4 p=projectWorld(position), q=projectWorld(next);
float cp=p.z+p.w, cq=q.z+q.w;
if(cp<0.0 && cq<0.0){gl_Position=vec4(2.0,2.0,2.0,1.0);vTravel=vec2(0.0,1.0);vSide=0.0;return;}
if(cp<0.0)p=mix(p,q,cp/(cp-cq));else if(cq<0.0)q=mix(q,p,cq/(cq-cp));
vec2 delta=(q.xy/max(q.w,0.001)-p.xy/max(p.w,0.001))*viewport;
float len=max(length(delta),0.001); vec2 normal=vec2(-delta.y,delta.x)/len;
p.xy+=normal*side*width/viewport*p.w; gl_Position=p; vTravel=vec2(travel*p.w,p.w);vSide=side*(along>0.5?-1.0:1.0);
#include <logdepthbuf_vertex>\n}`, `${fragmentStart}\nvarying vec2 vTravel; varying float vSide; uniform vec2 dash; uniform sampler2D image; uniform int imageReady;uniform float phase,period,direction;
void main(){float distance=vTravel.x/max(vTravel.y,0.001); if(dash.y>0.0 && mod(distance,dash.x+dash.y)>dash.x) discard; gl_FragColor=vec4(color,opacity);
if(imageReady==1)gl_FragColor*=texture2D(image,vec2(direction*(distance-phase)/period,(vSide+1.0)*0.5));if(gl_FragColor.a<0.01)discard;${fragmentEnd} }`, {
      image:{value:image?.texture??null},imageReady:ready,phase,period:{value:pattern?.length??64},direction:{value:pattern?.sourceDirection==='left'?-1:1},
      width:{value:width}, color:{value:new THREE.Color(color)},opacity:{value:opacity},dash:{value:new THREE.Vector2(dash?.[0] ?? 1,dash?.[1] ?? 0)} },item.definition.type==='label'||item.definition.symbol?.occlusion!=='overlay');
    this.mesh(item, geometry, material);
  }
  private fill(item: Rendered, definition: Extract<EntityDefinition, { type: 'polygon' }>): void {
    const reference = definition.positions[0]![0];
    const rings = [definition.positions, ...(definition.holes ?? [])].map(ring => {
      const copy = [...ring]; if (copy.length > 3 && copy[0]![0] === copy[copy.length-1]![0] && copy[0]![1] === copy[copy.length-1]![1]) copy.pop();
      return copy.map(p => ({ p, xy: new THREE.Vector2(reference + wrapLongitude(p[0] - reference), p[1]) }));
    });
    const faces = THREE.ShapeUtils.triangulateShape(rings[0]!.map(v => v.xy), rings.slice(1).map(r => r.map(v => v.xy)));
    const points = rings.flat().map(v => v.p); const positions: number[] = [],uvs:number[]=[];
    const xs=rings.flat().map(v=>v.xy.x),ys=rings.flat().map(v=>v.xy.y),west=Math.min(...xs),south=Math.min(...ys),spanX=Math.max(1e-9,Math.max(...xs)-west),spanY=Math.max(1e-9,Math.max(...ys)-south);
    const emit = (a: EntityPosition, b: EntityPosition, c: EntityPosition, depth: number): void => {
      const edges = [[a,b,c],[b,c,a],[c,a,b]] as const;
      const length = (p: EntityPosition,q: EntityPosition) => Math.hypot(wrapLongitude(p[0]-q[0])*Math.cos(THREE.MathUtils.degToRad(p[1])),p[1]-q[1]);
      const e = [...edges].sort((l,r) => length(r[0],r[1])-length(l[0],l[1]))[0]!;
      if (depth < 8 && positions.length < 180000 && length(e[0],e[1]) > 0.02) {
        const mid: EntityPosition = [wrapLongitude(e[0][0]+wrapLongitude(e[1][0]-e[0][0])/2),(e[0][1]+e[1][1])/2,((e[0][2] ?? 30)+(e[1][2] ?? 30))/2];
        emit(e[0],mid,e[2],depth+1); emit(mid,e[1],e[2],depth+1);
      } else for (const p of [a,b,c]) { const world=this.world(p).sub(item.center); positions.push(world.x,world.y,world.z);uvs.push((reference+wrapLongitude(p[0]-reference)-west)/spanX,(p[1]-south)/spanY); }
    };
    for (const face of faces) emit(points[face[0]!]!,points[face[1]!]!,points[face[2]!]!,0);
    const geometry=new THREE.BufferGeometry(); geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
    geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));
    const pattern=definition.symbol?.texture,image=pattern?this.acquireImage(item,pattern.url):undefined,ready={value:0},offset={value:new THREE.Vector2(...(pattern?.offset??[0,0]))};
    if(image)item.imageBindings.push({entry:image,ready});
    if(pattern?.speed)item.animations.push({uniform:offset,repeat:1,speed:pattern.speed,base:pattern.offset??[0,0]});
    this.mesh(item,geometry,this.material(item,`#include <common>\n#include <logdepthbuf_pars_vertex>\n${projection}
varying vec2 vUv;void main(){gl_Position=projectWorld(position);vUv=uv; #include <logdepthbuf_vertex>\n}`.replace('; #include',';\n#include'), `${fragmentStart}\nvarying vec2 vUv;uniform sampler2D image;uniform int imageReady;uniform vec2 repeat,offset;uniform float rotation;
void main(){gl_FragColor=vec4(color,opacity);vec2 p=vUv-0.5;float c=cos(rotation),s=sin(rotation);p=vec2(c*p.x-s*p.y,s*p.x+c*p.y)+0.5;
if(imageReady==1)gl_FragColor*=texture2D(image,p*repeat-offset);if(gl_FragColor.a<0.01)discard;${fragmentEnd} }`,{
      image:{value:image?.texture??null},imageReady:ready,repeat:{value:new THREE.Vector2(...(pattern?.repeat??[1,1]))},offset,rotation:{value:THREE.MathUtils.degToRad(pattern?.rotation??0)},
      color:{value:new THREE.Color(definition.symbol?.color ?? (pattern?'#ffffff':'#32e6a1'))},opacity:{value:definition.symbol?.opacity ?? 0.35} },definition.symbol?.occlusion!=='overlay'));
  }
  private northAngle(item:Rendered,camera:THREE.PerspectiveCamera):number {
    const p=entityAnchor(item.definition),lon=THREE.MathUtils.degToRad(p[0]),lat=THREE.MathUtils.degToRad(p[1]);
    const north=new THREE.Vector3(-Math.sin(lat)*Math.sin(lon),Math.cos(lat),-Math.sin(lat)*Math.cos(lon));
    const a=this.project(item.center,camera),b=this.project(item.center.clone().addScaledVector(north,100),camera);
    return a&&b&&Math.hypot(b.x-a.x,b.y-a.y)>0.001?Math.atan2(b.x-a.x,a.y-b.y):0;
  }
  private updateStroke(item:Rendered,camera:THREE.PerspectiveCamera):void {
    const state=item.stroke!,values=state.attribute.array as Float32Array;let cursor=0;
    for(const path of item.paths){let distance=0;
      for(let i=1;i<path.length;i++){
        const a=this.project(path[i-1]!,camera),b=this.project(path[i]!,camera),end=distance+(a&&b?Math.hypot(b.x-a.x,b.y-a.y):0);
        for(const v of [distance,distance,end,distance,end,end])values[cursor++]=v;
        distance=end;
      }
    }state.attribute.needsUpdate=true;state.version=this.cameraVersion;
  }
  private acquireImage(item:Rendered,url:string):ImageEntry {
    let entry=this.imageCache.get(url);
    if(!entry){
      const texture=new THREE.Texture();texture.colorSpace=THREE.SRGBColorSpace;texture.wrapS=texture.wrapT=THREE.RepeatWrapping;
      texture.generateMipmaps=false;texture.minFilter=texture.magFilter=THREE.LinearFilter;
      entry={url,texture,references:0,bytes:0,controller:new AbortController(),state:[...this.imageCache.values()].filter(image=>image.state!=='error').length>=256?'error':'loading'};
      this.imageCache.set(url,entry);if(entry.state==='loading'){this.imageQueue.add(entry);this.pumpImages();}
    }entry.references++;item.images.push(entry);return entry;
  }
  private pumpImages():void {
    if(this.disposed)return;
    while(this.activeImages<4&&this.imageQueue.size){
      const entry=this.imageQueue.values().next().value!;this.imageQueue.delete(entry);this.activeImages++;
      void this.loadImage(entry).finally(()=>{this.activeImages--;this.pumpImages();});
    }
  }
  private async loadImage(entry:ImageEntry):Promise<void> {
    let bitmap:ImageBitmap|undefined;
    const timeout=setTimeout(()=>entry.controller.abort(),15000);
    try{
      const response=await fetch(entry.url,{signal:entry.controller.signal});
      if(!response.ok||Number(response.headers.get('content-length')??0)>8*1024*1024)throw new Error('Image unavailable.');
      const blob=await response.blob();if(blob.size>8*1024*1024)throw new Error('Image too large.');
      const header=new Uint8Array(await blob.slice(0,24).arrayBuffer());
      if(header.length===24&&header[0]===137&&header[1]===80&&header[2]===78&&header[3]===71){const view=new DataView(header.buffer);if(view.getUint32(16)>2048||view.getUint32(20)>2048)throw new Error('PNG dimensions exceed 2048.');}
      // ImageBitmap uploads ignore Texture.flipY; decode with an explicit flip once.
      bitmap=await createImageBitmap(blob,{imageOrientation:'flipY',premultiplyAlpha:'none'});
      if(bitmap.width>2048||bitmap.height>2048)throw new Error('Image dimensions exceed 2048.');
      if(this.disposed||entry.controller.signal.aborted||entry.references===0||this.imageCache.get(entry.url)!==entry){bitmap.close();return;}
      const bytes=bitmap.width*bitmap.height*4;
      if(this.textureBytes+bytes>64*1024*1024)throw new Error('Symbol texture budget exceeded.');
      entry.bytes=bytes;this.textureBytes+=bytes;
      entry.texture.image=bitmap;entry.texture.needsUpdate=true;entry.state='ready';
    }catch{bitmap?.close();if(entry.references>0&&this.imageCache.get(entry.url)===entry)entry.state='error';}
    finally{clearTimeout(timeout);}
  }
  private label(item: Rendered, symbol: LabelSymbol): void {
    const canvas = document.createElement('canvas'), context=canvas.getContext('2d');
    if (!context) throw new Error('Label rendering requires Canvas 2D.');
    const size=symbol.fontSize ?? 16, pad=(symbol.padding ?? 4)+(symbol.haloWidth ?? 2), scale=2;
    context.font=`${size}px sans-serif`;
    const lines=symbol.text.split('\n').slice(0,8), width=Math.min(1024,Math.ceil(Math.max(...lines.map(text=>context.measureText(text).width))+pad*2)), height=Math.ceil(lines.length*size*1.3+pad*2);
    const bytes=width*height*scale*scale*4;
    if(this.textureBytes+bytes>64*1024*1024){item.limited=true;return;}
    this.textureBytes+=bytes;item.labelBytes=bytes;
    canvas.width=width*scale; canvas.height=height*scale; context.scale(scale,scale); context.font=`${size}px sans-serif`; context.textBaseline='middle'; context.textAlign='center';
    if(symbol.backgroundColor){context.fillStyle=symbol.backgroundColor;context.fillRect(0,0,width,height);}
    context.fillStyle=symbol.color ?? '#ffffff'; context.strokeStyle=symbol.haloColor ?? '#122733'; context.lineWidth=(symbol.haloWidth ?? 2)*2; context.lineJoin='round';
    lines.forEach((text,i)=>{const y=pad+(i+0.5)*size*1.3;if(context.lineWidth>0) context.strokeText(text,width/2,y);context.fillText(text,width/2,y);});
    const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace; texture.generateMipmaps=false;texture.minFilter=THREE.LinearFilter; item.textures.push(texture);
    const offset=symbol.offset ?? [0,-22];
    const material=this.material(item,billboardVertex,`#include <logdepthbuf_pars_fragment>\nuniform sampler2D image; uniform float opacity; varying vec2 vUv;
void main(){gl_FragColor=texture2D(image,vUv);gl_FragColor.a*=opacity;if(gl_FragColor.a<0.01)discard;${fragmentEnd}}`,{
      image:{value:texture},rotation:{value:0},opacity:{value:symbol.opacity ?? 1},dimensions:{value:new THREE.Vector2(width,height)},offset:{value:new THREE.Vector2(...offset)} },
      (symbol.occlusion??(item.definition.type==='point'?item.definition.symbol?.occlusion:undefined))!=='overlay');
    item.label={mesh:this.mesh(item,quad(),material,true),width,height,offset};
  }
}
const billboardVertex=`#include <common>\n#include <logdepthbuf_pars_vertex>\n${projection}
uniform vec2 viewport, dimensions, offset;uniform float rotation; varying vec2 vUv;
void main(){vec4 p=projectWorld(vec3(0.0));vec2 vertex=position.xy*dimensions;float c=cos(rotation),s=sin(rotation);vec2 pixel=vec2(c*vertex.x+s*vertex.y,-s*vertex.x+c*vertex.y)+vec2(offset.x,-offset.y);p.xy+=pixel*2.0/viewport*p.w;gl_Position=p;vUv=uv;
#include <logdepthbuf_vertex>\n}`;
function quad(): THREE.BufferGeometry { const g=new THREE.PlaneGeometry(1,1);return g; }
function split(value:THREE.Vector3,high:THREE.Vector3,low:THREE.Vector3):void {high.set(Math.fround(value.x),Math.fround(value.y),Math.fround(value.z));low.copy(value).sub(high);}
function densify(input:readonly EntityPosition[],close:boolean):EntityPosition[]{
  const points=[...input];if(close)points.push(input[0]!);const result:EntityPosition[]=[points[0]!];
  const maxSteps=Math.max(1,Math.floor(20000/Math.max(1,points.length-1)));
  for(let i=1;i<points.length;i++){
    const a=points[i-1]!,b=points[i]!,dx=wrapLongitude(b[0]-a[0]); const count=Math.min(64,maxSteps,Math.max(1,Math.ceil(Math.hypot(dx,b[1]-a[1])/0.02)));
    for(let j=1;j<=count;j++){const t=j/count;result.push([wrapLongitude(a[0]+dx*t),a[1]+(b[1]-a[1])*t,(a[2] ?? 30)+((b[2] ?? 30)-(a[2] ?? 30))*t]);}
  }return result;
}
function segmentDistance(p:ScreenPosition,a:ScreenPosition,b:ScreenPosition):number {const dx=b.x-a.x,dy=b.y-a.y;const t=THREE.MathUtils.clamp(((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy||1),0,1);return Math.hypot(p.x-a.x-dx*t,p.y-a.y-dy*t);}
function inRing(p:ScreenPosition,ring:readonly ScreenPosition[]):boolean {let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i]!,b=ring[j]!;if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)inside=!inside;}return inside;}
