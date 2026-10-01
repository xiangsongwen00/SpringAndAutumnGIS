import * as THREE from 'three';
import { WEB_MERCATOR_MAX_LATITUDE } from '../core/coordinates/CoordinateTransform';
import { Ellipsoid } from '../core/geo/Ellipsoid';
import { tileRequestUrgency, type SelectedTile } from '../core/lod/GlobeLodSelector';
import type { SurfaceDisplacementBoundsSource } from '../core/lod/GlobeLodSelector';
import type { SurfaceDisplacementRange } from '../core/lod/GlobeLodSelector';
import {
  sampleTerrainTile,
  type TerrainProvider,
  type TerrainTileData
} from '../core/terrain/TerrainProvider';
import { tileKey, type TileId } from '../core/tiling/GeographicTilingScheme';
import { globeCoordinateShader } from './shaders/coordinates';
import type { FrameWorkBudget } from '../core/tiles/FrameWorkBudget';
import {
  stitchTerrainNeighborhood,
  type StitchableTerrainTile
} from '../core/terrain/TerrainEdgeStitcher';

export type TerrainTileLayerOptions = {
  segments?: number;
  maxConcurrentRequests?: number;
  maxCachedTiles?: number;
  /** Combined CPU heightfield and GPU texture budget. Defaults to 96 MiB. */
  maxResourceBytes?: number;
  exaggeration?: number;
  /** Draw a standalone coloured terrain mesh for diagnostics. */
  showDebugSurface?: boolean;
  /** Bounded DEM publication/upload per update. Defaults: 2 tiles, 2ms, 1MiB. */
  maxCommitsPerFrame?: number;
  commitBudgetMs?: number;
  maxUploadBytesPerFrame?: number;
  /** Engine supplies renderer.initTexture so uploads happen inside the budget. */
  prepareTexture?: (texture: THREE.DataTexture) => void;
  workBudget?: FrameWorkBudget;
};

export type TerrainTileLayerStats = Readonly<{
  ready: number;
  loading: number;
  queued: number;
  errors: number;
  fallbacks: number;
  resourceBytes: number;
  stitchedEdges: number;
  coverageReady: boolean;
  stitchLastMs: number;
  stitchMaxMs: number;
  pending: number;
  committed: number;
  commitMs: number;
}>;

export type TerrainTextureBinding = Readonly<{
  key: string;
  texture: THREE.Texture;
  scale: number;
  offsetX: number;
  offsetY: number;
  sourceLevel: number;
  width: number;
  height: number;
  parentKey: string;
  parentTexture: THREE.Texture | null;
  parentScale: number;
  parentOffsetX: number;
  parentOffsetY: number;
}>;

export interface TerrainHeightSource extends SurfaceDisplacementBoundsSource {
  readonly revision: number;
  readonly exaggeration: number;
  readonly enabled: boolean;
  resolveTexture(id: TileId): TerrainTextureBinding | undefined;
  sampleHeight(longitude: number, latitude: number): number | null;
  /** CPU equivalent of resolveTexture + shader UV sampling, including exaggeration. */
  sampleTileHeight?(id: TileId, u: number, v: number): number | null;
  /** Resolve an immutable ancestor once for all boundary samples. */
  tileHeightSampler?(id: TileId): { key: string; sample: (u: number, v: number) => number };
  /** Token of the actual height source used by sampleHeight at an anchor. */
  heightVersionAt?(longitude: number, latitude: number): string;
}

type TerrainState = 'queued' | 'loading' | 'pending' | 'ready' | 'error';
type TerrainRecord = {
  id: TileId;
  key: string;
  state: TerrainState;
  priority: number;
  lastUsedFrame: number;
  data: TerrainTileData | null;
  controller: AbortController | null;
  active: boolean;
};
type RenderTile = {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  terrainKey: string;
};

/** Read-only terrain surface with CPU heightfields and GPU vertex displacement. */
export class TerrainTileLayer implements TerrainHeightSource {
  readonly object3d = new THREE.Group();
  readonly provider: TerrainProvider;
  readonly exaggeration: number;

