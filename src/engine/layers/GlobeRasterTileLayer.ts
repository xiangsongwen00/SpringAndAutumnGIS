import * as THREE from 'three';
import type { GeoCoordinator } from '../../geo/coords';
import { getZoomLevelByDistance, RASTER_TILE_MAX_ZOOM } from '../validation/PlanarMapTileLayer';

export type GlobeRasterTileLayerOptions = {
  enabled?: boolean;
  urlTemplate?: string;
  yType?: 'xyz' | 'tms';
  subdomains?: readonly string[] | string;
  opacity?: number;
  minZoom?: number;
  maxZoom?: number;
  tileRadius?: number;
  maxConcurrentRequests?: number;
  maxCachedTiles?: number;
  fullCoverageMaxZoom?: number;
  coverageScale?: number;
  maxDynamicTileRadius?: number;
  retainFrames?: number;
  retryLimit?: number;
  tileSegments?: number;
  seamOverlapMeters?: number;
  surfaceOffsetMeters?: number;
  maxAnisotropy?: number;
  maxTilesPerFrame?: number;
};

export type GlobeRasterTileLayerDebugInfo = {
  enabled: boolean;
  zoom: number;
  maxZoom: number;
  centerX: number;
  centerY: number;
  tileRadius: number;
  effectiveTileRadius: number;
  requestedCount: number;
  fullCoverage: boolean;
  fullCoverageMaxZoom: number;
  coverageScale: number;
  maxDynamicTileRadius: number;
  renderedZoomStats: ReadonlyArray<{ zoom: number; count: number }>;
  tileCount: number;
  queuedCount: number;
  loadingCount: number;
  readyCount: number;
  errorCount: number;
};

type TileId = {
  x: number;
  y: number;
  z: number;
};

type DesiredTile = {
  tileId: TileId;
  priority: number;
};

type RasterTile = {
  tileId: TileId;
  key: string;
  state: 'idle' | 'queued' | 'loading' | 'ready' | 'error';
  attempts: number;
  lastWantedFrame: number;
  priority: number;
  texture: THREE.Texture | null;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | null;
};

const DEFAULT_URL_TEMPLATE = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const DEFAULT_SUBDOMAINS = ['a', 'b', 'c'];

export class GlobeRasterTileLayer {
  private readonly _root = new THREE.Group();
  private readonly _geo: GeoCoordinator;
  private readonly _urlTemplate: string;
  private readonly _yType: 'xyz' | 'tms';
  private readonly _subdomains: readonly string[];
  private readonly _opacity: number;
  private readonly _minZoom: number;
  private readonly _maxZoom: number;
  private readonly _tileRadius: number;
  private readonly _maxConcurrentRequests: number;
  private readonly _maxCachedTiles: number;
  private readonly _fullCoverageMaxZoom: number;
  private readonly _coverageScale: number;
  private readonly _maxDynamicTileRadius: number;
  private readonly _retainFrames: number;
  private readonly _retryLimit: number;
  private readonly _tileSegments: number;
  private readonly _seamOverlapWorld: number;
  private readonly _surfaceOffsetMeters: number;
  private readonly _maxAnisotropy: number;
  private readonly _maxTilesPerFrame: number;
  private readonly _textureLoader = new THREE.TextureLoader();

  private readonly _tiles = new Map<string, RasterTile>();
  private readonly _queuedKeys = new Set<string>();
  private _loadQueue: string[] = [];
  private _inflight = 0;
  private _frame = 0;
  private _requestedCount = 0;
  private _effectiveTileRadius = 0;
  private _fullCoverage = false;
  private _enabled = false;
  private _disposed = false;
  private _debugInfo: GlobeRasterTileLayerDebugInfo;

