import * as THREE from 'three';
import { Ellipsoid } from '../core/geo/Ellipsoid';
import { tileRequestUrgency, type SelectedTile } from '../core/lod/GlobeLodSelector';
import type { RasterTileProvider } from '../core/tiles/RasterTileProvider';
import {
  TileStateMachine,
  type TileContentKey,
  type TileContentKind
} from '../core/tiles/TileStateMachine';
import { tileKey, type TileId } from '../core/tiling/GeographicTilingScheme';
import { globeCoordinateShader } from './shaders/coordinates';
import type { TerrainHeightSource } from './TerrainTileLayer';
import { terrainSurfaceEdges } from '../core/terrain/TerrainSurfaceEdges';
import { intersectRasterSurface } from './RasterSurfacePicker';
import type { SurfaceRayHit } from '../core/geo/SurfacePicker';

export type RasterTileLayerOptions = {
  /** Short-lived previous high-detail coverage on the same surface mesh. */
  continuityMs?: number;
  maxContinuityBytes?: number;
  maxContinuityPatches?: number;
  segments?: number;
  maxConcurrentRequests?: number;
  maxCachedTiles?: number;
  /** Hard resident texture budget. Defaults to 192 MiB. */
  maxTextureBytes?: number;
  surfaceOffset?: number;
  maxAnisotropy?: number;
  terrain?: TerrainHeightSource;
  visible?: boolean;
  opacity?: number;
  order?: number;
  /** Transparent surface overlay such as a label tile layer. */
  overlay?: boolean;
  /** Shared lifecycle registry. GlobeEngine supplies one registry to every raster layer. */
  tileStateMachine?: TileStateMachine;
  contentKind?: Extract<TileContentKind, 'imagery' | 'rasterized-vector'>;
};

export type RasterTileLayerStats = Readonly<{
  ready: number;
  loading: number;
  queued: number;
  errors: number;
  fallbacks: number;
  textureBytes: number;
  desiredMinimumLevel: number | null;
  desiredMaximumLevel: number | null;
  displayedMinimumLevel: number | null;
  displayedMaximumLevel: number | null;
  lastError: string | null;
  continuityPatches: number;
  continuityBytes: number;
}>;

type TextureState = 'queued' | 'loading' | 'ready' | 'error';
type TextureRecord = {
  id: TileId;
  key: string;
  state: TextureState;
  priority: number;
  lastUsedFrame: number;
  texture: THREE.Texture | null;
  byteSize: number;
  attempts: number;
  retryAt: number;
  controller: AbortController | null;
  active: boolean;
  requestClass?: 'coverage' | 'detail';
};
type RenderTile = {
  id: TileId;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  textureKey: string;
  terrainKey: string;
};
type ContinuityPatch = { id: TileId; sourceKey: string; expires: number };

/** Visible-leaf raster consumer. Selection remains owned by GlobeLodSelector. */
export class RasterTileLayer {
  readonly object3d = new THREE.Group();
  /** Query only; no change to tile selection, DEM publication or GPU geometry. */
  pickSurface(ray:THREE.Ray):SurfaceRayHit|null {
    if(!this.visible||this.disposed)return null;
    let best:SurfaceRayHit|null=null,distance=Infinity;
    const candidates=[...this.renderTiles.values()].filter(tile=>tile.mesh.visible).map(tile=>{
      const u=tile.mesh.material.uniforms,center=(u.sag_originHigh!.value as THREE.Vector3).clone().add(u.sag_originLow!.value);
      const radius=this.ellipsoid.equatorialRadius*Math.min(2,Math.abs(u.tileLongitudeSpan!.value)+Math.abs(u.tileMercatorSpan!.value))+30000*Math.max(1,u.terrainExaggeration!.value);
      return {tile,center,radius};
    }).filter(item=>ray.intersectsSphere(new THREE.Sphere(item.center,item.radius))).sort((a,b)=>ray.origin.distanceTo(a.center)-ray.origin.distanceTo(b.center));
    for(const item of candidates){if(ray.origin.distanceTo(item.center)-item.radius>distance)continue;
      const world=intersectRasterSurface(ray,item.tile.mesh,this.ellipsoid,distance);if(world){distance=ray.origin.distanceTo(world);best={world,tile:{...item.tile.id}};}}
    return best;
  }
  provider: RasterTileProvider;

  private readonly ellipsoid: Ellipsoid;
  private readonly geometries = new Map<number, THREE.BufferGeometry>();
  private readonly baseSegments: number;
  private readonly renderTiles = new Map<string, RenderTile>();
  /** Recently hidden exact tile meshes; no imagery/DEM textures retained. */
  private readonly spareTiles = new Map<string, { tile: RenderTile; bytes: number }>();
  private spareBytes = 0;
  private readonly textures = new Map<string, TextureRecord>();
  private readonly visibleTextureKeys = new Set<string>();
  private readonly desiredTextureKeys = new Set<string>();
  private readonly maxConcurrentRequests: number;
  private readonly maxCachedTiles: number;
  private readonly maxTextureBytes: number;
  private readonly surfaceOffset: number;
  private readonly maxAnisotropy: number;
  private readonly terrain?: TerrainHeightSource;
  private readonly overlay: boolean;
  readonly tileStateMachine: TileStateMachine;
  private readonly contentKind: Extract<TileContentKind, 'imagery' | 'rasterized-vector'>;
  private layerOpacity: number;
  private readonly cameraHigh = new THREE.Vector3();
  private readonly cameraLow = new THREE.Vector3();
  private readonly tileOrigin = new THREE.Vector3();
  private frame = 0;
  private activeRequests = 0;
  private disposed = false;
  private fallbackCount = 0;
  private suspended = false;
  private lastSelection: readonly SelectedTile[] | null = null;
  private edgeSelection: readonly SelectedTile[] | null = null;
  private edgeRevision = -1;
  private edgeTileSignature = '';
  private readonly retainedEdgePoints = new Map<string, THREE.Vector3>();
  private materialsDirty = true;
  private observedTerrainRevision = -1;
  private observedProviderRevision = -1;
  private desiredMinimumLevel: number | null = null;
  private desiredMaximumLevel: number | null = null;
  private displayedMinimumLevel: number | null = null;
  private displayedMaximumLevel: number | null = null;
  private lastError: string | null = null;
  private warnedProviderId: string | null = null;
  private readonly transitionTextures = new Set<THREE.Texture>();
  private readonly continuity = new Map<string, ContinuityPatch>();
  private continuitySamplingOrder: ContinuityPatch[] = [];
  private readonly continuityMs: number;
  private readonly maxContinuityBytes: number;
  private readonly maxContinuityPatches: number;
  private coverageRun = 0;
  private nextContinuityExpiry = Infinity;
  private observedMappingOffset: number | null | undefined;

  constructor(
    ellipsoid: Ellipsoid,
    provider: RasterTileProvider,
    options: RasterTileLayerOptions = {}
  ) {
    this.ellipsoid = ellipsoid;
    this.continuityMs = Math.max(0, options.continuityMs ?? 2000);
    this.maxContinuityBytes = Math.max(0, options.maxContinuityBytes ?? 24 * 1024 * 1024);
    this.maxContinuityPatches = Math.max(0, Math.floor(options.maxContinuityPatches ?? 64));
    this.provider = provider;
    this.baseSegments = Math.max(2, Math.round(options.segments ?? 16));
    this.maxConcurrentRequests = Math.max(1, Math.round(options.maxConcurrentRequests ?? 8));
    this.maxCachedTiles = Math.max(16, Math.round(options.maxCachedTiles ?? 512));
    this.maxTextureBytes = Math.max(
      16 * 1024 * 1024,
      Math.round(options.maxTextureBytes ?? 192 * 1024 * 1024)
    );
    this.maxContinuityBytes = Math.min(this.maxContinuityBytes, this.maxTextureBytes / 4);
    this.observedMappingOffset = provider.viewLevelOffset ?? provider.levelOffset;
    this.surfaceOffset = Math.max(0, options.surfaceOffset ?? 0.1);
    this.maxAnisotropy = Math.max(1, options.maxAnisotropy ?? 1);
    this.terrain = options.terrain;
    this.overlay = options.overlay ?? false;
    this.tileStateMachine = options.tileStateMachine ?? new TileStateMachine();
    this.contentKind = options.contentKind ?? 'imagery';
    this.layerOpacity = THREE.MathUtils.clamp(options.opacity ?? 1, 0, 1);
    this.object3d.visible = options.visible ?? true;
    this.object3d.renderOrder = options.order ?? 1;
  }