  private readonly ellipsoid: Ellipsoid;
  private readonly baseSegments: number;
  private readonly maxConcurrentRequests: number;
  private readonly maxCachedTiles: number;
  private readonly maxResourceBytes: number;
  private readonly showDebugSurface: boolean;
  private readonly geometries = new Map<number, THREE.BufferGeometry>();
  private readonly records = new Map<string, TerrainRecord>();
  private readonly renderTiles = new Map<string, RenderTile>();
  private readonly visibleKeys = new Set<string>();
  private readonly cameraHigh = new THREE.Vector3();
  private readonly cameraLow = new THREE.Vector3();
  private frame = 0;
  private activeRequests = 0;
  private fallbackCount = 0;
  private disposed = false;
  private suspended = false;
  private _enabled = true;
  private _revision = 0;
  // Small immutable metadata outlives texture LRU, so culling does not oscillate
  // between measured bounds and the unknown 12km envelope after eviction.
  private readonly knownHeightRanges = new Map<string, SurfaceDisplacementRange>();
  private lastSelection: readonly SelectedTile[] | null = null;
  private materialsDirty = true;
  private stitchedEdges = 0;
  private stitchLastMs = 0;
  private stitchMaxMs = 0;
  private coverageReady = false;
  private hasInitialCoverage = false;
  private readonly maxCommitsPerFrame: number;
  private readonly commitBudgetMs: number;
  private readonly maxUploadBytesPerFrame: number;
  private readonly prepareTexture?: (texture: THREE.DataTexture) => void;
  private committed = 0;
  private commitMs = 0;
  private readonly workBudget?: FrameWorkBudget;

  constructor(
    ellipsoid: Ellipsoid,
    provider: TerrainProvider,
    options: TerrainTileLayerOptions = {}
  ) {
    this.ellipsoid = ellipsoid;
    this.provider = provider;
    this.baseSegments = Math.max(16, Math.round(options.segments ?? 64));
    this.maxConcurrentRequests = Math.max(1, Math.round(options.maxConcurrentRequests ?? 6));
    this.maxCachedTiles = Math.max(32, Math.round(options.maxCachedTiles ?? 384));
    this.maxResourceBytes = Math.max(
      16 * 1024 * 1024,
      Math.round(options.maxResourceBytes ?? 96 * 1024 * 1024)
    );
    this.exaggeration = Math.max(0, options.exaggeration ?? 1);
    this.showDebugSurface = options.showDebugSurface ?? false;
    this.maxCommitsPerFrame = Math.max(1, Math.round(options.maxCommitsPerFrame ?? 2));
    this.commitBudgetMs = Math.max(.1, options.commitBudgetMs ?? 2);
    this.maxUploadBytesPerFrame = Math.max(4, options.maxUploadBytesPerFrame ?? 1024 * 1024);
    this.prepareTexture = options.prepareTexture;
    this.workBudget = options.workBudget;
    this.object3d.renderOrder = 0;
  }