  constructor(geo: GeoCoordinator, options?: GlobeRasterTileLayerOptions) {
    this._geo = geo;
    this._urlTemplate = options?.urlTemplate ?? DEFAULT_URL_TEMPLATE;
    this._yType = options?.yType ?? 'xyz';
    this._subdomains = normalizeSubdomains(options?.subdomains);
    this._opacity = clampNumber(options?.opacity ?? 1, 0, 1);
    this._minZoom = clampInt(options?.minZoom ?? 0, 0, RASTER_TILE_MAX_ZOOM);
    this._maxZoom = clampInt(options?.maxZoom ?? RASTER_TILE_MAX_ZOOM, this._minZoom, RASTER_TILE_MAX_ZOOM);
    this._tileRadius = Math.max(0, Math.floor(options?.tileRadius ?? 2));
    this._maxConcurrentRequests = Math.max(1, Math.floor(options?.maxConcurrentRequests ?? 16));
    this._maxCachedTiles = Math.max(16, Math.floor(options?.maxCachedTiles ?? 1200));
    this._fullCoverageMaxZoom = clampInt(options?.fullCoverageMaxZoom ?? 4, 0, this._maxZoom);
    this._coverageScale = Math.max(1, Number(options?.coverageScale ?? 4.2));
    this._maxDynamicTileRadius = Math.max(this._tileRadius, Math.floor(options?.maxDynamicTileRadius ?? 20));
    this._retainFrames = Math.max(0, Math.floor(options?.retainFrames ?? 75));
    this._retryLimit = Math.max(0, Math.floor(options?.retryLimit ?? 1));
    this._tileSegments = Math.max(4, Math.floor(options?.tileSegments ?? 16));
    this._seamOverlapWorld = Math.max(
      0,
      Number(options?.seamOverlapMeters ?? 1) / this._geo.metersPerUnit
    );
    this._surfaceOffsetMeters = Math.max(0, Number(options?.surfaceOffsetMeters ?? 80));
    this._maxAnisotropy = Math.max(1, Math.floor(options?.maxAnisotropy ?? 1));
    this._maxTilesPerFrame = Math.max(16, Math.floor(options?.maxTilesPerFrame ?? this.defaultMaxTilesByZoom(0)));
    this._textureLoader.setCrossOrigin('anonymous');

    this._enabled = options?.enabled ?? true;
    this._root.visible = this._enabled;
    this._debugInfo = {
      enabled: this._enabled,
      zoom: this._minZoom,
      maxZoom: this._maxZoom,
      centerX: 0,
      centerY: 0,
      tileRadius: this._tileRadius,
      effectiveTileRadius: this._tileRadius,
      requestedCount: 0,
      fullCoverage: false,
      fullCoverageMaxZoom: this._fullCoverageMaxZoom,
      coverageScale: this._coverageScale,
      maxDynamicTileRadius: this._maxDynamicTileRadius,
      renderedZoomStats: [],
      tileCount: 0,
      queuedCount: 0,
      loadingCount: 0,
      readyCount: 0,
      errorCount: 0
    };
  }

