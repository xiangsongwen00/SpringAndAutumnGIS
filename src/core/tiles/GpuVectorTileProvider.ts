import * as THREE from 'three';
import { derefLayers, type LayerSpecification } from '@maplibre/maplibre-gl-style-spec';
import { UrlTemplateRasterProvider } from './RasterTileProvider';
import type { TileId } from '../tiling/GeographicTilingScheme';
import { MapStyleLoader, type MapStyleLoaderOptions } from '../../vector/style/MapStyleLoader';
import type { VectorStyleIssue } from '../../vector/style/VectorStyleRuntime';
import { VectorDecodeService } from '../../vector/worker/VectorDecodeService';
import { MvtTileSource } from '../../vector/source/MvtTileSource';
import { VectorSurfaceService } from '../../vector/worker/VectorSurfaceService';
import { filterToSubtile, type SurfacePlan, type SurfaceChunk } from '../../vector/worker/VectorSurfaceBuild';
import type { VectorSource, StyleLayer } from '../../vector/style/VectorStyleTypes';
import { analyzeVectorSurfaceStyle } from '../../vector/style/VectorSurfaceCapabilities';
import type { MapStyleCapabilityReport } from '../../vector/style/MapStyleLoader';
import { RequestScheduler } from './RequestScheduler';
import type { FrameWorkBudget } from './FrameWorkBudget';
import type { DecodedVectorTile } from '../../vector/style/VectorStyleTypes';

export type GpuVectorTileProviderOptions = MapStyleLoaderOptions & {
  id: string; renderer: THREE.WebGLRenderer; levelOffset?: number;
  minLevel?: number; maxLevel?: number; tileSize?: number;
  /** maxLevel is the network/PBF cap; display zoom remains independent. */
  displayMaxLevel?: number;
  maxDrawsPerFrame?: number;
  drawBudgetMs?: number;
  /** Catalog overrides; scheme changes request rows only, never MVT geometry. */
  source?: Partial<VectorSource>;
  workBudget?: FrameWorkBudget;
  maxUploadBytesPerFrame?: number;
  maxDrawChunksPerFrame?: number;
  /** Backpressure across worker preparation and unpublished RenderTargets. */
  maxPreparedTiles?: number;
};

type SurfaceDrawJob = { plan: SurfacePlan; offset: THREE.Vector2; scale: number; cursor: number;
  target: THREE.WebGLRenderTarget | null; resolve: (texture: THREE.Texture) => void;
  reject: (error: unknown) => void; signal?: AbortSignal; abort: () => void };

/** GPU cartographic surface pass; textures drape on the shared terrain mesh.
 * No Canvas rasterizer. Symbols belong to a later independent placement pass.
 */
export class GpuVectorTileProvider extends UrlTemplateRasterProvider {
  private readonly loader: MapStyleLoader;
  private readonly decoder = new VectorDecodeService();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly loaderFetcher?: typeof fetch;
  private readonly tileSize: number;
  private readonly sourceOverride?: Partial<VectorSource>;
  private _dataMaxLevel: number;
  private readonly configuredDataMaxLevel?: number;
  private readonly decodedTiles = new RequestScheduler<DecodedVectorTile>({ maxCacheBytes: 32 * 1024 * 1024 });
  private readonly maxDrawsPerFrame: number;
  private readonly drawBudgetMs: number;
  private readonly workBudget?: FrameWorkBudget;
  private drawFrame: number | null = null;
  private readonly drawQueue: SurfaceDrawJob[] = [];
  private readonly surfaceBuilder = new VectorSurfaceService();
  private readonly maxUploadBytesPerFrame: number;
  private readonly maxDrawChunksPerFrame: number;
  private building = 0;
  private readonly maxPreparedTiles: number;
  private occupiedSlots = 0;
  private readonly slotWaiters: Array<{ resolve: () => void; reject: (reason: unknown) => void;
    signal?: AbortSignal; abort: () => void }> = [];
  private lastBuildMs = 0;
  private lastUploadBytes = 0;
  private lastDrawMs = 0;
  private maxDrawMs = 0;
  private readonly recentDraws: Array<{ at: number; ms: number; finished: boolean }> = [];
  private issues: VectorStyleIssue[] = [];
  private initialized = false;
  private source: MvtTileSource | null = null;
  private sourceId = '';
  private readonly camera = new THREE.Camera();
  private readonly surfaceMaterials = new Map<string, THREE.ShaderMaterial>();
  private disposed = false;
  private contextWasLost = false;
  private unsupportedLayers = new Set<string>();
  capabilityReport: MapStyleCapabilityReport | null = null;
  readonly limitations = [
    'symbol/glyph/sprite 尚未进入独立注记通道',
    'pattern、gradient、fill-extrusion 尚未实现',
    'line 暂用 butt cap，尚无完整 miter/round join 与跨瓦片 dash 相位'
  ];