  get revision(): number {
    return this._revision;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  get stats(): TerrainTileLayerStats {
    const counts = { ready: 0, loading: 0, pending: 0, queued: 0, errors: 0 };
    for (const record of this.records.values()) {
      if (record.state === 'error') counts.errors += 1;
      else counts[record.state] += 1;
    }
    return {
      ...counts,
      fallbacks: this.fallbackCount,
      resourceBytes: this.residentResourceBytes(),
      stitchedEdges: this.stitchedEdges,
      coverageReady: this.coverageReady,
      stitchLastMs: this.stitchLastMs,
      stitchMaxMs: this.stitchMaxMs,
      committed: this.committed, commitMs: this.commitMs
    };
  }

  update(
    selection: readonly SelectedTile[],
    cameraPosition?: THREE.Vector3
  ): TerrainTileLayerStats {
    if (this.disposed) return this.stats;
    if (cameraPosition) splitVector3(cameraPosition, this.cameraHigh, this.cameraLow);
    if (!this._enabled) return this.stats;
    const selectionChanged = selection !== this.lastSelection;
    if (selectionChanged) {
      this.frame += 1;
      this.lastSelection = selection;
      if (this.showDebugSurface) this.syncRenderTiles(selection);
      this.queueVisibleTiles(selection);
    }
    this.commitPending();
    if (this.committed) this.queueVisibleTiles(selection);
    if (selectionChanged || this.materialsDirty) this.refreshCoverage(selection);
    this.pumpQueue();
    if (this.showDebugSurface && (selectionChanged || this.materialsDirty)) {
      this.syncMaterials(selection);
    }
    if (selectionChanged || this.materialsDirty) {
      this.evictTiles();
      this.materialsDirty = false;
    }
    return this.stats;
  }

  resolveTexture(id: TileId): TerrainTextureBinding | undefined {
    if (!this._enabled || (!this.coverageReady && !this.hasInitialCoverage)) return undefined;
    const record = this.findReadyAncestor(id);
    if (!record?.data) return undefined;
    const levels = id.level - record.id.level;
    const scale = 1 / 2 ** levels;
    const parent = this.findReadyAncestor(id, record.id.level - 1);
    const parentLevels = parent ? id.level - parent.id.level : 0;
    const parentScale = parent ? 1 / 2 ** parentLevels : 1;
    return {
      key: record.key,
      texture: record.data.texture,
      scale,
      offsetX: (id.x - record.id.x * 2 ** levels) * scale,
      offsetY: (id.y - record.id.y * 2 ** levels) * scale,
      sourceLevel: record.id.level,
      width: record.data.width,
      height: record.data.height,
      parentKey: parent?.key ?? '',
      parentTexture: parent?.data?.texture ?? null,
      parentScale,
      parentOffsetX: parent
        ? (id.x - parent.id.x * 2 ** parentLevels) * parentScale
        : 0,
      parentOffsetY: parent
        ? (id.y - parent.id.y * 2 ** parentLevels) * parentScale
        : 0
    };
  }

  sampleTileHeight(id: TileId, u: number, v: number): number | null {
    if (!this._enabled || (!this.coverageReady && !this.hasInitialCoverage)) return null;
    const record = this.findReadyAncestor(id);
    if (!record?.data) return null;
    const size = 2 ** (id.level - record.id.level);
    return sampleTerrainTile(record.data,
      (id.x - record.id.x * size + u) / size,
      (id.y - record.id.y * size + v) / size) * this.exaggeration;
  }

  tileHeightSampler(id: TileId): { key: string; sample: (u: number, v: number) => number } {
    const record = this._enabled && (this.coverageReady || this.hasInitialCoverage) ? this.findReadyAncestor(id) : undefined;
    const data = record?.data;
    if (!record || !data) return { key: 'flat', sample: () => 0 };
    const size = 2 ** (id.level - record.id.level);
    const x = id.x - record.id.x * size, y = id.y - record.id.y * size;
    return { key: `${record.key}/${data.texture.uuid}/${this.exaggeration}`,
      sample: (u, v) => sampleTerrainTile(data, (x + u) / size, (y + v) / size) * this.exaggeration };
  }

  heightVersionAt(longitude: number, latitude: number): string {
    if (!this._enabled) return 'flat';
    const latitudeRadians = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(latitude,
      -WEB_MERCATOR_MAX_LATITUDE, WEB_MERCATOR_MAX_LATITUDE));
    const u = ((((longitude + 180) / 360) % 1) + 1) % 1;
    const v = (1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) * .5;
    for (let level = this.provider.maxLevel; level >= this.provider.minLevel; level--) {
      const size = 2 ** level;
      const record = this.records.get(tileKey({ level, x: Math.min(size - 1, Math.floor(u * size)),
        y: Math.min(size - 1, Math.max(0, Math.floor(v * size))) }));
      if (record?.state === 'ready' && record.data) return `${record.key}/${record.data.texture.uuid}/${this.exaggeration}`;
    }
    return 'flat';
  }

  sampleHeight(longitude: number, latitude: number): number | null {
    if (!this._enabled) return null;
    const clampedLatitude = THREE.MathUtils.clamp(
      latitude,
      -WEB_MERCATOR_MAX_LATITUDE,
      WEB_MERCATOR_MAX_LATITUDE
    );
    for (let level = this.provider.maxLevel; level >= this.provider.minLevel; level -= 1) {
      const size = 2 ** level;
      const tileX = ((((longitude + 180) / 360) * size) % size + size) % size;
      const tileY = (
        1 - Math.asinh(Math.tan(THREE.MathUtils.degToRad(clampedLatitude))) / Math.PI
      ) * 0.5 * size;
      const x = Math.min(size - 1, Math.floor(tileX));
      const y = Math.min(size - 1, Math.max(0, Math.floor(tileY)));
      const record = this.records.get(tileKey({ level, x, y }));
      if (record?.state !== 'ready' || !record.data) continue;
      record.lastUsedFrame = this.frame;
      return sampleTerrainTile(record.data, tileX - x, tileY - y) * this.exaggeration;
    }
    return null;
  }

  maximumHeight(id: TileId): number | null {
    if (!this._enabled) return 0;
    const range = this.heightRange(id);
    return range ? Math.max(0, range.maximumHeight) : null;
  }