  get object3d(): THREE.Object3D {
    return this._root;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  get debugInfo(): GlobeRasterTileLayerDebugInfo {
    return { ...this._debugInfo };
  }

  setEnabled(enabled: boolean): void {
    if (this._disposed) return;
    this._enabled = enabled;
    this._root.visible = enabled;
    this._debugInfo = { ...this._debugInfo, enabled };
  }

  update(focusLon: number, focusLat: number, cameraDistance: number): void {
    if (this._disposed || !this._enabled || this._urlTemplate.length === 0) return;

    this._frame += 1;
    const safeLon = normalizeLon(focusLon);
    const safeLat = clampNumber(focusLat, -85.05112878, 85.05112878);
    const zoom = this.pickZoom(cameraDistance);
    const centerTile = this._geo.lonLatToTile(safeLon, safeLat, zoom);

    const desired = this.collectLODTiles(zoom, safeLon, safeLat, cameraDistance);

    this._requestedCount = desired.length;
    this._effectiveTileRadius = 0;

    const wantedKeys = new Set<string>();
    let newTileCount = 0;
    for (const desiredTile of desired) {
      const tileId = desiredTile.tileId;
      const key = tileKey(tileId);
      wantedKeys.add(key);
      let tile = this._tiles.get(key);
      if (!tile) {
        if (newTileCount >= this._maxTilesPerFrame) continue;
        newTileCount += 1;
        tile = {
          tileId,
          key,
          state: 'idle',
          attempts: 0,
          lastWantedFrame: this._frame,
          priority: Number.POSITIVE_INFINITY,
          texture: null,
          mesh: null
        };
        this._tiles.set(key, tile);
      }

      tile.lastWantedFrame = this._frame;
      tile.priority = desiredTile.priority;
      if (tile.state === 'idle' || (tile.state === 'error' && tile.attempts <= this._retryLimit)) {
        this.enqueue(tile.key);
      }
    }

    this.evict(wantedKeys);
    this.processQueue();
    this.refreshDebugInfo(zoom, centerTile.x, centerTile.y);
  }

  private collectLODTiles(
    primaryZoom: number,
    focusLon: number,
    focusLat: number,
    cameraDistance: number
  ): DesiredTile[] {
    const result: DesiredTile[] = [];

    if (primaryZoom <= this._fullCoverageMaxZoom) {
      const centerTile = this._geo.lonLatToTile(focusLon, focusLat, primaryZoom);
      return this.collectFullCoverageTiles(primaryZoom, centerTile);
    }

    const radiusZ = this.resolveTileRadius(primaryZoom, cameraDistance);
    const centerTileZ = this._geo.lonLatToTile(focusLon, focusLat, primaryZoom);
    const tilesZ = this.collectLocalTiles(primaryZoom, centerTileZ, radiusZ);
    for (const t of tilesZ) result.push(t);

    const lodZoom = Math.max(this._minZoom, primaryZoom - 1);
    const radiusZ1 = Math.max(4, Math.ceil(radiusZ * 2.5));
    const centerTileZ1 = this._geo.lonLatToTile(focusLon, focusLat, lodZoom);
    const tilesZ1 = this.collectLocalTiles(lodZoom, centerTileZ1, radiusZ1);
    for (const t of tilesZ1) result.push(t);

    return result;
  }

  dispose(): void {
    this._disposed = true;
    this._loadQueue = [];
    this._queuedKeys.clear();

    for (const tile of this._tiles.values()) {
      if (tile.mesh) {
        this._root.remove(tile.mesh);
        tile.mesh.geometry.dispose();
        tile.mesh.material.dispose();
      }
      tile.texture?.dispose();
    }
    this._tiles.clear();
    this._debugInfo = {
      ...this._debugInfo,
      tileCount: 0,
      requestedCount: 0,
      queuedCount: 0,
      loadingCount: 0,
      readyCount: 0,
      errorCount: 0
    };
  }

  private refreshDebugInfo(zoom: number, centerX: number, centerY: number): void {
    let loadingCount = 0;
    let readyCount = 0;
    let errorCount = 0;
    const renderedZoomStats = new Map<number, number>();

    for (const tile of this._tiles.values()) {
      if (tile.state === 'loading') loadingCount += 1;
      if (tile.state === 'ready') {
        readyCount += 1;
        renderedZoomStats.set(tile.tileId.z, (renderedZoomStats.get(tile.tileId.z) ?? 0) + 1);
      }
      if (tile.state === 'error') errorCount += 1;
    }

    const renderedZoomStatsList = [...renderedZoomStats.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([zoomLevel, count]) => ({ zoom: zoomLevel, count }));

    this._debugInfo = {
      enabled: this._enabled,
      zoom,
      maxZoom: this._maxZoom,
      centerX,
      centerY,
      tileRadius: this._tileRadius,
      effectiveTileRadius: this._effectiveTileRadius,
      requestedCount: this._requestedCount,
      fullCoverage: this._fullCoverage,
      fullCoverageMaxZoom: this._fullCoverageMaxZoom,
      coverageScale: this._coverageScale,
      maxDynamicTileRadius: this._maxDynamicTileRadius,
      renderedZoomStats: renderedZoomStatsList,
      tileCount: this._tiles.size,
      queuedCount: this._loadQueue.length,
      loadingCount,
      readyCount,
      errorCount
    };
  }

  private pickZoom(cameraHeight: number): number {
    const byDistance = getZoomLevelByDistance(cameraHeight, this._maxZoom);
    return clampInt(byDistance - 1, this._minZoom, this._maxZoom);
  }

  private resolveTileRadius(zoom: number, cameraDistance: number): number {
    const altitudeMeters = Math.max(0, cameraDistance * this._geo.metersPerUnit);
    const tileSizeMeters = 40_075_016.68557849 / 2 ** zoom;
    const visibleWidthMeters = 2 * altitudeMeters * Math.tan(Math.PI / 6) * this._coverageScale;
    const formulaRadius = Math.ceil(visibleWidthMeters / Math.max(1, tileSizeMeters)) + 1;

    const maxByZoom = Math.max(2, Math.ceil(Math.sqrt(this.defaultMaxTilesByZoom(zoom)) / 2) - 1);
    const maxRadius = Math.min(this._maxDynamicTileRadius, maxByZoom);
    return clampInt(Math.max(this._tileRadius, formulaRadius), this._tileRadius, maxRadius);
  }

  private collectFullCoverageTiles(zoom: number, centerTile: { x: number; y: number }): DesiredTile[] {
    const desired: DesiredTile[] = [];
    const n = 2 ** zoom;
    for (let dy = 0; dy < n; dy += 1) {
      for (let dx = 0; dx < n; dx += 1) {
        desired.push({
          tileId: { x: dx, y: dy, z: zoom },
          priority: shortestTileDx(centerTile.x, dx, n) ** 2 + Math.abs(dy - centerTile.y) ** 2
        });
      }
    }
    desired.sort((a, b) => a.priority - b.priority);
    return desired;
  }

  private collectLocalTiles(
    zoom: number,
    centerTile: { x: number; y: number },
    radius: number
  ): DesiredTile[] {
    const desired: DesiredTile[] = [];
    const n = 2 ** zoom;
    const maxTiles = Math.min((radius * 2 + 1) ** 2, this.defaultMaxTilesByZoom(zoom));
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        const y = centerTile.y + dy;
        if (y < 0 || y >= n) continue;
        const x = wrapInt(centerTile.x + dx, n);
        desired.push({
          tileId: { x, y, z: zoom },
          priority: shortestTileDx(centerTile.x, x, n) ** 2 + dy * dy
        });
      }
    }
    desired.sort((a, b) => a.priority - b.priority);
    if (desired.length > maxTiles) {
      return desired.slice(0, maxTiles);
    }
    return desired;
  }

  private enqueue(key: string): void {
    const tile = this._tiles.get(key);
    if (!tile) return;
    if (tile.state === 'loading' || tile.state === 'queued' || tile.state === 'ready') return;

    tile.state = 'queued';
    if (!this._queuedKeys.has(key)) {
      this._queuedKeys.add(key);
      this._loadQueue.push(key);
    }
  }

  private processQueue(): void {
    while (this._inflight < this._maxConcurrentRequests && this._loadQueue.length > 0) {
      const bestIdx = this.pickBestQueueIndex();
      const key = this._loadQueue.splice(bestIdx, 1)[0];
      if (!key) break;
      this._queuedKeys.delete(key);

      const tile = this._tiles.get(key);
      if (!tile || tile.state !== 'queued') continue;
      this.startLoad(tile);
    }
  }

  private pickBestQueueIndex(): number {
    let bestIndex = 0;
    let bestPriority = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this._loadQueue.length; i += 1) {
      const key = this._loadQueue[i];
      if (!key) continue;
      const tile = this._tiles.get(key);
      if (!tile) continue;
      if (tile.priority < bestPriority) {
        bestPriority = tile.priority;
        bestIndex = i;
      }
    }
    return bestIndex;
  }

  private startLoad(tile: RasterTile): void {
    tile.state = 'loading';
    tile.attempts += 1;
    const attempt = tile.attempts;
    this._inflight += 1;

    this._textureLoader.load(
      this.buildUrl(tile.tileId),
      (texture) => {
        this._inflight = Math.max(0, this._inflight - 1);
        const current = this._tiles.get(tile.key);
        if (!current || current.attempts !== attempt || this._disposed) {
          texture.dispose();
          this.processQueue();
          return;
        }

        texture.generateMipmaps = true;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.anisotropy = this._maxAnisotropy;
        texture.colorSpace = THREE.SRGBColorSpace;

        const mesh = this.buildTileMesh(current.tileId, texture);
        if (current.mesh) {
          this._root.remove(current.mesh);
          current.mesh.geometry.dispose();
          current.mesh.material.dispose();
          current.texture?.dispose();
        }
        current.texture = texture;
        current.mesh = mesh;
        current.state = 'ready';
        this._root.add(mesh);
        this.processQueue();
      },
      undefined,
      () => {
        this._inflight = Math.max(0, this._inflight - 1);
        const current = this._tiles.get(tile.key);
        if (current && current.attempts === attempt) {
          current.state = 'error';
        }
        this.processQueue();
      }
    );
  }

  private buildTileMesh(
    tileId: TileId,
    texture: THREE.Texture
  ): THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> {
    const bounds = tileBounds(tileId, this._geo, this._seamOverlapWorld);
    const targetSegments = this.pickSegmentsByZoom(tileId.z);
    const segmentsX = Math.max(4, targetSegments);
    const segmentsY = Math.max(4, targetSegments);
    const cols = segmentsX + 1;
    const rows = segmentsY + 1;
    const vertexCount = cols * rows;
    const positions = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const indices = createGridIndices(segmentsX, segmentsY);

    let p = 0;
    let t = 0;
    for (let iy = 0; iy <= segmentsY; iy += 1) {
      const v = iy / segmentsY;
      const lat = lerp(bounds.northLat, bounds.southLat, v);
      for (let ix = 0; ix <= segmentsX; ix += 1) {
        const u = ix / segmentsX;
        const lon = lerp(bounds.westLon, bounds.eastLon, u);
        const world = this._geo.wgs84ToThree(lat, lon, this._surfaceOffsetMeters);
        positions[p++] = world.x;
        positions[p++] = world.y;
        positions[p++] = world.z;
        uvs[t++] = u;
        uvs[t++] = 1 - v;
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));

    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      map: texture,
      transparent: this._opacity < 0.999,
      opacity: this._opacity,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 3;
    mesh.frustumCulled = false;
    return mesh;
  }

  private defaultMaxTilesByZoom(zoom: number): number {
    if (zoom >= 16) return 64;
    if (zoom >= 14) return 100;
    if (zoom >= 12) return 144;
    if (zoom >= 10) return 196;
    if (zoom >= 8) return 256;
    if (zoom >= 6) return 400;
    return 1024;
  }

  private pickSegmentsByZoom(zoom: number): number {
    const high = this._tileSegments;
    if (zoom >= 14) return Math.max(8, Math.min(high, 16));
    if (zoom >= 10) return Math.max(8, Math.min(high, 20));
    if (zoom >= 6) return Math.max(12, Math.min(high, 28));
    if (zoom >= 2) return Math.max(16, Math.min(high, 32));
    return Math.max(20, Math.min(high, 40));
  }

  private buildUrl(tileId: TileId): string {
    const n = 2 ** tileId.z;
    const y = this._yType === 'tms' ? n - 1 - tileId.y : tileId.y;
    const domain =
      this._subdomains.length > 0
        ? this._subdomains[Math.abs(tileId.x + tileId.y + tileId.z) % this._subdomains.length] ?? ''
        : '';
    return this._urlTemplate
      .replace('{z}', String(tileId.z))
      .replace('{x}', String(tileId.x))
      .replace('{y}', String(y))
      .replace('{s}', domain);
  }

  private evict(wantedKeys: Set<string>): void {
    const staleKeys: string[] = [];
    for (const [key, tile] of this._tiles) {
      const age = this._frame - tile.lastWantedFrame;
      if (wantedKeys.has(key)) continue;
      if (tile.state === 'loading') continue;
      if (age > this._retainFrames) staleKeys.push(key);
    }

    for (const key of staleKeys) {
      const tile = this._tiles.get(key);
      if (!tile) continue;
      this.disposeTile(key, tile);
    }

    if (this._tiles.size <= this._maxCachedTiles) return;

    const candidates = [...this._tiles.values()]
      .filter((tile) => !wantedKeys.has(tile.key) && tile.state !== 'loading')
      .sort((a, b) => a.lastWantedFrame - b.lastWantedFrame);
    for (const tile of candidates) {
      if (this._tiles.size <= this._maxCachedTiles) break;
      this.disposeTile(tile.key, tile);
    }
  }

  private disposeTile(key: string, tile: RasterTile): void {
    this._queuedKeys.delete(key);
    if (tile.mesh) {
      this._root.remove(tile.mesh);
      tile.mesh.geometry.dispose();
      tile.mesh.material.dispose();
    }
    tile.texture?.dispose();
    this._tiles.delete(key);
  }
}