  get visible(): boolean {
    return this.object3d.visible;
  }

  get opacity(): number {
    return this.layerOpacity;
  }

  setVisible(visible: boolean): void {
    this.object3d.visible = visible;
  }

  setOpacity(opacity: number): void {
    const next = THREE.MathUtils.clamp(opacity, 0, 1);
    if (next === this.layerOpacity) return;
    this.layerOpacity = next;
    for (const renderTile of [...this.renderTiles.values(), ...[...this.spareTiles.values()].map(entry => entry.tile)]) {
      renderTile.mesh.material.uniforms.layerOpacity!.value = next;
      renderTile.mesh.material.transparent = this.overlay || next < 1;
      renderTile.mesh.material.needsUpdate = true;
    }
  }

  setOrder(order: number): void {
    this.object3d.renderOrder = order;
    for (const renderTile of this.renderTiles.values()) renderTile.mesh.renderOrder = order;
    for (const { tile } of this.spareTiles.values()) tile.mesh.renderOrder = order;
  }

  update(
    selection: readonly SelectedTile[],
    cameraPosition?: THREE.Vector3
  ): RasterTileLayerStats {
    if (this.disposed) return this.stats;
    if (cameraPosition) splitVector3(cameraPosition, this.cameraHigh, this.cameraLow);
    const selectionChanged = selection !== this.lastSelection;
    const terrainRevision = this.terrain?.revision ?? -1;
    const terrainChanged = terrainRevision !== this.observedTerrainRevision;
    const providerRevision = this.provider.revision ?? 0;
    const sourceLevelsChanged = providerRevision !== this.observedProviderRevision;
    const coverageExpired = performance.now() >= this.nextContinuityExpiry;
    const mappingOffset = this.provider.viewLevelOffset ?? this.provider.levelOffset;
    const explicitOffsetChanged = mappingOffset !== this.observedMappingOffset;
    this.observedMappingOffset = mappingOffset;
    if (explicitOffsetChanged) this.continuity.clear();
    // Provider revision also advances on ordinary camera/source zoom changes.
    // Those are precisely the changes that need a display handoff, not invalidation.
    if ((selectionChanged || sourceLevelsChanged) && !explicitOffsetChanged) this.captureContinuity(selection);
    if (selectionChanged || sourceLevelsChanged || coverageExpired || this.materialsDirty) this.pruneContinuity(selection);
    if (selectionChanged || sourceLevelsChanged) {
      this.frame += 1;
      this.lastSelection = selection;
      this.observedProviderRevision = providerRevision;
      if (selectionChanged) this.syncRenderTiles(selection);
      this.queueVisibleTextures(selection);
    }
    if (selectionChanged || sourceLevelsChanged || terrainChanged || this.materialsDirty || coverageExpired) {
      this.observedTerrainRevision = terrainRevision;
      this.syncMaterials(selection);
      this.evictTextures();
      this.materialsDirty = false;
    }
    this.pumpQueue();
    return this.stats;
  }