  heightRange(id: TileId): SurfaceDisplacementRange | null {
    if (!this._enabled) return { minimumHeight: 0, maximumHeight: 0 };
    for (let level = Math.min(id.level, this.provider.maxLevel); level >= this.provider.minLevel; level--) {
      const scale = 2 ** (id.level - level);
      const known = this.knownHeightRanges.get(tileKey({ level, x: Math.floor(id.x / scale), y: Math.floor(id.y / scale) }));
      if (known) return known;
    }
    const record = this.findReadyAncestor(id);
    if (!record?.data) return null;
    return {
      minimumHeight: record.data.minimumHeight * this.exaggeration - 2,
      maximumHeight: record.data.maximumHeight * this.exaggeration + 2
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const renderTile of this.renderTiles.values()) renderTile.mesh.material.dispose();
    for (const record of this.records.values()) {
      this.cancelRequest(record);
      this.releaseTexture(record.data?.texture);
    }
    for (const geometry of this.geometries.values()) geometry.dispose();
    this.renderTiles.clear();
    this.records.clear();
    this.knownHeightRanges.clear();
    this.geometries.clear();
    this.object3d.clear();
  }

  setEnabled(enabled: boolean): void {
    if (this._enabled === enabled) return;
    this._enabled = enabled;
    this.object3d.visible = enabled;
    this.lastSelection = null;
    this.materialsDirty = true;
    this.coverageReady = !enabled;
    if (!enabled) {
      for (const [key, record] of this.records) {
        if (record.state !== 'ready') {
          this.cancelRequest(record); this.releaseTexture(record.data?.texture);
          this.records.delete(key);
        }
      }
    }
    this._revision += 1;
  }

  handleContextLost(): void {
    this.suspended = true;
  }

  handleContextRestored(): void {
    this.suspended = false;
    for (const record of this.records.values()) {
      if (record.data) record.data.texture.needsUpdate = true;
    }
    for (const renderTile of this.renderTiles.values()) {
      renderTile.mesh.material.needsUpdate = true;
    }
    this.materialsDirty = true;
    this.pumpQueue();
  }

  private syncRenderTiles(selection: readonly SelectedTile[]): void {
    const selectedKeys = new Set(selection.map((tile) => tileKey(tile.id)));
    for (const [key, renderTile] of this.renderTiles) {
      if (selectedKeys.has(key)) continue;
      this.object3d.remove(renderTile.mesh);
      renderTile.mesh.material.dispose();
      this.renderTiles.delete(key);
    }
    for (const tile of selection) {
      const key = tileKey(tile.id);
      if (this.renderTiles.has(key)) continue;
      const mesh = new THREE.Mesh(
        this.geometryForLevel(tile.id.level),
        this.createMaterial(tile.id)
      );
      mesh.frustumCulled = false;
      mesh.renderOrder = 0;
      mesh.onBeforeRender = (_renderer, _scene, camera) => {
        splitVector3(camera.position, this.cameraHigh, this.cameraLow);
      };
      this.renderTiles.set(key, { mesh, terrainKey: '' });
      this.object3d.add(mesh);
    }
  }

  private geometryForLevel(level: number): THREE.BufferGeometry {
    const segments = Math.max(this.baseSegments, Math.round(1024 / 2 ** level));
    let geometry = this.geometries.get(segments);
    if (!geometry) {
      geometry = createGridGeometry(segments);
      this.geometries.set(segments, geometry);
    }
    return geometry;
  }

  private queueVisibleTiles(selection: readonly SelectedTile[]): void {
    this.visibleKeys.clear();
    for (const record of this.records.values()) {
      if (record.state === 'queued' || record.state === 'pending') record.priority = Number.POSITIVE_INFINITY;
    }
    const prioritized = [...selection].sort(
      (a, b) => tileRequestUrgency(b) - tileRequestUrgency(a) ||
        a.viewCenterDistance - b.viewCenterDistance || b.id.level - a.id.level
    );
    for (let rank = 0; rank < prioritized.length; rank += 1) {
      const selected = prioritized[rank];
      if (!selected) continue;
      const maximumLevel = Math.min(selected.id.level, this.provider.maxLevel);
      if (maximumLevel < this.provider.minLevel) continue;
      const coarseLevel = Math.max(this.provider.minLevel, maximumLevel - 2);
      // Establish a complete low-detail surface before requesting the target
      // DEM. Absolute level is the primary priority so a wide viewport cannot
      // start isolated high mountains while neighbouring parents are missing.
      const ready = this.findReadyAncestor(selected.id);
      // Once an ancestor covers this patch, request the target directly.
      // Loading every intervening DEM adds decode/upload/revision work while
      // contributing no missing coverage. Retain the currently bound parent.
      for (let level = ready ? maximumLevel : coarseLevel; level <= maximumLevel; level += 1) {
        const requested = ancestorAtLevel(selected.id, level);
        this.visibleKeys.add(tileKey(requested));
        this.queueTile(
          requested,
          (level - this.provider.minLevel) * prioritized.length + rank
        );
      }
      if (ready) {
        this.visibleKeys.add(ready.key);
        const parent = this.findReadyAncestor(selected.id, ready.id.level - 1);
        if (parent) this.visibleKeys.add(parent.key);
      }
    }
    for (const [key, record] of this.records) {
      if (this.visibleKeys.has(key) || record.state === 'ready') continue;
      this.cancelRequest(record);
      this.releaseTexture(record.data?.texture);
      this.records.delete(key);
    }
  }