  constructor(options: GpuVectorTileProviderOptions) {
    super({ id: options.id, urlTemplate: 'gpu://vector/{z}/{x}/{y}',
      minLevel: options.minLevel, maxLevel: options.displayMaxLevel ?? 27,
      viewLevelOffset: options.levelOffset, tileSize: options.tileSize ?? 256 });
    this.loader = new MapStyleLoader(options);
    this.loaderFetcher = options.fetcher;
    this.renderer = options.renderer;
    // Mesh density is selected around 128 CSS pixels per tile. A 256px target
    // keeps the 350-leaf working set (~117MiB incl. mipmaps) inside the default
    // cache. 512px targets need ~467MiB and can stall ancestor replacement.
    this.tileSize = options.tileSize ?? 256;
    this.sourceOverride = options.source;
    this.maxDrawsPerFrame = Math.max(1, Math.floor(options.maxDrawsPerFrame ?? 1));
    this.drawBudgetMs = Math.max(1, options.drawBudgetMs ?? 4);
    this.workBudget = options.workBudget;
    this.maxUploadBytesPerFrame = Math.max(1024, options.maxUploadBytesPerFrame ?? 512 * 1024);
    this.maxDrawChunksPerFrame = Math.max(1, Math.round(options.maxDrawChunksPerFrame ?? 8));
    this.maxPreparedTiles = Math.max(1, Math.round(options.maxPreparedTiles ?? 3));
    this.configuredDataMaxLevel = options.maxLevel;
    this._dataMaxLevel = Math.max(this.minLevel, Math.round(options.maxLevel ?? options.source?.maxzoom ?? 22));
  }

  async initialize(): Promise<void> {
    const style = await this.loader.load();
    const selected = this.loader.selectVectorSource(style);
    this.sourceId = selected.id;
    this.capabilityReport = analyzeVectorSurfaceStyle(style);
    this.unsupportedLayers = new Set(this.capabilityReport.issues
      .filter((issue) => issue.severity === 'unsupported').map((issue) => issue.layerId));
    this.source = new MvtTileSource({ id: selected.id, source: { ...selected.source, ...this.sourceOverride }, fetcher: this.loaderFetcher });
    await this.source.initialize();
    this._dataMaxLevel = Math.max(this.minLevel, Math.round(this.configuredDataMaxLevel ??
      this.sourceOverride?.maxzoom ?? selected.source.maxzoom ?? 22));
    this._dataMaxLevel = Math.min(this._dataMaxLevel, this.source.maxLevel);
    this.issues = await this.surfaceBuilder.initialize({ ...style,
      // Resolve legacy ref inheritance before removing unsupported parents.
      // A supported child must retain its inherited source/filter/type.
      layers: (derefLayers(style.layers as LayerSpecification[]) as StyleLayer[])
        .filter(layer => !this.unsupportedLayers.has(layer.id)) });
    if (this.issues.length) throw new Error(`样式编译失败：${JSON.stringify(this.issues.slice(0, 3))}`);
    this.initialized = true;
    await this.warmPrograms();
    console.info(`[GPU vector ${this.id}] 地表初版能力边界`, this.limitations);
    console.info(`[GPU vector ${this.id}] 样式绘制能力`, this.capabilityReport);
  }