  get stats(): RasterTileLayerStats {
    const counts = { ready: 0, loading: 0, queued: 0, errors: 0 };
    for (const record of this.textures.values()) {
      if (record.state === 'error') counts.errors += 1;
      else counts[record.state] += 1;
    }
    this.releaseTransitionTextures(true);
    return {
      ...counts,
      fallbacks: this.fallbackCount,
      textureBytes: this.residentTextureBytes(),
      desiredMinimumLevel: this.desiredMinimumLevel,
      desiredMaximumLevel: this.desiredMaximumLevel,
      displayedMinimumLevel: this.displayedMinimumLevel,
      displayedMaximumLevel: this.displayedMaximumLevel,
      lastError: this.lastError,
      continuityPatches: this.continuity.size,
      continuityBytes: this.continuityBytes()
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.continuity.clear();
    this.continuitySamplingOrder = [];
    for (const renderTile of this.renderTiles.values()) {
      renderTile.mesh.material.dispose(); renderTile.mesh.geometry.dispose();
    }
    for (const { tile } of this.spareTiles.values()) {
      tile.mesh.material.dispose(); tile.mesh.geometry.dispose();
    }
    this.spareTiles.clear(); this.spareBytes = 0;
    for (const record of this.textures.values()) {
      this.cancelTileRecord(record);
      this.releaseTexture(record.texture);
    }
    this.renderTiles.clear();
    this.textures.clear();
    for (const geometry of this.geometries.values()) geometry.dispose();
    this.geometries.clear();
    this.retainedEdgePoints.clear();
    this.object3d.clear();
  }

  setProvider(provider: RasterTileProvider): void {
    if (provider.id === this.provider.id) return;
    const displayedTextures = new Set<THREE.Texture>();
    for (const renderTile of this.renderTiles.values()) {
      const texture = renderTile.mesh.material.uniforms.tileTexture?.value;
      if (texture instanceof THREE.Texture) displayedTextures.add(texture);
      renderTile.textureKey = '';
    }
    for (const texture of this.transitionTextures) {
      if (!displayedTextures.has(texture)) this.releaseTexture(texture);
    }
    this.transitionTextures.clear();
    for (const texture of displayedTextures) this.transitionTextures.add(texture);
    for (const record of this.textures.values()) {
      this.cancelTileRecord(record);
      if (record.texture && !this.transitionTextures.has(record.texture)) {
        this.releaseTexture(record.texture);
      }
    }
    this.provider = provider;
    this.observedMappingOffset = provider.viewLevelOffset ?? provider.levelOffset;
    this.continuity.clear(); this.nextContinuityExpiry = Infinity; this.coverageRun = 0;
    this.continuitySamplingOrder = [];
    this.textures.clear();
    this.visibleTextureKeys.clear();
    this.fallbackCount = 0;
    this.lastError = null;
    this.warnedProviderId = null;
    this.lastSelection = null;
    this.observedProviderRevision = -1;
    this.materialsDirty = true;
    this.activeRequests = 0;
  }

  handleContextLost(): void {
    this.suspended = true;
  }

  handleContextRestored(): void {
    this.suspended = false;
    for (const record of this.textures.values()) {
      if (record.texture) record.texture.needsUpdate = true;
    }
    for (const renderTile of this.renderTiles.values()) {
      renderTile.mesh.material.needsUpdate = true;
    }
    for (const { tile } of this.spareTiles.values()) tile.mesh.material.needsUpdate = true;
    this.materialsDirty = true;
    this.pumpQueue();
  }

  private syncRenderTiles(selection: readonly SelectedTile[]): void {
    const selectedKeys = new Set(selection.map((tile) => tileKey(tile.id)));
    for (const [key, renderTile] of this.renderTiles) {
      if (selectedKeys.has(key)) continue;
      this.object3d.remove(renderTile.mesh);
      const uniforms = renderTile.mesh.material.uniforms;
      for (const name of ['tileTexture', 'terrainTexture', 'terrainParentTexture']) uniforms[name]!.value = null;
      for (let i = 0; i < 4; i++) uniforms[`coverageTexture${i}`]!.value = null;
      uniforms.coverageCount!.value = 0;
      for (const name of ['hasTexture', 'hasTerrain', 'hasTerrainParent']) uniforms[name]!.value = false;
      renderTile.textureKey = ''; renderTile.terrainKey = '';
      const geometry = renderTile.mesh.geometry;
      const bytes = Object.values(geometry.attributes).reduce((sum, attribute) => sum + attribute.array.byteLength, 0) +
        (geometry.index?.array.byteLength ?? 0);
      this.spareTiles.set(key, { tile: renderTile, bytes }); this.spareBytes += bytes;
      this.renderTiles.delete(key);
    }
    for (const tile of selection) {
      const key = tileKey(tile.id);
      if (this.renderTiles.has(key)) continue;
      const retained = this.spareTiles.get(key);
      if (retained) {
        this.spareTiles.delete(key); this.spareBytes -= retained.bytes;
        this.renderTiles.set(key, retained.tile); this.object3d.add(retained.tile.mesh);
        continue;
      }
      const material = this.createMaterial(tile.id);
      const geometry = this.geometryForLevel(tile.id.level).clone();
      const count = geometry.getAttribute('position').count;
      geometry.setAttribute('terrainEdgeHigh', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
      geometry.setAttribute('terrainEdgeLow', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
      geometry.setAttribute('terrainEdgeMask', new THREE.BufferAttribute(new Float32Array(count), 1));
      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      mesh.renderOrder = this.object3d.renderOrder;
      mesh.onBeforeRender = (_renderer, _scene, camera) => {
        splitVector3(camera.position, this.cameraHigh, this.cameraLow);
      };
      this.renderTiles.set(key, { id: tile.id, mesh, textureKey: '', terrainKey: '' });
      this.object3d.add(mesh);
    }
    while (this.spareTiles.size > 128 || this.spareBytes > 16 * 1024 * 1024) {
      const key = this.spareTiles.keys().next().value!;
      const entry = this.spareTiles.get(key)!;
      entry.tile.mesh.material.dispose(); entry.tile.mesh.geometry.dispose();
      this.spareBytes -= entry.bytes; this.spareTiles.delete(key);
    }
  }

  private continuityBytes(): number {
    const keys = new Set([...this.continuity.values()].map(patch => patch.sourceKey));
    return [...keys].reduce((bytes, key) => bytes + (this.textures.get(key)?.byteSize ?? 0), 0);
  }

  private captureContinuity(selection: readonly SelectedTile[]): void {
    if (this.overlay || !this.continuityMs) return;
    const now = performance.now();
    const targets = new Map(selection.map(tile => [tileKey(tile.id), tile]));
    for (const tile of this.renderTiles.values()) {
      const source = this.textures.get(tile.textureKey);
      if (source?.state !== 'ready' || !source.texture) continue;
      const target = this.continuityTarget(tile.id, targets);
      if (!target || source.id.level <= (this.findReadyAncestor(target.id)?.id.level ?? -1)) continue;
      const key = tileKey(tile.id);
      // Do not renew a held patch on every movement: zoom-out must eventually settle.
      if (!this.continuity.has(key)) this.continuity.set(key,
        { id: tile.id, sourceKey: source.key, expires: now + this.continuityMs });
    }
  }

  private pruneContinuity(selection: readonly SelectedTile[]): void {
    const now = performance.now(), slots = new Map<string, number>(), sources = new Set<string>();
    const targets = new Map(selection.map(tile => [tileKey(tile.id), tile]));
    let bytes = 0, count = 0;
    this.nextContinuityExpiry = Infinity;
    const patches = [...this.continuity].sort((a, b) =>
      (this.textures.get(b[1].sourceKey)?.id.level ?? 0) - (this.textures.get(a[1].sourceKey)?.id.level ?? 0));
    for (const [key, patch] of patches) {
      const source = this.textures.get(patch.sourceKey);
      const target = this.continuityTarget(patch.id, targets);
      const targetKey = target && tileKey(target.id);
      const cost = sources.has(patch.sourceKey) ? 0 : source?.byteSize ?? 0;
      if (!target || !targetKey || source?.state !== 'ready' || !source.texture || patch.expires <= now ||
          source.id.level <= (this.findReadyAncestor(target.id)?.id.level ?? -1) ||
          this.provider.hasTile?.(ancestorAtLevel(target.id, this.maximumSourceLevel(target.id))) === false ||
          (slots.get(targetKey) ?? 0) >= 4 || count >= this.maxContinuityPatches || bytes + cost > this.maxContinuityBytes) {
        this.continuity.delete(key); continue;
      }
      count++; bytes += cost; sources.add(patch.sourceKey);
      slots.set(targetKey, (slots.get(targetKey) ?? 0) + 1);
      this.nextContinuityExpiry = Math.min(this.nextContinuityExpiry, patch.expires);
    }
    this.continuitySamplingOrder = [...this.continuity.values()].sort((a, b) =>
      (this.textures.get(a.sourceKey)?.id.level ?? 0) - (this.textures.get(b.sourceKey)?.id.level ?? 0));
  }

  private continuityTarget(id: TileId, targets: ReadonlyMap<string, SelectedTile>): SelectedTile | undefined {
    for (let level = id.level; level >= Math.max(0, id.level - 2); level--) {
      const target = targets.get(tileKey(ancestorAtLevel(id, level)));
      if (target) return target;
    }
    return undefined;
  }

  private bindContinuity(tile: RenderTile): void {
    const uniforms = tile.mesh.material.uniforms;
    let slot = 0;
    // Overlapping footprints can occur after another coarsening. Higher detail
    // samples last, so a full parent patch never overwrites its sharper child.
    for (const patch of this.continuitySamplingOrder) {
      if (patch.id.level < tile.id.level || tileKey(ancestorAtLevel(patch.id, tile.id.level)) !== tileKey(tile.id)) continue;
      const source = this.textures.get(patch.sourceKey);
      if (!source?.texture || source.id.level <= (this.textures.get(tile.textureKey)?.id.level ?? -1)) continue;
      const size = 2 ** (patch.id.level - tile.id.level);
      const x = (patch.id.x - tile.id.x * size) / size, y = (patch.id.y - tile.id.y * size) / size;
      const scale = 2 ** (source.id.level - tile.id.level);
      uniforms[`coverageTexture${slot}`]!.value = source.texture;
      (uniforms[`coverageRect${slot}`]!.value as THREE.Vector4).set(x, y, 1 / size, 1 / size);
      (uniforms[`coverageUv${slot}`]!.value as THREE.Vector3).set(scale, tile.id.x * scale - source.id.x, tile.id.y * scale - source.id.y);
      source.lastUsedFrame = this.frame;
      this.displayedMaximumLevel = Math.max(this.displayedMaximumLevel ?? source.id.level, source.id.level);
      if (++slot === 4) break;
    }
    uniforms.coverageCount!.value = slot;
    for (let i = slot; i < 4; i++) uniforms[`coverageTexture${i}`]!.value = null;
  }

  /**
   * Keep the angular size of a raster triangle approximately constant through
   * the coarse globe levels. The powers of two also make every parent edge
   * sample coincide with its two children, preventing T-junction cracks.
   */
  private geometryForLevel(level: number): THREE.BufferGeometry {
    const segments = this.segmentsForLevel(level);
    let geometry = this.geometries.get(segments);
    if (!geometry) {
      geometry = createGridGeometry(segments);
      this.geometries.set(segments, geometry);
    }
    return geometry;
  }

  private segmentsForLevel(level: number): number {
    // A ~1.4 degree angular step is subpixel at a globe overview. The previous
    // 1024-wide world grid spent 16x as many triangles on low-zoom tiles, even
    // without DEM. Terrain/high-zoom detail still uses the base grid density.
    return Math.max(this.baseSegments, Math.round(256 / 2 ** level));
  }

  private createMaterial(tile: TileId): THREE.ShaderMaterial {
    const size = 2 ** tile.level;
    const west = -Math.PI + (tile.x / size) * Math.PI * 2;
    const east = -Math.PI + ((tile.x + 1) / size) * Math.PI * 2;
    const northMercator = Math.PI - (tile.y / size) * Math.PI * 2;
    const southMercator = Math.PI - ((tile.y + 1) / size) * Math.PI * 2;
    const longitudeCenter = (west + east) * 0.5;
    const longitudeSpan = east - west;
    const mercatorCenter = (northMercator + southMercator) * 0.5;
    const mercatorSpan = southMercator - northMercator;
    const latitudeCenter = Math.atan(Math.sinh(mercatorCenter));
    const sinLongitude = Math.sin(longitudeCenter);
    const cosLongitude = Math.cos(longitudeCenter);
    const sinLatitude = Math.sin(latitudeCenter);
    const cosLatitude = Math.cos(latitudeCenter);
    this.ellipsoid.cartographicToCartesian(
      {
        longitude: THREE.MathUtils.radToDeg(longitudeCenter),
        latitude: THREE.MathUtils.radToDeg(latitudeCenter),
        height: this.surfaceOffset
      },
      this.tileOrigin
    );
    const originHigh = new THREE.Vector3();
    const originLow = new THREE.Vector3();
    splitVector3(this.tileOrigin, originHigh, originLow);
    const a = this.ellipsoid.equatorialRadius;
    const b = this.ellipsoid.polarRadius;
    const eccentricitySquared = 1 - (b * b) / (a * a);
    const latitudeTerm = 1 - eccentricitySquared * sinLatitude * sinLatitude;
    const primeVerticalRadius = a / Math.sqrt(latitudeTerm) + this.surfaceOffset;
    const meridionalRadius =
      (a * (1 - eccentricitySquared)) / latitudeTerm ** 1.5 + this.surfaceOffset;
    // Terrain edges are reconciled by height and slope. A vertical skirt turns
    // any transient mismatch into a conspicuous wall at grazing angles, so the
    // regular imagery surface keeps its perimeter on the reconciled edge.
    const terrainSkirtDepth = 0;
    return new THREE.ShaderMaterial({
      uniforms: {
        sag_ellipsoidRadii: {
          value: new THREE.Vector2(
            this.ellipsoid.equatorialRadius,
            this.ellipsoid.polarRadius
          )
        },
        sag_heightOffset: { value: this.surfaceOffset },
        sag_cameraHigh: { value: this.cameraHigh },
        sag_cameraLow: { value: this.cameraLow },
        sag_originHigh: { value: originHigh },
        sag_originLow: { value: originLow },
        sag_east: { value: new THREE.Vector3(cosLongitude, 0, -sinLongitude) },
        sag_north: {
          value: new THREE.Vector3(
            -sinLatitude * sinLongitude,
            cosLatitude,
            -sinLatitude * cosLongitude
          )
        },
        sag_up: {
          value: new THREE.Vector3(
            cosLatitude * sinLongitude,
            sinLatitude,
            cosLatitude * cosLongitude
          )
        },
        sag_curvatureRadii: {
          value: new THREE.Vector2(primeVerticalRadius, meridionalRadius)
        },
        sag_useLocalCoordinates: { value: tile.level >= 18 },
        tileLongitudeSinCos: {
          value: new THREE.Vector2(sinLongitude, cosLongitude)
        },
        tileLongitudeSpan: { value: longitudeSpan },
        tileLatitudeSinCos: {
          value: new THREE.Vector2(sinLatitude, cosLatitude)
        },
        tileMercatorSinhCosh: {
          value: new THREE.Vector2(Math.sinh(mercatorCenter), Math.cosh(mercatorCenter))
        },
        tileMercatorSpan: { value: mercatorSpan },
        tileTexture: { value: null },
        coverageCount: { value: 0 },
        coverageTexture0: { value: null },
        coverageRect0: { value: new THREE.Vector4() },
        coverageUv0: { value: new THREE.Vector3() },
        coverageTexture1: { value: null },
        coverageRect1: { value: new THREE.Vector4() },
        coverageUv1: { value: new THREE.Vector3() },
        coverageTexture2: { value: null },
        coverageRect2: { value: new THREE.Vector4() },
        coverageUv2: { value: new THREE.Vector3() },
        coverageTexture3: { value: null },
        coverageRect3: { value: new THREE.Vector4() },
        coverageUv3: { value: new THREE.Vector3() },
        uvScale: { value: new THREE.Vector2(1, 1) },
        uvOffset: { value: new THREE.Vector2(0, 0) },
        hasTexture: { value: false },
        layerOpacity: { value: this.layerOpacity },
        isOverlay: { value: this.overlay },
        terrainTexture: { value: null },
        terrainParentTexture: { value: null },
        terrainUvScale: { value: new THREE.Vector2(1, 1) },
        terrainUvOffset: { value: new THREE.Vector2(0, 0) },
        terrainParentUvScale: { value: new THREE.Vector2(1, 1) },
        terrainParentUvOffset: { value: new THREE.Vector2(0, 0) },
        terrainTexelSize: { value: new THREE.Vector2(1, 1) },
        terrainMetersPerTexel: { value: new THREE.Vector2(1, 1) },
        hasTerrain: { value: false },
        hasTerrainParent: { value: false },
        terrainExaggeration: { value: this.terrain?.exaggeration ?? 1 },
        terrainSkirtDepth: { value: terrainSkirtDepth },
        placeholder: { value: placeholderColor(tile.level) }
      },
      vertexShader: /* glsl */ `
        varying vec2 v_tileUv;
        varying vec2 v_uv;
        varying vec3 v_globeNormal;
        varying vec3 v_terrainNormal;
        attribute float skirt;
        attribute vec3 terrainEdgeHigh;
        attribute vec3 terrainEdgeLow;
        attribute float terrainEdgeMask;
        uniform vec3 sag_originHigh;
        uniform vec3 sag_originLow;
        uniform vec3 sag_east;
        uniform vec3 sag_north;
        uniform vec3 sag_up;
        uniform vec2 sag_curvatureRadii;
        uniform bool sag_useLocalCoordinates;
        uniform vec2 tileLongitudeSinCos;
        uniform float tileLongitudeSpan;
        uniform vec2 tileLatitudeSinCos;
        uniform vec2 tileMercatorSinhCosh;
        uniform float tileMercatorSpan;
        uniform vec2 uvScale;
        uniform vec2 uvOffset;
        uniform sampler2D terrainTexture;
        uniform sampler2D terrainParentTexture;
        uniform vec2 terrainUvScale;
        uniform vec2 terrainUvOffset;
        uniform vec2 terrainParentUvScale;
        uniform vec2 terrainParentUvOffset;
        uniform vec2 terrainTexelSize;
        uniform bool hasTerrain;
        uniform bool hasTerrainParent;
        uniform float terrainExaggeration;
        uniform float terrainSkirtDepth;
        uniform vec2 terrainMetersPerTexel;
        uniform bool isOverlay;
        #include <common>
        #include <logdepthbuf_pars_vertex>
        ${globeCoordinateShader}
        void main() {
          float deltaLongitude = (position.x - 0.5) * tileLongitudeSpan;
          float sinDeltaLongitude = sin(deltaLongitude);
          float cosDeltaLongitude = cos(deltaLongitude);
          vec2 longitudeSinCos = vec2(
            tileLongitudeSinCos.x * cosDeltaLongitude +
              tileLongitudeSinCos.y * sinDeltaLongitude,
            tileLongitudeSinCos.y * cosDeltaLongitude -
              tileLongitudeSinCos.x * sinDeltaLongitude
          );
          float deltaMercator = (position.y - 0.5) * tileMercatorSpan;
          float sinhDeltaMercator = 0.5 * (exp(deltaMercator) - exp(-deltaMercator));
          float coshDeltaMercator = 0.5 * (exp(deltaMercator) + exp(-deltaMercator));
          float sinhMercator =
            tileMercatorSinhCosh.x * coshDeltaMercator +
            tileMercatorSinhCosh.y * sinhDeltaMercator;
          float cosLatitude = inversesqrt(1.0 + sinhMercator * sinhMercator);
          float sinLatitude = sinhMercator * cosLatitude;
          vec2 latitudeSinCos = vec2(sinLatitude, cosLatitude);
          // XYZ rows grow from north to south, while Three.js image textures
          // use v=1 at the visual top. Flip only V after applying the ancestor
          // sub-rectangle so exact tiles and fallback tiles share one convention.
          vec2 xyzUv = uvOffset + uv * uvScale;
          v_tileUv = uv;
          v_uv = vec2(xyzUv.x, 1.0 - xyzUv.y);
          vec2 terrainUv = terrainUvOffset + uv * terrainUvScale;
          // Height arrays contain endpoint samples (257 samples / 256 cells).
          // Convert logical [0,1] coordinates to texel centres before linear
          // filtering; raw normalized UVs introduce a sub-texel parent/child
          // offset and can reopen a geometrically stitched edge.
          vec2 terrainSampleUv = 0.5 * terrainTexelSize +
            terrainUv * (vec2(1.0) - terrainTexelSize);
          // Relief gradients belong to the mesh vertices, not every screen
          // fragment. Keep the authoritative displacement/edge samples intact.
          v_terrainNormal = vec3(0.0, 0.0, 1.0);
          if (hasTerrain && !isOverlay) {
            float westHeight = texture2D(terrainTexture, terrainSampleUv - vec2(terrainTexelSize.x, 0.0)).r;
            float eastHeight = texture2D(terrainTexture, terrainSampleUv + vec2(terrainTexelSize.x, 0.0)).r;
            float northHeight = texture2D(terrainTexture, terrainSampleUv - vec2(0.0, terrainTexelSize.y)).r;
            float southHeight = texture2D(terrainTexture, terrainSampleUv + vec2(0.0, terrainTexelSize.y)).r;
            float slopeEast = (eastHeight - westHeight) * terrainExaggeration /
              max(1.0, 2.0 * terrainMetersPerTexel.x);
            float slopeNorth = (northHeight - southHeight) * terrainExaggeration /
              max(1.0, 2.0 * terrainMetersPerTexel.y);
            v_terrainNormal = normalize(vec3(-slopeEast, -slopeNorth, 1.0));
          }
          float fineHeight = hasTerrain
            ? texture2D(terrainTexture, terrainSampleUv).r * terrainExaggeration
            : 0.0;
          // CPU terrain stitching gives adjacent tiles one shared geographic
          // edge. Do not replace that edge with this tile's unrelated parent.
          float heightMeters = fineHeight;
          if (hasTerrain) heightMeters -= skirt * terrainSkirtDepth;
          v_globeNormal = normalize(vec3(
            cosLatitude * longitudeSinCos.x,
            sinLatitude,
            cosLatitude * longitudeSinCos.y
          ));
          if (sag_useLocalCoordinates) {
            float deltaLatitude =
              tileLatitudeSinCos.y * deltaMercator -
              0.5 * tileLatitudeSinCos.x * tileLatitudeSinCos.y *
                deltaMercator * deltaMercator;
            float latitudeMidpoint = 0.5 * deltaLatitude;
            float midpointCosLatitude =
              tileLatitudeSinCos.y * cos(latitudeMidpoint) -
              tileLatitudeSinCos.x * sin(latitudeMidpoint);
            float eastMeters =
              sag_curvatureRadii.x * midpointCosLatitude * deltaLongitude;
            float northMeters = sag_curvatureRadii.y * deltaLatitude;
            float upMeters = -0.5 * (
              eastMeters * eastMeters / sag_curvatureRadii.x +
              northMeters * northMeters / sag_curvatureRadii.y
            );
            vec3 localWorld =
              sag_east * eastMeters +
              sag_north * northMeters +
              sag_up * (upMeters + heightMeters);
            gl_Position = sag_projectLocalToEye(
              localWorld,
              sag_originHigh,
              sag_originLow
            );
          } else {
            gl_Position = sag_projectGeodeticTrig(
              longitudeSinCos,
              latitudeSinCos,
              heightMeters
            );
          }
          if (terrainEdgeMask > 0.5) {
            gl_Position = sag_projectLocalToEye(vec3(0.0), terrainEdgeHigh, terrainEdgeLow);
          }
          #include <logdepthbuf_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 v_tileUv;
        uniform int coverageCount;
        uniform sampler2D coverageTexture0;
        uniform vec4 coverageRect0;
        uniform vec3 coverageUv0;
        uniform sampler2D coverageTexture1;
        uniform vec4 coverageRect1;
        uniform vec3 coverageUv1;
        uniform sampler2D coverageTexture2;
        uniform vec4 coverageRect2;
        uniform vec3 coverageUv2;
        uniform sampler2D coverageTexture3;
        uniform vec4 coverageRect3;
        uniform vec3 coverageUv3;
        varying vec2 v_uv;
        varying vec3 v_globeNormal;
        varying vec3 v_terrainNormal;
        uniform sampler2D tileTexture;
        uniform bool hasTexture;
        uniform float layerOpacity;
        uniform bool isOverlay;
        uniform bool hasTerrain;
        uniform vec3 placeholder;
        #include <logdepthbuf_pars_fragment>
        bool insideCoverage(vec2 uv, vec4 rect) {
          return all(greaterThanEqual(uv, rect.xy)) && all(lessThanEqual(uv, rect.xy + rect.zw));
        }
        void main() {
          vec4 texel = hasTexture
            ? texture2D(tileTexture, v_uv)
            : vec4(placeholder, isOverlay ? 0.0 : 1.0);
          if (coverageCount > 0 && insideCoverage(v_tileUv, coverageRect0)) {
            vec2 q = v_tileUv * coverageUv0.x + coverageUv0.yz;
            texel = texture2D(coverageTexture0, vec2(q.x, 1.0 - q.y));
          }
          if (coverageCount > 1 && insideCoverage(v_tileUv, coverageRect1)) {
            vec2 q = v_tileUv * coverageUv1.x + coverageUv1.yz;
            texel = texture2D(coverageTexture1, vec2(q.x, 1.0 - q.y));
          }
          if (coverageCount > 2 && insideCoverage(v_tileUv, coverageRect2)) {
            vec2 q = v_tileUv * coverageUv2.x + coverageUv2.yz;
            texel = texture2D(coverageTexture2, vec2(q.x, 1.0 - q.y));
          }
          if (coverageCount > 3 && insideCoverage(v_tileUv, coverageRect3)) {
            vec2 q = v_tileUv * coverageUv3.x + coverageUv3.yz;
            texel = texture2D(coverageTexture3, vec2(q.x, 1.0 - q.y));
          }
          if (texel.a * layerOpacity < 0.002) discard;
          vec3 color = texel.rgb;
          float daylight = 0.86 + 0.14 * max(
            dot(normalize(v_globeNormal), normalize(vec3(-0.35, 0.55, 1.0))),
            0.0
          );
          if (hasTerrain && !isOverlay) {
            vec3 terrainNormal = normalize(v_terrainNormal);
            float relief = 0.78 + 0.30 * max(
              dot(terrainNormal, normalize(vec3(-0.45, 0.55, 0.78))),
              0.0
            );
            daylight *= relief;
          }
          if (!isOverlay) {
            color = min(color * 1.24 * daylight + vec3(0.025, 0.04, 0.055), vec3(1.0));
          }
          float outputAlpha = texel.a * layerOpacity;
          // Overlay textures are uploaded with premultiplied alpha. Preserve
          // that invariant when the whole layer opacity is reduced.
          vec3 outputColor = isOverlay ? color * layerOpacity : color;
          gl_FragColor = vec4(outputColor, outputAlpha);
          #include <logdepthbuf_fragment>
          #include <colorspace_fragment>
        }
      `,
      transparent: this.overlay || this.layerOpacity < 1,
      depthWrite: !this.overlay,
      depthTest: true,
      depthFunc: THREE.LessEqualDepth,
      premultipliedAlpha: this.overlay,
      toneMapped: false
    });
  }

  private queueVisibleTextures(selection: readonly SelectedTile[]): void {
    this.visibleTextureKeys.clear();
    this.desiredTextureKeys.clear();
    this.desiredMinimumLevel = null;
    this.desiredMaximumLevel = null;
    for (const record of this.textures.values()) {
      if (record.state === 'queued' || record.state === 'error') {
        record.priority = Number.POSITIVE_INFINITY;
        record.requestClass = undefined;
      }
    }
    const prioritized = [...selection].sort(
      (a, b) => tileRequestUrgency(b) - tileRequestUrgency(a) ||
        a.viewCenterDistance - b.viewCenterDistance || b.id.level - a.id.level
    );
    for (let rank = 0; rank < prioritized.length; rank += 1) {
      const tile = prioritized[rank];
      if (!tile) continue;
      const levelOffset = Math.min(0, Math.round(this.provider.levelOffset ?? 0));
      const maximumSourceLevel = Math.min(
        this.provider.maximumSourceLevel?.(tile.id.level) ??
          tile.id.level + levelOffset,
        this.provider.maxLevel,
        tile.id.level
      );
      if (maximumSourceLevel < this.provider.minLevel) continue;
      this.desiredMinimumLevel = this.desiredMinimumLevel === null
        ? maximumSourceLevel
        : Math.min(this.desiredMinimumLevel, maximumSourceLevel);
      this.desiredMaximumLevel = this.desiredMaximumLevel === null
        ? maximumSourceLevel
        : Math.max(this.desiredMaximumLevel, maximumSourceLevel);

      const desired = ancestorAtLevel(tile.id, maximumSourceLevel);
      if (this.provider.hasTile && !this.provider.hasTile(desired)) continue;
      this.visibleTextureKeys.add(tileKey(desired));
      this.desiredTextureKeys.add(tileKey(desired));
      const detailPriority = prioritized.length + rank;
      const ready = this.findReadyAncestor(tile.id);
      if (ready) {
        this.visibleTextureKeys.add(ready.key);
      } else {
        const bridgeLevel = Math.max(this.provider.minLevel, maximumSourceLevel - 3);
        const bridge = ancestorAtLevel(tile.id, bridgeLevel);
        if (this.provider.hasTile && !this.provider.hasTile(bridge)) continue;
        this.visibleTextureKeys.add(tileKey(bridge));
        // Missing coverage is more urgent than sharpening an already covered
        // tile. Deduplication makes these coarse bridge requests inexpensive.
        this.queueTexture(bridge, rank, 'coverage');
      }
      this.queueTexture(desired, detailPriority);
    }
    for (const [key, record] of this.textures) {
      if (this.visibleTextureKeys.has(key) || record.state === 'ready') continue;
      this.cancelTileRecord(record);
      this.textures.delete(key);
    }
  }

  private queueTexture(id: TileId, priority: number, requestClass: 'coverage' | 'detail' = 'detail'): void {
    const key = tileKey(id);
    const existing = this.textures.get(key);
    if (existing) {
      existing.lastUsedFrame = this.frame;
      if (requestClass === 'coverage' || !existing.requestClass) existing.requestClass = requestClass;
      if (existing.state === 'queued' || existing.state === 'error') existing.priority = Math.min(existing.priority, priority);
      return;
    }
    this.textures.set(key, {
      id,
      key,
      state: 'queued',
      priority,
      requestClass,
      lastUsedFrame: this.frame,
      texture: null,
      byteSize: 0,
      attempts: 0,
      retryAt: 0,
      controller: null,
      active: false
    });
    const contentKey = this.contentKey(id);
    this.tileStateMachine.ensure(contentKey, { priority, lastAccessFrame: this.frame });
    this.tileStateMachine.transition(contentKey, 'queued', {
      priority,
      lastAccessFrame: this.frame
    });
  }

  private pumpQueue(): void {
    if (this.suspended || this.disposed) return;
    if (this.activeRequests >= this.maxConcurrentRequests) return;
    const estimatedBytes = this.provider.estimatedTextureBytes ?? estimateSquareTextureBytes(256);
    // A target texture must coexist briefly with its currently displayed
    // ancestor. Without this transition allowance a full cache protects the
    // ancestor forever and the view can remain stuck several levels too low.
    const transitionBytes = this.maxConcurrentRequests * estimatedBytes;
    // Reclaim stale cached content before admission, rather than waiting for
    // a later material update. Never evict displayed coverage or live targets.
    const now = performance.now();
    let waiting = 0;
    for (const record of this.textures.values()) {
      if (record.retryAt <= now && (record.state === 'queued' ||
          record.state === 'error' && this.visibleTextureKeys.has(record.key))) waiting++;
    }
    if (!waiting) return;
    const admitted = Math.min(waiting, this.maxConcurrentRequests - this.activeRequests);
    this.evictTextures((this.activeRequests + admitted) * estimatedBytes);
    while (this.activeRequests < this.maxConcurrentRequests) {
      if (
        this.residentTextureBytes() +
        (this.activeRequests + 1) * estimatedBytes >
          this.maxTextureBytes + transitionBytes
      ) return;
      let next: TextureRecord | undefined;
      let coverage: TextureRecord | undefined;
      let detail: TextureRecord | undefined;
      const now = performance.now();
      for (const record of this.textures.values()) {
        if (
          record.state === 'error' &&
          this.visibleTextureKeys.has(record.key) &&
          record.retryAt <= now
        ) {
          record.state = 'queued';
          this.tileStateMachine.transition(this.contentKey(record.id), 'queued', {
            priority: record.priority,
            lastAccessFrame: this.frame
          });
        }
        if (record.state !== 'queued' || record.retryAt > now) continue;
        if (record.requestClass === 'coverage') {
          if (!coverage || record.priority < coverage.priority) coverage = record;
        } else if (!detail || record.priority < detail.priority) detail = record;
      }
      // At most two bridge starts ahead of a waiting detail request. Class-local
      // urgency still favours the near foreground; neither class can starve.
      next = coverage && (this.coverageRun < 2 || !detail) ? coverage : detail ?? coverage;
      if (!next) return;
      this.coverageRun = next.requestClass === 'coverage' ? Math.min(2, this.coverageRun + 1) : 0;
      this.load(next);
    }
  }

  private load(record: TextureRecord): void {
    record.state = 'loading';
    this.tileStateMachine.transition(this.contentKey(record.id), 'loading', {
      priority: record.priority,
      lastAccessFrame: this.frame
    });
    record.controller = new AbortController();
    record.active = true;
    this.activeRequests += 1;
    const provider = this.provider;
    if (provider.loadTexture) {
      void provider.loadTexture(record.id, record.controller.signal).then(
        (texture) => this.completeTextureLoad(record, provider, texture),
        (error: unknown) => this.failTextureLoad(record, provider, error)
      );
      return;
    }
    void loadTextureWithFetch(provider.url(record.id), record.controller.signal).then(
      (texture) => this.completeTextureLoad(record, provider, texture),
      (error: unknown) => this.failTextureLoad(record, provider, error)
    );
  }

  private completeTextureLoad(
    record: TextureRecord,
    provider: RasterTileProvider,
    texture: THREE.Texture
  ): void {
    this.releaseActiveRequest(record);
    if (
      this.disposed ||
      this.provider !== provider ||
      this.textures.get(record.key) !== record
    ) {
      this.releaseTexture(texture);
      this.pumpQueue();
      return;
    }
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    // Transparent surface overlays are already sampled at screen-selected
    // source levels. Mipmaps average transparent-black PNG texels with dark
    // vector outlines and produce wide halos at coverage/tile boundaries.
    texture.generateMipmaps = !this.overlay;
    texture.premultiplyAlpha = this.overlay;
    texture.minFilter = this.overlay ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = this.maxAnisotropy;
    record.texture = texture;
    record.controller = null;
    record.byteSize = estimateTextureBytes(texture, this.provider.estimatedTextureBytes);
    record.state = 'ready';
    record.attempts = 0;
    record.retryAt = 0;
    record.lastUsedFrame = this.frame;
    this.tileStateMachine.transition(this.contentKey(record.id), 'ready', {
      byteSize: record.byteSize,
      lastAccessFrame: this.frame
    });
    this.materialsDirty = true;
    this.pumpQueue();
  }

  private failTextureLoad(
    record: TextureRecord,
    provider: RasterTileProvider,
    error?: unknown
  ): void {
    this.releaseActiveRequest(record);
    if (
      !this.disposed &&
      this.provider === provider &&
      this.textures.get(record.key) === record
    ) {
      record.state = 'error';
      record.controller = null;
      record.attempts += 1;
      record.retryAt = performance.now() + Math.min(30_000, 1_000 * 2 ** (record.attempts - 1));
      this.lastError = sanitizeError(error);
      this.tileStateMachine.transition(this.contentKey(record.id), 'failed', {
        error: this.lastError,
        lastAccessFrame: this.frame
      });
      if (this.warnedProviderId !== provider.id) {
        this.warnedProviderId = provider.id;
        console.warn(`[影像图层 ${provider.id}] ${this.lastError}`);
      }
    }
    this.pumpQueue();
  }

  private syncMaterials(selection: readonly SelectedTile[]): void {
    this.fallbackCount = 0;
    this.displayedMinimumLevel = null;
    this.displayedMaximumLevel = null;
    for (const tile of selection) {
      const renderTile = this.renderTiles.get(tileKey(tile.id));
      if (!renderTile) continue;
      const desired = ancestorAtLevel(tile.id, this.maximumSourceLevel(tile.id));
      const hasCoverage = this.provider.hasTile?.(desired) !== false;
      // Explicitly uncovered WMTS children must stay transparent. Stretching
      // a ready parent into them filters the parent's dark boundary into the
      // transparent area and creates a persistent rectangular smear.
      const source = hasCoverage ? this.findReadyAncestor(tile.id) : undefined;
      const sourceKey = source?.key ?? '';
      // The configured view offset/overzoom is intentional, not a cache miss.
      // Count only a texture below this leaf's actual requested source zoom.
      if (source && source.id.level < desired.level) this.fallbackCount += 1;
      if (source) {
        this.displayedMinimumLevel = this.displayedMinimumLevel === null
          ? source.id.level
          : Math.min(this.displayedMinimumLevel, source.id.level);
        this.displayedMaximumLevel = this.displayedMaximumLevel === null
          ? source.id.level
          : Math.max(this.displayedMaximumLevel, source.id.level);
      }
      const uniforms = renderTile.mesh.material.uniforms;
      if (!uniforms) continue;
      const currentTexture = uniforms.tileTexture!.value;
      const keepsPreviousProvider = currentTexture instanceof THREE.Texture &&
        this.transitionTextures.has(currentTexture) &&
        source !== undefined && source.id.level < this.maximumSourceLevel(tile.id);
      if (sourceKey !== renderTile.textureKey && !keepsPreviousProvider) {
        renderTile.textureKey = sourceKey;
        uniforms.tileTexture!.value = source?.texture ?? null;
        uniforms.hasTexture!.value = source !== undefined;
        const levels = source ? tile.id.level - source.id.level : 0;
        const scale = 1 / 2 ** levels;
        const localX = source ? tile.id.x - source.id.x * 2 ** levels : 0;
        const localY = source ? tile.id.y - source.id.y * 2 ** levels : 0;
        (uniforms.uvScale!.value as THREE.Vector2).set(scale, scale);
        (uniforms.uvOffset!.value as THREE.Vector2).set(localX * scale, localY * scale);
      }
      const terrain = this.terrain?.resolveTexture(tile.id);
      this.bindContinuity(renderTile);
      // A missing regional root is unavailable coverage, not a zero-height DEM.
      renderTile.mesh.visible = this.terrain?.hasSurfaceCoverage?.(tile.id) !== false;
      // Coordinate keys are not resource identities: eviction/reload can
      // replace the DEM (or parent) at the same z/x/y. CPU edges already use
      // the new immutable source; keep GPU interiors on that same source.
      const terrainKey = terrain
        ? `${terrain.key}|${terrain.texture.uuid}|${terrain.parentKey}|${terrain.parentTexture?.uuid ?? ''}` : '';
      if (terrainKey === renderTile.terrainKey) continue;
      renderTile.terrainKey = terrainKey;
      uniforms.terrainTexture!.value = terrain?.texture ?? null;
      uniforms.terrainParentTexture!.value = terrain?.parentTexture ?? null;
      uniforms.hasTerrain!.value = terrain !== undefined;
      uniforms.hasTerrainParent!.value = terrain?.parentTexture !== null &&
        terrain?.parentTexture !== undefined;
      (uniforms.terrainUvScale!.value as THREE.Vector2).setScalar(terrain?.scale ?? 1);
      (uniforms.terrainUvOffset!.value as THREE.Vector2).set(
        terrain?.offsetX ?? 0,
        terrain?.offsetY ?? 0
      );
      (uniforms.terrainParentUvScale!.value as THREE.Vector2).setScalar(
        terrain?.parentScale ?? 1
      );
      (uniforms.terrainParentUvOffset!.value as THREE.Vector2).set(
        terrain?.parentOffsetX ?? 0,
        terrain?.parentOffsetY ?? 0
      );
      (uniforms.terrainTexelSize!.value as THREE.Vector2).set(
        1 / (terrain?.width ?? 1),
        1 / (terrain?.height ?? 1)
      );
      const sourceLevel = terrain?.sourceLevel ?? tile.id.level;
      const sourceSize = 2 ** sourceLevel;
      const mercatorCenter = Math.PI - ((tile.id.y + 0.5) / 2 ** tile.id.level) * Math.PI * 2;
      const cosLatitude = 1 / Math.cosh(mercatorCenter);
      const circumference = Math.PI * 2 * this.ellipsoid.equatorialRadius;
      (uniforms.terrainMetersPerTexel!.value as THREE.Vector2).set(
        (circumference * cosLatitude) / (sourceSize * (terrain?.width ?? 1)),
        (circumference * cosLatitude) / (sourceSize * (terrain?.height ?? 1))
      );
    }
    this.releaseTransitionTextures(false);
    this.syncTerrainEdges(selection);
  }

  private syncTerrainEdges(selection: readonly SelectedTile[]): void {
    const revision = this.terrain?.revision ?? -1;
    if (this.edgeSelection === selection && this.edgeRevision === revision) return;
    this.edgeSelection = selection;
    // A camera movement changes request priorities, not necessarily topology.
    // Compare tile IDs before resampling/uploading every boundary attribute.
    const tiles = selection.map(({ id }) => {
      const snapshot = this.terrain?.tileHeightSampler?.(id);
      return { id, segments: this.segmentsForLevel(id.level),
        heightKey: snapshot?.key ?? (this.terrain?.enabled ? String(revision) : 'flat'),
        height: snapshot?.sample ?? ((u: number, v: number) => this.terrain?.sampleTileHeight?.(id, u, v) ?? 0) };
    });
    const signature = tiles.map((tile) => `${tileKey(tile.id)}:${tile.heightKey}`).join('|');
    this.edgeRevision = revision;
    if (signature === this.edgeTileSignature) return;
    this.edgeTileSignature = signature;
    // The reference ellipsoid also needs shared coarse/fine ECEF chords.
    // Disabling DEM must not disable topology/precision reconciliation.
    const boundaries = terrainSurfaceEdges(tiles, this.surfaceOffset, this.retainedEdgePoints);
    for (const tile of tiles) {
      const renderTile = this.renderTiles.get(tileKey(tile.id));
      if (!renderTile) continue;
      const geometry = renderTile.mesh.geometry;
      const mask = geometry.getAttribute('terrainEdgeMask') as THREE.BufferAttribute;
      const high = geometry.getAttribute('terrainEdgeHigh') as THREE.BufferAttribute;
      const low = geometry.getAttribute('terrainEdgeLow') as THREE.BufferAttribute;
      let changed = false;
      const boundary = boundaries?.get(tile);
      if (boundary) {
        const uv = geometry.getAttribute('uv');
        const write = (index: number, point: THREE.Vector3) => {
          const x = Math.fround(point.x), y = Math.fround(point.y), z = Math.fround(point.z);
          const lx = Math.fround(point.x - x), ly = Math.fround(point.y - y), lz = Math.fround(point.z - z);
          if (mask.getX(index) === 1 && high.getX(index) === x && high.getY(index) === y && high.getZ(index) === z &&
              low.getX(index) === lx && low.getY(index) === ly && low.getZ(index) === lz) return;
          changed = true;
          high.setXYZ(index, x, y, z); low.setXYZ(index, lx, ly, lz);
          mask.setX(index, 1);
        };
        // Interior vertices cannot have an edge override. Visit the perimeter
        // map and duplicated skirt only, not the entire n*n surface grid.
        for (const [vertex, point] of boundary) write(vertex, point);
        for (let index = (tile.segments + 1) ** 2; index < uv.count; index++) {
          const vertex = Math.round(uv.getY(index) * tile.segments) * (tile.segments + 1) +
            Math.round(uv.getX(index) * tile.segments);
          const point = boundary.get(vertex);
          if (point) write(index, point);
        }
      }
      if (changed) { mask.needsUpdate = true; high.needsUpdate = true; low.needsUpdate = true; }
    }
  }

  private findReadyAncestor(id: TileId): TextureRecord | undefined {
    const levelOffset = Math.min(0, Math.round(this.provider.levelOffset ?? 0));
    const maximumSourceLevel = Math.min(
      this.provider.maximumSourceLevel?.(id.level) ?? id.level + levelOffset,
      this.provider.maxLevel,
      id.level
    );
    for (
      let level = maximumSourceLevel;
      level >= this.provider.minLevel;
      level -= 1
    ) {
      const shift = id.level - level;
      const record = this.textures.get(tileKey({
        level,
        x: Math.floor(id.x / 2 ** shift),
        y: Math.floor(id.y / 2 ** shift)
      }));
      if (record?.state === 'ready' && record.texture) {
        record.lastUsedFrame = this.frame;
        return record;
      }
    }
    return undefined;
  }

  private evictTextures(reserveBytes = 0): void {
    if (this.suspended) return;
    const residentBytes = this.residentTextureBytes();
    const byteLimit = Math.max(0, this.maxTextureBytes - reserveBytes);
    if (this.textures.size <= this.maxCachedTiles && residentBytes <= byteLimit) return;
    const protectedKeys = new Set(
      [...this.renderTiles.values()].map((tile) => tile.textureKey).filter(Boolean)
    );
    for (const patch of this.continuity.values()) protectedKeys.add(patch.sourceKey);
    const candidates = [...this.textures.values()]
      // Pending visible targets must not be evicted: without another selection
      // event they would never be queued again, leaving a permanent ancestor.
      .filter((record) => record.state === 'ready' && !protectedKeys.has(record.key) &&
        !this.desiredTextureKeys.has(record.key))
      .sort((a, b) => a.lastUsedFrame - b.lastUsedFrame);
    let remainingBytes = residentBytes;
    while (
      this.textures.size > this.maxCachedTiles ||
      remainingBytes > byteLimit
    ) {
      const record = candidates.shift();
      if (!record) break;
      this.releaseTexture(record.texture);
      remainingBytes -= record.byteSize;
      const contentKey = this.contentKey(record.id);
      const state = this.tileStateMachine.get(contentKey)?.state;
      if (state === 'ready') this.tileStateMachine.transition(contentKey, 'expired');
      this.tileStateMachine.remove(contentKey);
      this.textures.delete(record.key);
    }
  }

  private residentTextureBytes(): number {
    let bytes = 0;
    for (const record of this.textures.values()) {
      if (record.state === 'ready') bytes += record.byteSize;
    }
    return bytes;
  }

  private releaseTexture(texture: THREE.Texture | null): void {
    if (!texture || this.suspended) return;
    const image = texture.image as { close?: () => void } | undefined;
    image?.close?.();
    texture.dispose();
  }

  private contentKey(id: TileId): TileContentKey {
    return {
      sourceId: this.provider.id,
      kind: this.contentKind,
      level: id.level,
      x: id.x,
      y: id.y
    };
  }

  private cancelTileRecord(record: TextureRecord): void {
    record.controller?.abort();
    record.controller = null;
    this.releaseActiveRequest(record);
    const key = this.contentKey(record.id);
    const state = this.tileStateMachine.get(key)?.state;
    if (state && state !== 'cancelled') {
      if (state === 'ready') this.tileStateMachine.transition(key, 'expired');
      else this.tileStateMachine.transition(key, 'cancelled');
    }
    this.tileStateMachine.remove(key);
  }

  private releaseActiveRequest(record: TextureRecord): void {
    if (!record.active) return;
    record.active = false;
    this.activeRequests = Math.max(0, this.activeRequests - 1);
  }

  private maximumSourceLevel(id: TileId): number {
    const levelOffset = Math.min(0, Math.round(this.provider.levelOffset ?? 0));
    return Math.min(
      this.provider.maximumSourceLevel?.(id.level) ?? id.level + levelOffset,
      this.provider.maxLevel,
      id.level
    );
  }

  private releaseTransitionTextures(force: boolean): void {
    if (this.transitionTextures.size === 0) return;
    const referenced = force ? new Set<THREE.Texture>() : new Set(
      [...this.renderTiles.values()]
        .map((tile) => tile.mesh.material.uniforms.tileTexture?.value)
        .filter((texture): texture is THREE.Texture => texture instanceof THREE.Texture)
    );
    for (const texture of this.transitionTextures) {
      if (referenced.has(texture)) continue;
      this.releaseTexture(texture);
      this.transitionTextures.delete(texture);
    }
  }
}

async function loadTextureWithFetch(url: string, signal: AbortSignal): Promise<THREE.Texture> {
  const response = await fetch(url, { signal, mode: 'cors' });
  if (!response.ok) throw new Error(`纹理请求失败 (${response.status}): ${url}`);
  // Keep the same upload orientation as THREE.TextureLoader. ImageBitmap has
  // different flipY semantics in WebGL (UNPACK_FLIP_Y_WEBGL is ignored by
  // browsers for ImageBitmap), which inverted every tile internally and
  // produced north/south striping at tile boundaries.
  const image = await loadHtmlImage(await response.blob(), signal);
  const texture = new THREE.Texture(image);
  texture.flipY = true;
  texture.needsUpdate = true;
  return texture;
}

function loadHtmlImage(blob: Blob, signal: AbortSignal): Promise<HTMLImageElement> {
  if (signal.aborted) return Promise.reject(createAbortError());
  const objectUrl = URL.createObjectURL(blob);
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    let settled = false;
    const cleanup = (): void => {
      image.onload = null;
      image.onerror = null;
      signal.removeEventListener('abort', onAbort);
      URL.revokeObjectURL(objectUrl);
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      image.src = '';
      cleanup();
      reject(createAbortError());
    };
    image.onload = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(image);
    };
    image.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('纹理解码失败。'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    image.src = objectUrl;
  });
}

function createAbortError(): DOMException {
  return new DOMException('Texture request aborted', 'AbortError');
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '纹理请求失败');
  return message.replace(/([?&](?:key|token|access_token)=)[^&\s]+/gi, '$1***');
}