  private refreshCoverage(selection: readonly SelectedTile[]): void {
    this.coverageReady = selection.length === 0 || selection.every((selected) => {
      const maximumLevel = Math.min(selected.id.level, this.provider.maxLevel);
      if (maximumLevel < this.provider.minLevel) return true;
      return this.findReadyAncestor(selected.id) !== undefined;
    });
    // Establish a complete coarse surface once. Afterwards one newly exposed
    // patch must not disable DEM for all other ready patches, then turn the
    // whole viewport back on when that patch loads (global geometry churn).
    if (selection.length && this.coverageReady) this.hasInitialCoverage = true;
  }

  private queueTile(id: TileId, priority: number): void {
    const key = tileKey(id);
    const existing = this.records.get(key);
    if (existing) {
      existing.lastUsedFrame = this.frame;
      if (existing.state === 'queued' || existing.state === 'pending') existing.priority = Math.min(existing.priority, priority);
      return;
    }
    this.records.set(key, {
      id,
      key,
      state: 'queued',
      priority,
      lastUsedFrame: this.frame,
      data: null,
      controller: null,
      active: false
    });
  }

  private pumpQueue(): void {
    if (!this.enabled || this.suspended || this.disposed) return;
    while (this.activeRequests < this.maxConcurrentRequests) {
      if (this.residentResourceBytes() >= this.maxResourceBytes) return;
      // Bound completed-but-unpublished work as well as network concurrency.
      let pending = 0;
      for (const record of this.records.values()) if (record.state === 'pending') pending++;
      if (pending + this.activeRequests >= this.maxConcurrentRequests) return;
      let next: TerrainRecord | undefined;
      for (const record of this.records.values()) {
        if (record.state !== 'queued') continue;
        if (!next || record.priority < next.priority) next = record;
      }
      if (!next) return;
      this.load(next);
    }
  }

  private load(record: TerrainRecord): void {
    record.state = 'loading';
    record.controller = new AbortController();
    record.active = true;
    this.activeRequests += 1;
    void this.provider.loadTile(record.id, record.controller.signal).then(
      (data) => {
        this.releaseActiveRequest(record);
        record.controller = null;
        if (this.disposed || this.records.get(record.key) !== record) {
          this.releaseTexture(data.texture);
        } else {
          record.data = data;
          // Never publish individual asynchronous arrivals between frames.
          // update() uploads/publishes a bounded batch before all consumers.
          record.state = 'pending';
          record.lastUsedFrame = this.frame;
        }
        this.pumpQueue();
      },
      () => {
        this.releaseActiveRequest(record);
        record.controller = null;
        if (!this.disposed && this.records.get(record.key) === record) record.state = 'error';
        this.pumpQueue();
      }
    );
  }

  private commitPending(): void {
    this.committed = 0; this.commitMs = 0;
    if (this.suspended) return;
    const started = performance.now();
    let bytes = 0;
    const pending = [...this.records.values()].filter((record) => record.state === 'pending')
      .sort((a, b) => a.priority - b.priority);
    for (const record of pending) {
      if (this.workBudget && !this.workBudget.canStart) break;
      const taskStarted = performance.now();
      const data = record.data!;
      const uploadBytes = data.width * data.height * 4;
      // Permit one oversized tile to make progress; never start a second
      // upload after exceeding either soft time or byte budget.
      if (this.committed && (this.committed >= this.maxCommitsPerFrame ||
          performance.now() - started >= this.commitBudgetMs || bytes + uploadBytes > this.maxUploadBytesPerFrame)) break;
      try {
        this.prepareTexture?.(data.texture);
      } catch (error) {
        this.workBudget?.spend(performance.now() - taskStarted);
        this.releaseTexture(data.texture); record.data = null; record.state = 'error';
        console.warn(`[Terrain ${this.provider.id}] DEM upload failed`, error);
        break;
      }
      record.state = 'ready';
      this.knownHeightRanges.set(record.key, { minimumHeight: data.minimumHeight * this.exaggeration - 2,
        maximumHeight: data.maximumHeight * this.exaggeration + 2 });
      if (this.knownHeightRanges.size > 32768) {
        for (const key of this.knownHeightRanges.keys()) {
          if (!this.visibleKeys.has(key) && this.records.get(key)?.state !== 'ready') {
            this.knownHeightRanges.delete(key); break;
          }
        }
      }
      bytes += uploadBytes; this.committed++;
      this.workBudget?.spend(performance.now() - taskStarted);
    }
    if (this.committed) { this._revision++; this.materialsDirty = true; }
    this.commitMs = performance.now() - started;
  }