function tileBounds(
  tileId: TileId,
  geo: GeoCoordinator,
  seamOverlapWorld: number
): { westLon: number; eastLon: number; northLat: number; southLat: number } {
  const nw = geo.tileToLonLat(tileId.x, tileId.y, tileId.z);
  const se = geo.tileToLonLat(tileId.x + 1, tileId.y + 1, tileId.z);

  const tileLonSpan = Math.abs(se.lon - nw.lon);
  const tileLatSpan = Math.abs(nw.lat - se.lat);
  const maxSpan = Math.max(tileLonSpan, tileLatSpan, 1e-10);
  const pctOverlap = Math.max(0.001, seamOverlapWorld / 50);
  const overlapDeg = maxSpan * pctOverlap;

  const meanLatRad = ((nw.lat + se.lat) * 0.5 * Math.PI) / 180;
  const lonOverlapDeg = overlapDeg / Math.max(0.05, Math.cos(Math.abs(meanLatRad)));

  return {
    westLon: nw.lon - lonOverlapDeg,
    eastLon: se.lon + lonOverlapDeg,
    northLat: Math.min(89.9999, nw.lat + overlapDeg),
    southLat: Math.max(-89.9999, se.lat - overlapDeg)
  };
}

function createGridIndices(segmentsX: number, segmentsY: number): Uint16Array | Uint32Array {
  const cols = segmentsX + 1;
  const faceCount = segmentsX * segmentsY * 2;
  const use32 = cols * (segmentsY + 1) > 65_535;
  const out = use32 ? new Uint32Array(faceCount * 3) : new Uint16Array(faceCount * 3);

  let i = 0;
  for (let y = 0; y < segmentsY; y += 1) {
    for (let x = 0; x < segmentsX; x += 1) {
      const a = y * cols + x;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;

      out[i++] = a;
      out[i++] = c;
      out[i++] = b;
      out[i++] = b;
      out[i++] = c;
      out[i++] = d;
    }
  }

  return out;
}

function tileKey(tileId: TileId): string {
  return `${tileId.z}/${tileId.x}/${tileId.y}`;
}

function wrapInt(value: number, range: number): number {
  return ((value % range) + range) % range;
}

function shortestTileDx(centerX: number, tileX: number, n: number): number {
  const raw = Math.abs(tileX - centerX);
  return Math.min(raw, n - raw);
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeLon(lon: number): number {
  let out = lon % 360;
  if (out > 180) out -= 360;
  if (out <= -180) out += 360;
  return out;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function normalizeSubdomains(input: readonly string[] | string | undefined): readonly string[] {
  if (Array.isArray(input)) {
    const out = input.map((x) => String(x).trim()).filter((x) => x.length > 0);
    return out.length > 0 ? out : DEFAULT_SUBDOMAINS;
  }

  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.length === 0) return DEFAULT_SUBDOMAINS;
    const split = trimmed
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
    if (split.length > 0) return split;
    return [trimmed];
  }

  return DEFAULT_SUBDOMAINS;
}