  get styleIssues() { return this.issues; }
  get dataMaxLevel() { return this._dataMaxLevel; }
  get decodedCacheStats() { return this.decodedTiles.stats; }
  get drawStats() {
    const cutoff = performance.now() - 1000;
    while (this.recentDraws.length && this.recentDraws[0]!.at < cutoff) this.recentDraws.shift();
    return { queued: this.drawQueue.length + this.building + this.slotWaiters.length, lastMs: this.lastDrawMs, maxMs: this.maxDrawMs,
      worker: this.surfaceBuilder.stats.worker, building: this.building, buildMs: this.lastBuildMs, uploadBytes: this.lastUploadBytes,
      workerQueueMs: this.surfaceBuilder.stats.queueMs, workerRoundTripMs: this.surfaceBuilder.stats.roundTripMs,
      workerPostMs: this.surfaceBuilder.stats.postMs,
      recentCount: this.recentDraws.filter(draw => draw.finished).length,
      recentSteps: this.recentDraws.length, recentMs: this.recentDraws.reduce((sum, draw) => sum + draw.ms, 0) };
  }

  async loadTexture(id: TileId, signal?: AbortSignal): Promise<THREE.Texture> {
    const { sourceTile, offset, scale, decoded } = await this.loadSourceTile(id, signal);
    await this.acquireSlot(signal);
    try {
      this.building++;
      let plan: SurfacePlan;
      try {
        plan = await this.surfaceBuilder.build({ sourceId: this.sourceId, sourceTile, zoom: id.level,
          offset, scale, decoded, tileSize: this.tileSize }, `${sourceTile.level}/${sourceTile.x}/${sourceTile.y}`, signal);
        this.lastBuildMs = plan.buildMs;
      } finally { this.building--; }
      signal?.throwIfAborted();
      if (this.disposed) throw new Error('GPU vector provider disposed');
      return await this.enqueueDraw(plan, offset, scale, signal);
    } finally { this.releaseSlot(); }
  }

  /** Shared PBF/Worker cache for the independent symbol pass; local XYZ UVs. */
  async loadVectorTile(id: TileId, signal?: AbortSignal): Promise<DecodedVectorTile> {
    const { offset, scale, decoded } = await this.loadSourceTile(id, signal);
    if (scale === 1) return decoded;
    const result = new Map<string, readonly import('../../vector/style/VectorStyleTypes').DecodedFeature[]>();
    for (const [name, features] of filterToSubtile(decoded, offset, scale, this.tileSize)) {
      result.set(name, features.map((feature) => ({ ...feature, geometry: feature.geometry.map((ring) =>
        ring.map((point) => ({ x: (point.x - offset.x * feature.extent) * scale,
          y: (point.y - offset.y * feature.extent) * scale } as typeof point))) })));
    }
    return result;
  }

  private async loadSourceTile(id: TileId, signal?: AbortSignal) {
    if (!this.source || !this.initialized) throw new Error('GPU vector provider is not initialized');
    signal?.throwIfAborted();
    const sourceLevel = Math.min(id.level, this.dataMaxLevel);
    const scale = 2 ** (id.level - sourceLevel);
    const sourceTile = { level: sourceLevel, x: Math.floor(id.x / scale), y: Math.floor(id.y / scale) };
    const offset = new THREE.Vector2((id.x - sourceTile.x * scale) / scale, (id.y - sourceTile.y * scale) / scale);
    const lease = this.decodedTiles.schedule({ sourceId: this.id, kind: 'vector', ...sourceTile }, async (requestSignal) => {
      const bytes = await this.source!.load(sourceTile, requestSignal);
      requestSignal.throwIfAborted();
      return this.decoder.decode(bytes);
    }, { byteSize: estimateDecodedBytes });
    let rejectAbort!: (reason: unknown) => void;
    const abortPromise = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const abort = () => { lease.release(); rejectAbort(signal?.reason ?? new DOMException('Aborted', 'AbortError')); };
    signal?.addEventListener('abort', abort, { once: true });
    let decoded: DecodedVectorTile;
    try { decoded = await Promise.race([lease.promise, abortPromise]); }
    finally { signal?.removeEventListener('abort', abort); lease.release(); }
    signal?.throwIfAborted();
    if (this.disposed) throw new Error('GPU vector provider disposed');
    return { sourceTile, offset, scale, decoded };
  }