  private cancelRequest(record: TerrainRecord): void {
    record.controller?.abort();
    record.controller = null;
    this.releaseActiveRequest(record);
  }

  private releaseActiveRequest(record: TerrainRecord): void {
    if (!record.active) return;
    record.active = false;
    this.activeRequests = Math.max(0, this.activeRequests - 1);
  }

  private syncMaterials(selection: readonly SelectedTile[]): void {
    this.fallbackCount = 0;
    for (const tile of selection) {
      const renderTile = this.renderTiles.get(tileKey(tile.id));
      if (!renderTile) continue;
      const binding = this.resolveTexture(tile.id);
      if (binding && binding.key.split('/')[0] !== String(tile.id.level)) this.fallbackCount += 1;
      const nextKey = binding?.key ?? '';
      const uniforms = renderTile.mesh.material.uniforms;
      // Preserve the coordinate key for cache protection, but do not treat it
      // as proof that the actual uploaded DEM texture is unchanged.
      if (nextKey === renderTile.terrainKey &&
          uniforms.terrainTexture!.value === (binding?.texture ?? null)) continue;
      renderTile.terrainKey = nextKey;
      uniforms.terrainTexture!.value = binding?.texture ?? null;
      uniforms.hasTerrain!.value = binding !== undefined;
      (uniforms.terrainUvScale!.value as THREE.Vector2).setScalar(binding?.scale ?? 1);
      (uniforms.terrainUvOffset!.value as THREE.Vector2).set(
        binding?.offsetX ?? 0,
        binding?.offsetY ?? 0
      );
      (uniforms.terrainTexelSize!.value as THREE.Vector2).set(
        1 / (binding?.width ?? 1),
        1 / (binding?.height ?? 1)
      );
    }
  }

  private findReadyAncestor(
    id: TileId,
    maximumLevelInput = Math.min(id.level, this.provider.maxLevel)
  ): TerrainRecord | undefined {
    const maximumLevel = Math.min(id.level, this.provider.maxLevel, maximumLevelInput);
    for (let level = maximumLevel; level >= this.provider.minLevel; level -= 1) {
      const shift = id.level - level;
      const record = this.records.get(tileKey({
        level,
        x: Math.floor(id.x / 2 ** shift),
        y: Math.floor(id.y / 2 ** shift)
      }));
      if (record?.state === 'ready' && record.data) {
        record.lastUsedFrame = this.frame;
        return record;
      }
    }
    return undefined;
  }

  private evictTiles(): void {
    if (this.suspended) return;
    let remainingBytes = this.residentResourceBytes();
    if (this.records.size <= this.maxCachedTiles && remainingBytes <= this.maxResourceBytes) return;
    const protectedKeys = new Set(this.visibleKeys);
    for (const renderTile of this.renderTiles.values()) {
      if (renderTile.terrainKey) protectedKeys.add(renderTile.terrainKey);
    }
    const candidates = [...this.records.values()]
      .filter((record) => record.state !== 'loading' && !protectedKeys.has(record.key))
      .sort((a, b) => a.lastUsedFrame - b.lastUsedFrame);
    while (
      this.records.size > this.maxCachedTiles ||
      remainingBytes > this.maxResourceBytes
    ) {
      const record = candidates.shift();
      if (!record) break;
      this.releaseTexture(record.data?.texture);
      remainingBytes -= terrainResourceBytes(record.data);
      this.records.delete(record.key);
    }
  }

  private residentResourceBytes(): number {
    let bytes = 0;
    for (const record of this.records.values()) bytes += terrainResourceBytes(record.data);
    return bytes;
  }

  private releaseTexture(texture?: THREE.Texture): void {
    if (texture && !this.suspended) texture.dispose();
  }

