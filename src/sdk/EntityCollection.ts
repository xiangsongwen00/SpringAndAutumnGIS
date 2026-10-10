import * as THREE from 'three';
import type { EntityDefinition, EntitySnapshot, EntityPatch, EntityMove, EntityPosition, EntityQuery, EntityChange } from './EntityTypes';

export class EntityError extends Error {
  constructor(readonly code: 'INVALID_ENTITY' | 'DUPLICATE_ID' | 'NOT_FOUND' | 'DESTROYED', message: string) {
    super(message); this.name = 'EntityError';
  }
}

/** Mutable collection with immutable detached snapshots; no source or GPU objects leak through the API. */
export class EntityCollection {
  private readonly records = new Map<string, EntitySnapshot>();
  private readonly listeners = new Set<(change: EntityChange) => void>();
  private shown = true;
  private destroyed = false;
  get isDestroyed(): boolean { return this.destroyed; }
  get length(): number { this.assertAlive(); return this.records.size; }
  get visible(): boolean { this.assertAlive(); return this.shown; }
  setVisible(visible: boolean): void { this.assertAlive(); bool(visible); this.shown = visible; this.emit({ type: 'visibility' }); }
  add(definition: EntityDefinition): EntitySnapshot {
    this.assertAlive(); validateEntity(definition);
    if (this.records.has(definition.id)) throw new EntityError('DUPLICATE_ID', 'Entity id already exists.');
    if (this.records.size >= 5000) invalid('This version supports at most 5000 entities per collection.');
    const value = snapshot({ ...definition, visible: definition.visible ?? true });
    this.records.set(value.id, value); this.emit({ type: 'add', id: value.id }); return value;
  }
  getById(id: string): EntitySnapshot | undefined { this.assertAlive(); return this.records.get(id); }
  has(id: string): boolean { this.assertAlive(); return this.records.has(id); }
  get values(): readonly EntitySnapshot[] { this.assertAlive(); return Object.freeze([...this.records.values()]); }
  query(query: EntityQuery = {}): readonly EntitySnapshot[] {
    this.assertAlive();
    if (!query || typeof query !== 'object' || Array.isArray(query)) invalid('Query must be an object.');
    fields(query,['type','visible','name','bounds','properties']);
    if(query.type!==undefined && !['point','polyline','polygon','label'].includes(query.type))invalid('Invalid query type.');
    if(query.visible!==undefined)bool(query.visible);
    if(query.name!==undefined && typeof query.name!=='string')invalid('Invalid query name.');
    if(query.properties!==undefined && (!query.properties || Object.getPrototypeOf(query.properties)!==Object.prototype))invalid('Query properties must be an object.');
    if (query.bounds) {
      const b = query.bounds;
      if (![b.west, b.east, b.south, b.north].every(Number.isFinite) || b.south > b.north ||
          Math.abs(b.west) > 180 || Math.abs(b.east) > 180 || Math.abs(b.south) > 90 || Math.abs(b.north) > 90) invalid('Invalid query bounds.');
    }
    return Object.freeze([...this.records.values()].filter(value => {
      if (query.type && value.type !== query.type || query.visible !== undefined && value.visible !== query.visible ||
          query.name !== undefined && value.name !== query.name) return false;
      if (query.properties && !Object.entries(query.properties).every(([key, item]) => Object.is(value.properties?.[key], item))) return false;
      const p = entityAnchor(value), b = query.bounds;
      return !b || p[1] >= b.south && p[1] <= b.north && (b.west <= b.east ? p[0] >= b.west && p[0] <= b.east : p[0] >= b.west || p[0] <= b.east);
    }));
  }
  update(id: string, patch: EntityPatch): EntitySnapshot {
    this.assertAlive(); const current = this.require(id);
    const allowed = ['name', 'visible', 'order', 'properties', 'position', 'positions', 'holes', 'symbol', 'label'];
    if (!patch || typeof patch !== 'object' || Object.keys(patch).some(key => !allowed.includes(key))) invalid('Unsupported update field; type/id cannot change.');
    const next = { ...current, ...patch } as EntityDefinition;
    if (patch.symbol) {
      if (current.type === 'label') invalid('Label entities use label, not symbol.');
      (next as { symbol?: object }).symbol = { ...(current as { symbol?: object }).symbol, ...patch.symbol };
    }
    if (patch.label === null) delete (next as { label?: object }).label;
    else if (patch.label) next.label = { ...current.label, ...patch.label } as NonNullable<EntityDefinition['label']>;
    validateEntity(next); const value = snapshot(next);
    this.records.set(id, value); this.emit({ type: 'update', id, fields: Object.freeze(Object.keys(patch)) }); return value;
  }
  setVisibleById(id: string, visible: boolean): EntitySnapshot { return this.update(id, { visible }); }
  /** Translation in geographic degrees/metres, preserving shape. It is not an ECEF rigid transform. */
  move(id: string, delta: EntityMove): EntitySnapshot {
    this.assertAlive();
    if (!delta || ![delta.longitude ?? 0, delta.latitude ?? 0, delta.height ?? 0].every(Number.isFinite)) invalid('Invalid movement delta.');
    const translate = (p: EntityPosition): EntityPosition => [wrapLongitude(p[0] + (delta.longitude ?? 0)), p[1] + (delta.latitude ?? 0), (p[2] ?? 30) + (delta.height ?? 0)];
    const current = this.require(id);
    return 'position' in current ? this.update(id, { position: translate(current.position) }) : this.update(id, {
      positions: current.positions.map(translate), ...(current.type === 'polygon' ? { holes: current.holes?.map(ring => ring.map(translate)) } : {}) });
  }
  remove(id: string): boolean { this.assertAlive(); const removed = this.records.delete(id); if (removed) this.emit({ type: 'remove', id }); return removed; }
  clear(): void { this.assertAlive(); this.records.clear(); this.emit({ type: 'clear' }); }
  /** Listener failures cannot interrupt other observers or leave the collection half-mutated. */
  onChange(listener: (change: EntityChange) => void): () => void {
    this.assertAlive(); this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  /** Owned by Viewer; after disposal all operational access fails explicitly. */
  dispose(): void { if (this.destroyed) return; this.destroyed = true; this.records.clear(); this.emit({ type: 'clear' }); this.listeners.clear(); }
  private require(id: string): EntityDefinition { const value = this.records.get(id); if (!value) throw new EntityError('NOT_FOUND', 'Entity was not found.'); return value; }
  private assertAlive(): void { if (this.destroyed) throw new EntityError('DESTROYED', 'Entity collection has been destroyed.'); }
  private emit(change: EntityChange): void {
    for (const listener of [...this.listeners]) { try { listener(Object.freeze(change)); } catch { console.warn('[Entities] A change listener failed.'); } }
  }
}

export function entityAnchor(value: EntityDefinition): EntityPosition {
  // Deterministic geometry anchor; callers can use a separate label entity for another anchor.
  return 'position' in value ? value.position : value.positions[0]!;
}
export function wrapLongitude(value: number): number { return ((value + 180) % 360 + 360) % 360 - 180; }
function invalid(message: string): never { throw new EntityError('INVALID_ENTITY', message); }
function bool(value: unknown): void { if (typeof value !== 'boolean') invalid('Visibility/fill must be boolean.'); }
function range(value: unknown, min: number, max: number): void { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) invalid('Symbol number is outside its supported range.'); }
function position(value: unknown): asserts value is EntityPosition {
  if (!Array.isArray(value) || value.length < 2 || value.length > 3) invalid('Position must be [longitude, latitude, height?].');
  range(value[0], -180, 180); range(value[1], -90, 90); if (value[2] !== undefined) range(value[2], -10000, 10000000);
}
function color(value: unknown): void { if (typeof value !== 'string' || !(/^#[\da-f]{3}$/i.test(value) || /^#[\da-f]{6}$/i.test(value) || Object.prototype.hasOwnProperty.call(THREE.Color.NAMES,value))) invalid('Use a CSS named color or 3/6-digit hex color; alpha uses opacity.'); }
function fields(value: object, allowed: string[]): void { if (Object.keys(value).some(key => !allowed.includes(key))) invalid('Unsupported symbol or entity field.'); }
export function validateEntity(value: EntityDefinition): void {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id.trim() || value.id.length > 256) invalid('A nonempty stable id is required.');
  if (!['point', 'polyline', 'polygon', 'label'].includes(value.type)) invalid('Unsupported entity type.');
  fields(value, ['id', 'type', 'name', 'visible', 'order', 'properties', 'label', ...(value.type === 'point' || value.type === 'label' ? ['position'] : ['positions', ...(value.type === 'polygon' ? ['holes'] : [])]), ...(value.type !== 'label' ? ['symbol'] : [])]);
  if (value.name !== undefined && typeof value.name !== 'string') invalid('Name must be a string.');
  if (value.visible !== undefined) bool(value.visible);
  if (value.order !== undefined) range(value.order, 0, 9000);
  if (value.type === 'point' || value.type === 'label') position(value.position);
  else {
    if (!Array.isArray(value.positions) || value.positions.length < (value.type === 'polygon' ? 3 : 2)) invalid('Insufficient geometry coordinates.');
    let count = value.positions.length; value.positions.forEach(position);
    if (value.type === 'polygon') {
      if (value.holes !== undefined && !Array.isArray(value.holes)) invalid('Holes must be an array of rings.');
      for (const ring of value.holes ?? []) { if (!Array.isArray(ring) || ring.length < 3) invalid('A hole needs three vertices.'); count += ring.length; ring.forEach(position); }
      // Version B: local, simple polygons. Do not silently create a globe-spanning bad triangulation.
      for (const p of [...value.positions, ...(value.holes ?? []).flat()]) if (Math.abs(wrapLongitude(p[0] - value.positions[0]![0])) > 10 || Math.abs(p[1] - value.positions[0]![1]) > 10) invalid('Polygon span must be within 10 degrees of its first vertex.');
    }
    if (count > 10000) invalid('A geometry supports at most 10000 input vertices.');
    if (value.type === 'polygon') validatePolygon(value);
  }
  if (value.type !== 'label' && value.symbol) {
    const s = value.symbol;
    if (typeof s !== 'object' || Array.isArray(s)) invalid('Symbol must be an object.');
    fields(s, value.type === 'point' ? ['color', 'size', 'shape', 'outlineColor', 'outlineWidth', 'opacity','icon','heading','alignment','occlusion'] : value.type === 'polyline' ? ['color', 'width', 'opacity', 'dash','texture','occlusion'] : ['color', 'opacity', 'fill', 'outlineColor', 'outlineWidth','texture','occlusion']);
    for (const [key, item] of Object.entries(s)) {
      if (item === undefined) continue;
      if(key==='occlusion'){if(item!=='depth'&&item!=='overlay')invalid('Occlusion policy must be depth or overlay.');}
      else if(key==='icon'||key==='texture')validateImageSymbol(item,value.type);
      else if(key==='heading')range(item,-360000,360000);
      else if(key==='alignment'){if(item!=='map'&&item!=='screen')invalid('Icon alignment must be map or screen.');}
      else if (key.includes('Color') || key === 'color') color(item);
      else if (key === 'opacity') range(item, 0, 1);
      else if (key === 'fill') bool(item);
      else if (key === 'shape') { if (!['circle', 'square', 'diamond'].includes(item as string)) invalid('Invalid point shape.'); }
      else if (key === 'dash') { if (!Array.isArray(item) || item.length !== 2) invalid('Dash must be [on, off] pixels.'); item.forEach(v => range(v, 1, 256)); }
      else range(item, key === 'size' ? 1 : 0, key === 'size' ? 256 : 64);
    }
  }
  if (value.type !== 'label' && 'symbol' in value && value.symbol === null) invalid('Symbol cannot be null.');
  if ('label' in value && value.label === null) invalid('Label cannot be null on add; remove it with update(label:null).');
  if (value.type === 'label' && !value.label) invalid('Label entity requires label.text.');
  if (value.label) {
    const s = value.label;
    if (typeof s !== 'object' || Array.isArray(s)) invalid('Label must be an object.');
    fields(s, ['text', 'fontSize', 'color', 'haloColor', 'haloWidth', 'offset', 'backgroundColor', 'padding', 'opacity','occlusion']);
    if (typeof s.text !== 'string' || s.text.length > 512) invalid('Label text must be at most 512 characters.');
    for (const [key, item] of Object.entries(s)) {
      if (item === undefined || key === 'text') continue;
      if(key==='occlusion'){if(item!=='depth'&&item!=='overlay')invalid('Occlusion policy must be depth or overlay.');}
      else if (key.includes('Color') || key === 'color') color(item);
      else if (key === 'offset') { if (!Array.isArray(item) || item.length !== 2) invalid('Label offset needs two pixels values.'); item.forEach(v => range(v, -1024, 1024)); }
      else range(item, key === 'fontSize' ? 6 : 0, key === 'opacity' ? 1 : key === 'fontSize' ? 96 : 32);
    }
  }
  if (value.properties !== undefined) {
    if (!value.properties || Object.getPrototypeOf(value.properties) !== Object.prototype) invalid('Properties must be a plain JSON object.');
    const seen = new Set<object>();
    const visit = (item: unknown, depth: number): void => {
      if (depth > 16) invalid('Properties nesting is too deep.');
      if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return;
      if (typeof item !== 'object' || seen.has(item) || !Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype) invalid('Properties must contain finite, noncyclic JSON data.');
      seen.add(item); Object.values(item).forEach(child => visit(child, depth + 1)); seen.delete(item);
    }; visit(value.properties, 0);
  }
}
function validateImageSymbol(value: unknown, type: EntityDefinition['type']): void {
  if(value===null)return;
  if(!value||typeof value!=='object'||Array.isArray(value))invalid('Icon/texture must be an object or null.');
  const s=value as Record<string,unknown>;
  fields(s,type==='point'?['url','width','height','sourceHeading']:type==='polyline'?['url','length','speed','sourceDirection']:['url','repeat','offset','rotation','speed']);
  if(typeof s.url!=='string'||!s.url.trim()||s.url.length>200000)invalid('An image URL is required.');
  try {const url=new URL(s.url,'https://sdk.invalid/');if(!['http:','https:','blob:','data:'].includes(url.protocol)||url.protocol==='data:'&&!/^data:image\/(png|jpeg|webp);base64,/i.test(s.url))invalid('Unsupported image URL protocol.');}
  catch(error){if(error instanceof EntityError)throw error;invalid('Invalid image URL.');}
  for(const [key,item] of Object.entries(s)){
    if(key==='url'||item===undefined)continue;
    if(key==='sourceDirection'){if(item!=='left'&&item!=='right')invalid('Source direction must be left or right.');}
    else if(['repeat','offset'].includes(key)||key==='speed'&&type==='polygon'){
      if(!Array.isArray(item)||item.length!==2)invalid('Texture vector must have two components.');
      item.forEach(v=>range(v,key==='repeat'?0.01:-1000,key==='repeat'?256:1000));
    }else range(item,['width','height','length'].includes(key)?1:-360000,['width','height'].includes(key)?256:key==='length'?2048:360000);
  }
  if(type==='polyline'&&s.speed!==undefined)range(s.speed,-4096,4096);
}
/** Bounded local-ring topology validation, including holes and nonadjacent edge touches. */
function validatePolygon(value: Extract<EntityDefinition, { type: 'polygon' }>): void {
  const reference = value.positions[0]![0];
  const rings = [value.positions, ...(value.holes ?? [])].map(input => {
    const ring = input.map(p => [reference + wrapLongitude(p[0] - reference), p[1]] as const);
    if (ring.length > 3 && ring[0]![0] === ring[ring.length-1]![0] && ring[0]![1] === ring[ring.length-1]![1]) ring.pop();
    let area = 0;
    for (let i=0; i<ring.length; i++) { const a=ring[i]!, b=ring[(i+1)%ring.length]!; if (a[0]===b[0] && a[1]===b[1]) invalid('Duplicate adjacent polygon vertices.'); area+=(a[0]-reference)*b[1]-(b[0]-reference)*a[1]; }
    if (Math.abs(area)<1e-12) invalid('Polygon rings must have nonzero area.'); return ring;
  });
  type Point = readonly [number, number];
  type Edge = { a: Point; b: Point; ring: number; index: number };
  const points=rings.flat(), xs=points.map(p=>p[0]), ys=points.map(p=>p[1]);
  const west=Math.min(...xs), south=Math.min(...ys), dx=Math.max(1e-9,Math.max(...xs)-west), dy=Math.max(1e-9,Math.max(...ys)-south);
  if(dx>1 || dy>1)invalid('Version B polygon extent must be at most one degree in each axis. Use tiled data for regional polygons.');
  const gridSize=Math.min(64,Math.max(1,Math.ceil(Math.sqrt(points.length)))), grid=new Map<string,Edge[]>();
  const orientation=(a:Point,b:Point,c:Point)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  const on=(a:Point,b:Point,p:Point)=>Math.abs(orientation(a,b,p))<1e-12 && p[0]>=Math.min(a[0],b[0])-1e-12 && p[0]<=Math.max(a[0],b[0])+1e-12 && p[1]>=Math.min(a[1],b[1])-1e-12 && p[1]<=Math.max(a[1],b[1])+1e-12;
  const intersects=(a:Edge,b:Edge)=>orientation(a.a,a.b,b.a)*orientation(a.a,a.b,b.b)<0 && orientation(b.a,b.b,a.a)*orientation(b.a,b.b,a.b)<0 || on(a.a,a.b,b.a)||on(a.a,a.b,b.b)||on(b.a,b.b,a.a)||on(b.a,b.b,a.b);
  let comparisons=0;
  rings.forEach((ring,r)=>ring.forEach((a,index)=>{
    const b=ring[(index+1)%ring.length]!, edge={a,b,ring:r,index}, checked=new Set<Edge>();
    for(let x=Math.floor((Math.min(a[0],b[0])-west)/dx*gridSize); x<=Math.floor((Math.max(a[0],b[0])-west)/dx*gridSize); x++)
      for(let y=Math.floor((Math.min(a[1],b[1])-south)/dy*gridSize);y<=Math.floor((Math.max(a[1],b[1])-south)/dy*gridSize);y++){
        const key=`${x},${y}`, bucket=grid.get(key) ?? [];
        for(const other of bucket){
          if(checked.has(other))continue;checked.add(other);
          if(other.ring===r && (Math.abs(index-other.index)===1 || Math.abs(index-other.index)===ring.length-1))continue;
          if(++comparisons>1000000)invalid('Polygon topology exceeds the bounded validation budget.');
          if(intersects(edge,other))invalid('Self-intersecting, overlapping or touching rings are not supported.');
        }bucket.push(edge);grid.set(key,bucket);
      }
  }));
  const contains=(p:Point,ring:readonly Point[])=>{let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i]!,b=ring[j]!;if((a[1]>p[1])!==(b[1]>p[1]) && p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;}return inside;};
  for(let i=1;i<rings.length;i++){
    if(!contains(rings[i]![0]!,rings[0]!))invalid('Holes must be inside the outer ring.');
    for(let j=1;j<i;j++)if(contains(rings[i]![0]!,rings[j]!)||contains(rings[j]![0]!,rings[i]!))invalid('Nested or overlapping holes are not supported.');
  }
}
function snapshot(value: EntityDefinition): EntitySnapshot {
  const result = structuredClone(value);
  const freeze = (item: unknown): void => { if (item && typeof item === 'object') { Object.values(item).forEach(freeze); Object.freeze(item); } };
  freeze(result); return result;
}