  private drawChunk(job: SurfaceDrawJob): boolean {
    const chunk = job.plan.chunks[job.cursor];
    const renderer = this.renderer;
    const oldTarget = renderer.getRenderTarget(), oldCube = renderer.getActiveCubeFace(), oldMip = renderer.getActiveMipmapLevel();
    const oldColor = renderer.getClearColor(new THREE.Color()), oldAlpha = renderer.getClearAlpha(), oldAuto = renderer.autoClear;
    const geometry = new THREE.BufferGeometry();
    try {
      if (!job.target) {
        job.target = new THREE.WebGLRenderTarget(this.tileSize, this.tileSize, { depthBuffer: false });
        job.target.texture.colorSpace = THREE.SRGBColorSpace;
        job.target.texture.generateMipmaps = true;
        job.target.texture.minFilter = THREE.LinearMipmapLinearFilter;
      }
      const scene = new THREE.Scene();
      if (chunk) {
        geometry.setAttribute('position', new THREE.BufferAttribute(chunk.positions, 3));
        geometry.setAttribute('lineDistance', new THREE.BufferAttribute(chunk.distances, 1));
        if (chunk.layer.type !== 'circle') geometry.setIndex(new THREE.BufferAttribute(chunk.indices, 1));
        const material = this.materialForChunk(chunk, job.offset, job.scale);
        const object = chunk.layer.type === 'circle' ? new THREE.Points(geometry, material) : new THREE.Mesh(geometry, material);
        object.frustumCulled = false; object.renderOrder = chunk.order; scene.add(object);
      }
      const finished = job.cursor + 1 >= job.plan.chunks.length;
      // Allocate the complete mip chain first; only generate it on completion.
      renderer.setRenderTarget(job.target);
      job.target.texture.generateMipmaps = finished;
      renderer.setClearColor(0, 0); renderer.autoClear = false;
      if (job.cursor === 0) renderer.clear(true, false, false);
      renderer.render(scene, this.camera);
      job.cursor++;
      if (finished) {
        const target = job.target;
        target.texture.addEventListener('dispose', () => target.dispose());
        job.resolve(target.texture); job.target = null;
      }
      return finished;
    } finally {
      if (job.target) job.target.texture.generateMipmaps = true;
      renderer.setRenderTarget(oldTarget, oldCube, oldMip);
      renderer.setClearColor(oldColor, oldAlpha); renderer.autoClear = oldAuto;
      geometry.dispose();
    }
  }