  /** Legacy diagnostic helper; normal loading preserves immutable raw DEM. */
  private stitchLoadedTerrain(loaded: TerrainRecord): void {
    if (!loaded.data) return;
    const startedAt = performance.now();
    const tileByData = new Map<StitchableTerrainTile, TerrainRecord>();
    const readyTiles: StitchableTerrainTile[] = [];
    let loadedTile: StitchableTerrainTile | undefined;
    for (const record of this.records.values()) {
      if (record.state !== 'ready' || !record.data) continue;
      const tile = { id: record.id, data: record.data };
      readyTiles.push(tile);
      tileByData.set(tile, record);
      if (record === loaded) loadedTile = tile;
    }
    if (!loadedTile) return;
    const result = stitchTerrainNeighborhood(loadedTile, readyTiles);
    this.stitchedEdges += result.stitchedEdges;
    for (const tile of result.modified) {
      const record = tileByData.get(tile);
      const bounds = result.bounds.get(tile);
      if (!record?.data || !bounds) continue;
      record.data = {
        ...record.data,
        minimumHeight: bounds.minimumHeight,
        maximumHeight: bounds.maximumHeight
      };
    }
    this.stitchLastMs = performance.now() - startedAt;
    this.stitchMaxMs = Math.max(this.stitchMaxMs, this.stitchLastMs);
  }