function ancestorAtLevel(id: TileId, level: number): TileId {
  const shift = Math.max(0, id.level - level);
  return {
    level,
    x: Math.floor(id.x / 2 ** shift),
    y: Math.floor(id.y / 2 ** shift)
  };
}

function createGridGeometry(segmentsInput: number): THREE.BufferGeometry {
  const segments = Math.max(2, Math.round(segmentsInput));
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const skirts: number[] = [];
  for (let y = 0; y <= segments; y += 1) {
    for (let x = 0; x <= segments; x += 1) {
      positions.push(x / segments, y / segments, 0);
      uvs.push(x / segments, y / segments);
      skirts.push(0);
    }
  }
  const columns = segments + 1;
  for (let y = 0; y < segments; y += 1) {
    for (let x = 0; x < segments; x += 1) {
      const a = y * columns + x;
      const b = a + 1;
      const c = a + columns;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const perimeter: number[] = [];
  for (let x = 0; x <= segments; x += 1) perimeter.push(x);
  for (let y = 1; y <= segments; y += 1) perimeter.push(y * columns + segments);
  for (let x = segments - 1; x >= 0; x -= 1) perimeter.push(segments * columns + x);
  for (let y = segments - 1; y >= 1; y -= 1) perimeter.push(y * columns);
  const skirtStart = positions.length / 3;
  for (const surfaceIndex of perimeter) {
    positions.push(
      positions[surfaceIndex * 3] ?? 0,
      positions[surfaceIndex * 3 + 1] ?? 0,
      0
    );
    uvs.push(uvs[surfaceIndex * 2] ?? 0, uvs[surfaceIndex * 2 + 1] ?? 0);
    skirts.push(1);
  }
  for (let index = 0; index < perimeter.length; index += 1) {
    const next = (index + 1) % perimeter.length;
    const surface = perimeter[index]!;
    const nextSurface = perimeter[next]!;
    const lower = skirtStart + index;
    const nextLower = skirtStart + next;
    indices.push(surface, lower, nextSurface, nextSurface, lower, nextLower);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('skirt', new THREE.Float32BufferAttribute(skirts, 1));
  geometry.setIndex(indices);
  return geometry;
}

function placeholderColor(level: number): THREE.Color {
  return new THREE.Color().setHSL(0.53, 0.56, Math.min(0.3, 0.19 + level * 0.009));
}

function estimateSquareTextureBytes(size: number): number {
  return Math.ceil(size * size * 4 * 4 / 3);
}

function estimateTextureBytes(texture: THREE.Texture, fallback?: number): number {
  const image = texture.image as {
    width?: number;
    height?: number;
    naturalWidth?: number;
    naturalHeight?: number;
  } | undefined;
  const width = image?.naturalWidth ?? image?.width ?? 0;
  const height = image?.naturalHeight ?? image?.height ?? 0;
  if (width > 0 && height > 0) return Math.ceil(width * height * 4 * 4 / 3);
  return fallback ?? estimateSquareTextureBytes(256);
}

function splitVector3(value: THREE.Vector3, high: THREE.Vector3, low: THREE.Vector3): void {
  high.set(Math.fround(value.x), Math.fround(value.y), Math.fround(value.z));
  low.set(value.x - high.x, value.y - high.y, value.z - high.z);
}