  private acquireSlot(signal?: AbortSignal): Promise<void> {
    if (this.disposed || signal?.aborted) return Promise.reject(signal?.reason ?? new Error('Provider disposed'));
    if (this.occupiedSlots < this.maxPreparedTiles) { this.occupiedSlots++; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, abort: () => {
        const index = this.slotWaiters.indexOf(waiter); if (index >= 0) this.slotWaiters.splice(index, 1);
        signal?.removeEventListener('abort', waiter.abort); reject(signal?.reason);
      } };
      signal?.addEventListener('abort', waiter.abort, { once: true }); this.slotWaiters.push(waiter);
    });
  }
  private releaseSlot(): void {
    this.occupiedSlots--;
    const waiter = this.slotWaiters.shift();
    if (waiter) { waiter.signal?.removeEventListener('abort', waiter.abort); this.occupiedSlots++; waiter.resolve(); }
  }
  private async warmPrograms(): Promise<void> {
    // Two common variants only. compileAsync can use KHR_parallel_shader_compile;
    // it does not eliminate synchronous driver costs on unsupported devices.
    const scene = new THREE.Scene(), geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    geometry.setAttribute('lineDistance', new THREE.BufferAttribute(new Float32Array(1), 1));
    for (const type of ['background', 'circle']) {
      const chunk: SurfaceChunk = { layer: { id: 'warm', type }, order: 0,
        positions: new Float32Array(), distances: new Float32Array(), indices: new Uint16Array(), bytes: 0 };
      const material = this.materialForChunk(chunk, new THREE.Vector2(), 1);
      scene.add(type === 'circle' ? new THREE.Points(geometry, material) : new THREE.Mesh(geometry, material));
    }
    try { await this.renderer.compileAsync(scene, this.camera); }
    finally { geometry.dispose(); }
    if (this.disposed) throw new Error('GPU vector provider disposed during warmup');
  }

  private materialForChunk(chunk: SurfaceChunk, offset: THREE.Vector2, scale: number): THREE.ShaderMaterial {
    const { layer } = chunk, type = layer.type;
    const colorValue = layer.paint?.[type + '-color'] ?? '#000000';
    const opacityValue = layer.paint?.[type + '-opacity'] ?? 1;
    const dash = layer.paint?.['line-dasharray'];
    const dashValues = Array.isArray(dash) ? dash.slice(0, 8).map(Number) : [];
    const lineWidth = Number(layer.paint?.['line-width'] ?? 1);
    const uniforms = {
      tileScale: { value: type === 'background' ? 1 : scale },
      tileOffset: { value: type === 'background' ? new THREE.Vector2() : offset },
      color: { value: new THREE.Color(typeof colorValue === 'string' ? colorValue : '#000000') },
      opacity: { value: typeof opacityValue === 'number' ? opacityValue : 1 },
      pointSize: { value: Number(layer.paint?.['circle-radius'] ?? 3) * 2 },
      dash: { value: [...dashValues.map(value => value * lineWidth), ...new Array(8 - dashValues.length).fill(0)] },
      dashCount: { value: dashValues.length },
      dashPeriod: { value: dashValues.reduce((sum, value) => sum + value * lineWidth, 0) }
    };
    const key = type === 'circle' ? 'circle' : 'surface';
    let material = this.surfaceMaterials.get(key);
    if (material) {
      for (const [name, uniform] of Object.entries(uniforms)) material.uniforms[name]!.value = uniform.value;
      return material;
    }
    material = new THREE.ShaderMaterial({
      uniforms,
      // Local XYZ Y grows southward; FBO Y grows upward. TMS is network-only.
      vertexShader: 'uniform float pointSize; uniform float tileScale; uniform vec2 tileOffset; attribute float lineDistance; varying float v_distance; void main(){v_distance=lineDistance;vec2 p=(position.xy-tileOffset)*tileScale;gl_Position=vec4(p.x*2.0-1.0,1.0-p.y*2.0,0.0,1.0);gl_PointSize=pointSize;}',
      fragmentShader: `uniform vec3 color; uniform float opacity;
            uniform float dash[8]; uniform int dashCount; uniform float dashPeriod; varying float v_distance;
            void main(){
            if(dashCount>0 && dashPeriod>0.0){
              float phase=mod(v_distance,dashPeriod); float edge=0.0;
              for(int i=0;i<8;i++) { if(i>=dashCount)break; edge+=dash[i];
                if(phase<edge) { if(i==1 || i==3 || i==5 || i==7)discard; break; }
              }
            }
            ${type === 'circle' ? 'if(distance(gl_PointCoord,vec2(0.5))>0.5)discard;' : ''}
            gl_FragColor=vec4(color,opacity);
            #include <colorspace_fragment>
          }`,
      side: THREE.DoubleSide, transparent: true, depthTest: false, depthWrite: false, toneMapped: false
    });
    this.surfaceMaterials.set(key, material);
    return material;
  }

  private enqueueDraw(plan: SurfacePlan, offset: THREE.Vector2, scale: number, signal?: AbortSignal): Promise<THREE.Texture> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const job: SurfaceDrawJob = { plan, offset, scale, cursor: 0, target: null, resolve, reject, signal, abort: () => {
        const index = this.drawQueue.indexOf(job);
        if (index >= 0) this.drawQueue.splice(index, 1);
        job.target?.dispose(); job.target = null;
        signal?.removeEventListener('abort', job.abort);
        reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      } };
      signal?.addEventListener('abort', job.abort, { once: true });
      this.drawQueue.push(job); this.scheduleDrawFrame();
    });
  }

  private scheduleDrawFrame(): void {
    if (this.drawFrame !== null || this.disposed || !this.drawQueue.length) return;
    this.drawFrame = requestAnimationFrame((timestamp) => {
      this.drawFrame = null;
      if (this.renderer.getContext().isContextLost()) {
        this.contextWasLost = true; this.scheduleDrawFrame(); return;
      }
      if (this.contextWasLost) {
        for (const job of this.drawQueue) { job.target?.dispose(); job.target = null; job.cursor = 0; }
        this.contextWasLost = false;
      }
      this.workBudget?.beginFrame(timestamp);
      const startedAt = performance.now();
      let count = 0, steps = 0, bytes = 0;
      while (this.drawQueue.length && count < this.maxDrawsPerFrame && steps < this.maxDrawChunksPerFrame) {
        if (this.workBudget && !this.workBudget.canStart) break;
        const job = this.drawQueue[0]!;
        if (job.signal?.aborted) { job.abort(); continue; }
        const uploadBytes = job.plan.chunks[job.cursor]?.bytes ?? 0;
        if (steps && bytes + uploadBytes > this.maxUploadBytesPerFrame) break;
        const drawStartedAt = performance.now();
        let finished = false;
        try { finished = this.drawChunk(job); }
        catch (error) { job.target?.dispose(); job.target = null; job.reject(error); finished = true; }
        if (finished) {
          this.drawQueue.shift(); job.signal?.removeEventListener('abort', job.abort); count++;
        }
        steps++; bytes += uploadBytes;
        this.lastDrawMs = performance.now() - drawStartedAt;
        this.workBudget?.spend(this.lastDrawMs);
        this.maxDrawMs = Math.max(this.maxDrawMs, this.lastDrawMs);
        this.recentDraws.push({ at: performance.now(), ms: this.lastDrawMs, finished });
        while (this.recentDraws.length > 120) this.recentDraws.shift();
        // A bounded chunk can still exceed the soft time quota (driver shader
        // compile/upload). Never start another step after such an overrun.
        if (performance.now() - startedAt >= this.drawBudgetMs) break;
      }
      this.lastUploadBytes = bytes;
      this.scheduleDrawFrame();
    });
  }

  dispose(): void {
    this.disposed = true;
    if (this.drawFrame !== null) cancelAnimationFrame(this.drawFrame);
    this.drawFrame = null;
    for (const waiter of this.slotWaiters.splice(0)) {
      waiter.signal?.removeEventListener('abort', waiter.abort); waiter.reject(new Error('GPU vector provider disposed'));
    }
    for (const job of this.drawQueue.splice(0)) {
      job.target?.dispose(); job.target = null;
      job.signal?.removeEventListener('abort', job.abort);
      job.reject(new Error('GPU vector provider disposed'));
    }
    this.decodedTiles.clear(true); this.decoder.dispose();
    this.surfaceBuilder.dispose();
    for (const material of this.surfaceMaterials.values()) material.dispose();
    this.surfaceMaterials.clear();
  }
}

function estimateDecodedBytes(tile: DecodedVectorTile): number {
  let bytes = 0;
  for (const features of tile.values()) for (const feature of features) {
    bytes += 128 + JSON.stringify(feature.properties).length * 2;
    for (const ring of feature.geometry) bytes += ring.length * 32;
  }
  return bytes;
}