  private createMaterial(tile: TileId): THREE.ShaderMaterial {
    const size = 2 ** tile.level;
    const longitudeCenter = -Math.PI + ((tile.x + 0.5) / size) * Math.PI * 2;
    const longitudeSpan = Math.PI * 2 / size;
    const mercatorCenter = Math.PI - ((tile.y + 0.5) / size) * Math.PI * 2;
    const mercatorSpan = -Math.PI * 2 / size;
    const latitudeCenter = Math.atan(Math.sinh(mercatorCenter));
    const sinLongitude = Math.sin(longitudeCenter);
    const cosLongitude = Math.cos(longitudeCenter);
    const sinLatitude = Math.sin(latitudeCenter);
    const cosLatitude = Math.cos(latitudeCenter);
    const tileOrigin = this.ellipsoid.cartographicToCartesian({
      longitude: THREE.MathUtils.radToDeg(longitudeCenter),
      latitude: THREE.MathUtils.radToDeg(latitudeCenter)
    });
    const originHigh = new THREE.Vector3();
    const originLow = new THREE.Vector3();
    splitVector3(tileOrigin, originHigh, originLow);
    const a = this.ellipsoid.equatorialRadius;
    const b = this.ellipsoid.polarRadius;
    const eccentricitySquared = 1 - (b * b) / (a * a);
    const latitudeTerm = 1 - eccentricitySquared * sinLatitude * sinLatitude;
    return new THREE.ShaderMaterial({
      uniforms: {
        sag_ellipsoidRadii: { value: new THREE.Vector2(this.ellipsoid.equatorialRadius, this.ellipsoid.polarRadius) },
        sag_heightOffset: { value: 0 },
        sag_cameraHigh: { value: this.cameraHigh },
        sag_cameraLow: { value: this.cameraLow },
        sag_originHigh: { value: originHigh },
        sag_originLow: { value: originLow },
        sag_east: { value: new THREE.Vector3(cosLongitude, 0, -sinLongitude) },
        sag_north: { value: new THREE.Vector3(-sinLatitude * sinLongitude, cosLatitude, -sinLatitude * cosLongitude) },
        sag_up: { value: new THREE.Vector3(cosLatitude * sinLongitude, sinLatitude, cosLatitude * cosLongitude) },
        sag_curvatureRadii: {
          value: new THREE.Vector2(
            a / Math.sqrt(latitudeTerm),
            (a * (1 - eccentricitySquared)) / latitudeTerm ** 1.5
          )
        },
        sag_useLocalCoordinates: { value: tile.level >= 18 },
        tileLongitudeSinCos: { value: new THREE.Vector2(sinLongitude, cosLongitude) },
        tileLongitudeSpan: { value: longitudeSpan },
        tileLatitudeSinCos: { value: new THREE.Vector2(sinLatitude, cosLatitude) },
        tileMercatorSinhCosh: { value: new THREE.Vector2(Math.sinh(mercatorCenter), Math.cosh(mercatorCenter)) },
        tileMercatorSpan: { value: mercatorSpan },
        terrainTexture: { value: null },
        terrainUvScale: { value: new THREE.Vector2(1, 1) },
        terrainUvOffset: { value: new THREE.Vector2(0, 0) },
        terrainTexelSize: { value: new THREE.Vector2(1, 1) },
        hasTerrain: { value: false },
        terrainExaggeration: { value: this.exaggeration }
      },
      vertexShader: /* glsl */ `
        varying vec3 v_globeNormal;
        varying float v_height;
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
        uniform sampler2D terrainTexture;
        uniform vec2 terrainUvScale;
        uniform vec2 terrainUvOffset;
        uniform vec2 terrainTexelSize;
        uniform bool hasTerrain;
        uniform float terrainExaggeration;
        #include <common>
        #include <logdepthbuf_pars_vertex>
        ${globeCoordinateShader}
        void main() {
          float deltaLongitude = (position.x - 0.5) * tileLongitudeSpan;
          vec2 longitudeSinCos = vec2(
            tileLongitudeSinCos.x * cos(deltaLongitude) + tileLongitudeSinCos.y * sin(deltaLongitude),
            tileLongitudeSinCos.y * cos(deltaLongitude) - tileLongitudeSinCos.x * sin(deltaLongitude)
          );
          float deltaMercator = (position.y - 0.5) * tileMercatorSpan;
          float sinhDelta = 0.5 * (exp(deltaMercator) - exp(-deltaMercator));
          float coshDelta = 0.5 * (exp(deltaMercator) + exp(-deltaMercator));
          float sinhMercator = tileMercatorSinhCosh.x * coshDelta + tileMercatorSinhCosh.y * sinhDelta;
          float cosLatitude = inversesqrt(1.0 + sinhMercator * sinhMercator);
          float sinLatitude = sinhMercator * cosLatitude;
          vec2 terrainUv = terrainUvOffset + uv * terrainUvScale;
          vec2 terrainSampleUv = 0.5 * terrainTexelSize +
            terrainUv * (vec2(1.0) - terrainTexelSize);
          float heightMeters = hasTerrain
            ? texture2D(terrainTexture, terrainSampleUv).r * terrainExaggeration
            : 0.0;
          v_height = heightMeters;
          v_globeNormal = normalize(vec3(cosLatitude * longitudeSinCos.x, sinLatitude, cosLatitude * longitudeSinCos.y));
          if (sag_useLocalCoordinates) {
            float deltaLatitude =
              tileLatitudeSinCos.y * deltaMercator -
              0.5 * tileLatitudeSinCos.x * tileLatitudeSinCos.y * deltaMercator * deltaMercator;
            float latitudeMidpoint = 0.5 * deltaLatitude;
            float midpointCosLatitude =
              tileLatitudeSinCos.y * cos(latitudeMidpoint) -
              tileLatitudeSinCos.x * sin(latitudeMidpoint);
            float eastMeters = sag_curvatureRadii.x * midpointCosLatitude * deltaLongitude;
            float northMeters = sag_curvatureRadii.y * deltaLatitude;
            float upMeters = -0.5 * (
              eastMeters * eastMeters / sag_curvatureRadii.x +
              northMeters * northMeters / sag_curvatureRadii.y
            );
            vec3 localWorld =
              sag_east * eastMeters +
              sag_north * northMeters +
              sag_up * (upMeters + heightMeters);
            gl_Position = sag_projectLocalToEye(localWorld, sag_originHigh, sag_originLow);
          } else {
            gl_Position = sag_projectGeodeticTrig(
              longitudeSinCos,
              vec2(sinLatitude, cosLatitude),
              heightMeters
            );
          }
          #include <logdepthbuf_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 v_globeNormal;
        varying float v_height;
        #include <logdepthbuf_pars_fragment>
        void main() {
          float light = 0.55 + 0.45 * max(dot(normalize(v_globeNormal), normalize(vec3(-0.35, 0.55, 1.0))), 0.0);
          float elevation = clamp((v_height + 500.0) / 5000.0, 0.0, 1.0);
          vec3 base = mix(vec3(0.08, 0.20, 0.16), vec3(0.42, 0.38, 0.29), elevation);
          gl_FragColor = vec4(base * light, 1.0);
          #include <logdepthbuf_fragment>
          #include <colorspace_fragment>
        }
      `,
      depthWrite: true,
      depthTest: true,
      toneMapped: false
    });
  }
}

function terrainResourceBytes(data: TerrainTileData | null): number {
  if (!data) return 0;
  // One Float32Array remains CPU-queryable and one R32F texture is resident on GPU.
  return data.heights.byteLength + data.width * data.height * 4;
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
  for (let y = 0; y <= segments; y += 1) {
    for (let x = 0; x <= segments; x += 1) {
      positions.push(x / segments, y / segments, 0);
      uvs.push(x / segments, y / segments);
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
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

function splitVector3(value: THREE.Vector3, high: THREE.Vector3, low: THREE.Vector3): void {
  high.set(Math.fround(value.x), Math.fround(value.y), Math.fround(value.z));
  low.set(value.x - high.x, value.y - high.y, value.z - high.z);
}
