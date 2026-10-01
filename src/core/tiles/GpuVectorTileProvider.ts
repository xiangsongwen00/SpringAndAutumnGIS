import * as THREE from 'three';
import { UrlTemplateRasterProvider } from './RasterTileProvider';
import type { TileId } from '../tiling/GeographicTilingScheme';
import { MapStyleLoader, type MapStyleLoaderOptions } from '../../vector/style/MapStyleLoader';
import { VectorStyleRuntime } from '../../vector/style/VectorStyleRuntime';
import { VectorDecodeService } from '../../vector/worker/VectorDecodeService';
import { MvtTileSource } from '../../vector/source/MvtTileSource';
import { buildFillGeometry, buildLineStrokeGeometry, buildPointGeometry } from '../../vector/bucket/VectorGeometryBuilder';
import type { VectorSource } from '../../vector/style/VectorStyleTypes';
import { analyzeVectorSurfaceStyle } from '../../vector/style/VectorSurfaceCapabilities';
import type { MapStyleCapabilityReport } from '../../vector/style/MapStyleLoader';
import { RequestScheduler } from './RequestScheduler';
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
};

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
  private drawFrame: number | null = null;
  private readonly drawQueue: Array<{ run: () => THREE.Texture; resolve: (texture: THREE.Texture) => void;
    reject: (error: unknown) => void; signal?: AbortSignal; abort: () => void }> = [];
  private lastDrawMs = 0;
  private maxDrawMs = 0;
  private readonly recentDraws: Array<{ at: number; ms: number }> = [];
  private runtime: VectorStyleRuntime | null = null;
  private source: MvtTileSource | null = null;
  private sourceId = '';
  private readonly camera = new THREE.Camera();
  private readonly surfaceMaterials = new Map<string, THREE.ShaderMaterial>();
  private readonly types = new Set(['background', 'fill', 'line', 'circle']);
  private disposed = false;
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
    this.configuredDataMaxLevel = options.maxLevel;
    this._dataMaxLevel = Math.max(this.minLevel, Math.round(options.maxLevel ?? options.source?.maxzoom ?? 22));
  }

  async initialize(): Promise<void> {
    const style = await this.loader.load();
    const selected = this.loader.selectVectorSource(style);
    this.sourceId = selected.id;
    this.runtime = new VectorStyleRuntime(style);
    this.capabilityReport = analyzeVectorSurfaceStyle(style);
    this.unsupportedLayers = new Set(this.capabilityReport.issues
      .filter((issue) => issue.severity === 'unsupported').map((issue) => issue.layerId));
    this.source = new MvtTileSource({ id: selected.id, source: { ...selected.source, ...this.sourceOverride }, fetcher: this.loaderFetcher });
    await this.source.initialize();
    this._dataMaxLevel = Math.max(this.minLevel, Math.round(this.configuredDataMaxLevel ??
      this.sourceOverride?.maxzoom ?? selected.source.maxzoom ?? 22));
    this._dataMaxLevel = Math.min(this._dataMaxLevel, this.source.maxLevel);
    if (this.runtime.issues.length) throw new Error(`样式编译失败：${JSON.stringify(this.runtime.issues.slice(0, 3))}`);
    console.info(`[GPU vector ${this.id}] 地表初版能力边界`, this.limitations);
    console.info(`[GPU vector ${this.id}] 样式绘制能力`, this.capabilityReport);
  }

  get styleIssues() { return this.runtime?.issues ?? []; }
  get dataMaxLevel() { return this._dataMaxLevel; }
  get decodedCacheStats() { return this.decodedTiles.stats; }
  get drawStats() {
    const cutoff = performance.now() - 1000;
    while (this.recentDraws.length && this.recentDraws[0]!.at < cutoff) this.recentDraws.shift();
    return { queued: this.drawQueue.length, lastMs: this.lastDrawMs, maxMs: this.maxDrawMs,
      recentCount: this.recentDraws.length, recentMs: this.recentDraws.reduce((sum, draw) => sum + draw.ms, 0) };
  }

  async loadTexture(id: TileId, signal?: AbortSignal): Promise<THREE.Texture> {
    const { sourceTile, offset, scale, decoded } = await this.loadSourceTile(id, signal);
    return this.enqueueDraw(() => this.drawTile(id, sourceTile, offset, scale, decoded), signal);
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
    if (!this.source || !this.runtime) throw new Error('GPU vector provider is not initialized');
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

  private drawTile(id: TileId, sourceTile: TileId, offset: THREE.Vector2, scale: number,
    decoded: DecodedVectorTile): THREE.Texture {
    const scene = new THREE.Scene();
    const resources: Array<THREE.BufferGeometry | THREE.Material> = [];
    const target = new THREE.WebGLRenderTarget(this.tileSize, this.tileSize, { depthBuffer: false });
    target.texture.colorSpace = THREE.SRGBColorSpace;
    target.texture.generateMipmaps = true;
    target.texture.minFilter = THREE.LinearMipmapLinearFilter;
    const renderer = this.renderer;
    const oldTarget = renderer.getRenderTarget();
    const oldCubeFace = renderer.getActiveCubeFace();
    const oldMipmapLevel = renderer.getActiveMipmapLevel();
    const oldColor = renderer.getClearColor(new THREE.Color());
    const oldAlpha = renderer.getClearAlpha();
    const oldAutoClear = renderer.autoClear;
    try {
      const visibleFeatures = scale === 1 ? decoded : filterToSubtile(decoded, offset, scale, this.tileSize);
      const buckets = this.runtime!.buckets(visibleFeatures, this.sourceId, id.level, this.types)
        .filter((bucket) => !this.unsupportedLayers.has(bucket.layer.id));
      const drawBuckets = buckets.flatMap((bucket) => {
        const outline = bucket.layer.paint?.['fill-outline-color'];
        return bucket.layer.type === 'fill' && outline ? [bucket, {
          ...bucket, order: bucket.order + 0.001,
          layer: { ...bucket.layer, type: 'line', paint: {
            'line-color': outline, 'line-opacity': bucket.layer.paint?.['fill-opacity'] ?? 1, 'line-width': 1
          } }
        }] : [bucket];
      });
      let materialIndex = 0;
      for (const bucket of drawBuckets) {
        const { layer, features, order } = bucket;
        const type = layer.type;
        const builder = type === 'fill' ? buildFillGeometry(sourceTile, features, false)
          : type === 'line' ? buildLineStrokeGeometry(sourceTile, features, Number(layer.paint?.['line-width'] ?? 1), this.tileSize * scale)
          : type === 'circle' ? buildPointGeometry(sourceTile, features) : null;
        const geometry = new THREE.BufferGeometry();
        const positions = type === 'background'
          ? [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]
          : builder!.uvs.flatMap((value, index, values) => index % 2 ? [] : [value, values[index + 1]!, 0]);
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.setAttribute('lineDistance', new THREE.Float32BufferAttribute(
          builder?.distances ?? new Array(positions.length / 3).fill(0), 1));
        if (type === 'background') geometry.setIndex([0, 1, 2, 1, 3, 2]);
        else if (builder!.indices.length) geometry.setIndex(builder!.indices);
        const colorValue = layer.paint?.[`${type}-color`] ?? '#000000';
        const opacityValue = layer.paint?.[`${type}-opacity`] ?? 1;
        const dash = layer.paint?.['line-dasharray'];
        const dashValues = Array.isArray(dash) ? dash.slice(0, 8).map(Number) : [];
        const lineWidth = Number(layer.paint?.['line-width'] ?? 1);
        const uniforms = {
            tileScale: { value: type === 'background' ? 1 : scale },
            tileOffset: { value: type === 'background' ? new THREE.Vector2() : offset },
            color: { value: new THREE.Color(typeof colorValue === 'string' ? colorValue : '#000000') },
            opacity: { value: typeof opacityValue === 'number' ? opacityValue : 1 },
            pointSize: { value: Number(layer.paint?.['circle-radius'] ?? 3) * 2 },
            dash: { value: [...dashValues.map((value) => value * lineWidth), ...new Array(8 - dashValues.length).fill(0)] },
            dashCount: { value: dashValues.length },
            dashPeriod: { value: dashValues.reduce((sum, value) => sum + value * lineWidth, 0) }
          };
        const materialKey = `${type === 'circle' ? 'circle' : 'surface'}/${materialIndex++}`;
        let material = this.surfaceMaterials.get(materialKey);
        if (material) {
          for (const [name, uniform] of Object.entries(uniforms)) material.uniforms[name]!.value = uniform.value;
        } else {
          material = new THREE.ShaderMaterial({
          uniforms,
          // MVT local Y grows southward; FBO texture Y grows upward. North
          // must land at texture Y=1, matching RasterTileLayer's 1-xyzUv.y.
          // XYZ/TMS row conversion belongs exclusively to MvtTileSource.
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
          // Keep a bounded pool of rendered materials/program references.
          // Disposing every bucket after each tile deleted the last shader
          // reference and forced repeated driver compilation on later tiles.
          if (this.surfaceMaterials.size < 256) this.surfaceMaterials.set(materialKey, material);
        }
        const object = type === 'circle' ? new THREE.Points(geometry, material) : new THREE.Mesh(geometry, material);
        object.renderOrder = order;
        object.frustumCulled = false;
        scene.add(object);
        resources.push(geometry);
        if (this.surfaceMaterials.get(materialKey) !== material) resources.push(material);
      }
      renderer.setRenderTarget(target);
      // RenderTarget.viewport is already in physical texture pixels.
      // setViewport() scales by renderer DPR even for offscreen targets;
      // using it here crops/enlarges each tile on HiDPI screens.
      // setRenderTarget applies target.viewport/scissor without DPR scaling.
      renderer.setClearColor(0, 0);
      renderer.autoClear = true;
      renderer.render(scene, this.camera);
      target.texture.addEventListener('dispose', () => target.dispose());
      return target.texture;
    } catch (error) {
      target.dispose(); throw error;
    } finally {
      renderer.setRenderTarget(oldTarget, oldCubeFace, oldMipmapLevel);
      renderer.setClearColor(oldColor, oldAlpha);
      renderer.autoClear = oldAutoClear;
      for (const resource of resources) resource.dispose();
    }
  }

  private enqueueDraw(run: () => THREE.Texture, signal?: AbortSignal): Promise<THREE.Texture> {
    return new Promise((resolve, reject) => {
      const job = { run, resolve, reject, signal, abort: () => {
        const index = this.drawQueue.indexOf(job);
        if (index >= 0) this.drawQueue.splice(index, 1);
        signal?.removeEventListener('abort', job.abort);
        reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      } };
      signal?.addEventListener('abort', job.abort, { once: true });
      this.drawQueue.push(job);
      this.scheduleDrawFrame();
    });
  }

  private scheduleDrawFrame(): void {
    if (this.drawFrame !== null || this.disposed || !this.drawQueue.length) return;
    this.drawFrame = requestAnimationFrame(() => {
      this.drawFrame = null;
      const startedAt = performance.now();
      let count = 0;
      while (this.drawQueue.length && count < this.maxDrawsPerFrame) {
        const job = this.drawQueue.shift()!;
        job.signal?.removeEventListener('abort', job.abort);
        if (job.signal?.aborted) { job.reject(job.signal.reason); continue; }
        const drawStartedAt = performance.now();
        try { job.resolve(job.run()); } catch (error) { job.reject(error); }
        this.lastDrawMs = performance.now() - drawStartedAt;
        this.maxDrawMs = Math.max(this.maxDrawMs, this.lastDrawMs);
        this.recentDraws.push({ at: performance.now(), ms: this.lastDrawMs });
        while (this.recentDraws.length > 120) this.recentDraws.shift();
        count++;
        // One indivisible tile can exceed the budget; never start another
        // one then. Worker Bucket subdivision is still needed for that case.
        if (performance.now() - startedAt >= this.drawBudgetMs) break;
      }
      this.scheduleDrawFrame();
    });
  }

  dispose(): void {
    this.disposed = true;
    if (this.drawFrame !== null) cancelAnimationFrame(this.drawFrame);
    this.drawFrame = null;
    for (const job of this.drawQueue.splice(0)) {
      job.signal?.removeEventListener('abort', job.abort);
      job.reject(new Error('GPU vector provider disposed'));
    }
    this.decodedTiles.clear(true); this.decoder.dispose();
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

/** Coarse bbox rejection before style evaluation/triangulation of overzoom tiles. */
function filterToSubtile(tile: DecodedVectorTile, offset: THREE.Vector2, scale: number, tileSize: number): DecodedVectorTile {
  const result = new Map();
  const padding = 64 / (tileSize * scale);
  for (const [name, features] of tile) result.set(name, features.filter((feature) => {
    let west = Infinity, north = Infinity, east = -Infinity, south = -Infinity;
    for (const ring of feature.geometry) for (const point of ring) {
      west = Math.min(west, point.x / feature.extent); east = Math.max(east, point.x / feature.extent);
      north = Math.min(north, point.y / feature.extent); south = Math.max(south, point.y / feature.extent);
    }
    return east >= offset.x - padding && west <= offset.x + 1 / scale + padding &&
      south >= offset.y - padding && north <= offset.y + 1 / scale + padding;
  }));
  return result;
}
