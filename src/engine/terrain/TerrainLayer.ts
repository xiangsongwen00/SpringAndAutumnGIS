import * as THREE from 'three';
import type { GeoCoordinator } from '../../geo/coords';
import { getZoomLevelByDistance } from '../validation/PlanarMapTileLayer';

export type TerrainLayerOptions = {
  enabled?: boolean;
  rgbUrlTemplate?: string;
  yType?: 'xyz' | 'tms';
  imageryUrlTemplate?: string;
  imageryYType?: 'xyz' | 'tms';
  imagerySubdomains?: readonly string[] | string;
  imageryOpacity?: number;
  minZoom?: number;
  maxZoom?: number;
  tileRadius?: number;
  maxConcurrentRequests?: number;
  maxCachedTiles?: number;
  fullCoverageMaxZoom?: number;
  retainFrames?: number;
  retryLimit?: number;
  tileSegments?: number;
  exaggeration?: number;
  zOffset?: number;
  decodeScale?: number;
  decodeOffset?: number;
  decodeMode?: 'auto' | 'mapbox' | 'terrarium';
  seamOverlapMeters?: number;
  showOrientationHelper?: boolean;
};

export type TerrainLayerDebugInfo = {
  enabled: boolean;
  zoom: number;
  centerX: number;
  centerY: number;
  tileRadius: number;
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

type TerrainTile = {
  tileId: TileId;
  key: string;
  state: 'idle' | 'queued' | 'loading' | 'ready' | 'error';
  attempts: number;
  lastWantedFrame: number;
  priority: number;
  heightTexture: THREE.Texture | null;
  colorTexture: THREE.Texture | null;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | null;
};

const DEFAULT_RGB_URL_TEMPLATE = '';
const DEFAULT_IMAGERY_URL_TEMPLATE = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const DEFAULT_IMAGERY_SUBDOMAINS = ['a', 'b', 'c'];

export class TerrainLayer {
  private readonly _root = new THREE.Group();
  private readonly _geo: GeoCoordinator;
  private readonly _rgbUrlTemplate: string;
  private readonly _yType: 'xyz' | 'tms';
  private readonly _imageryUrlTemplate: string;
  private readonly _imageryYType: 'xyz' | 'tms';
  private readonly _imagerySubdomains: readonly string[];
  private readonly _imageryOpacity: number;
  private readonly _minZoom: number;
  private readonly _maxZoom: number;
  private readonly _tileRadius: number;
  private readonly _maxConcurrentRequests: number;
  private readonly _maxCachedTiles: number;
  private readonly _fullCoverageMaxZoom: number;
  private readonly _retainFrames: number;
  private readonly _retryLimit: number;
  private readonly _tileSegments: number;
  private readonly _exaggeration: number;
  private readonly _zOffset: number;
  private readonly _decodeScale: number;
  private readonly _decodeOffset: number;
  private readonly _decodeMode: 'auto' | 'mapbox' | 'terrarium';
  private readonly _seamOverlapWorld: number;
  private readonly _showOrientationHelper: boolean;
  private readonly _orientationHelper = new THREE.Group();
  private _northArrow: THREE.ArrowHelper | null = null;
  private _eastArrow: THREE.ArrowHelper | null = null;

  private readonly _tiles = new Map<string, TerrainTile>();
  private readonly _queuedKeys = new Set<string>();
  private _loadQueue: string[] = [];
  private _inflight = 0;
  private _frame = 0;
  private _enabled = false;
  private _disposed = false;
  private _debugInfo: TerrainLayerDebugInfo;

  constructor(geo: GeoCoordinator, options?: TerrainLayerOptions) {
    this._geo = geo;
    this._rgbUrlTemplate = options?.rgbUrlTemplate ?? DEFAULT_RGB_URL_TEMPLATE;
    this._yType = options?.yType ?? 'tms';
    this._imageryUrlTemplate = options?.imageryUrlTemplate ?? DEFAULT_IMAGERY_URL_TEMPLATE;
    this._imageryYType = options?.imageryYType ?? 'xyz';
    this._imagerySubdomains = normalizeSubdomains(options?.imagerySubdomains);
    this._imageryOpacity = clampNumber(options?.imageryOpacity ?? 1, 0, 1);
    this._minZoom = clampInt(options?.minZoom ?? 0, 0, 13);
    this._maxZoom = clampInt(options?.maxZoom ?? 13, this._minZoom, 13);
    this._tileRadius = Math.max(0, Math.floor(options?.tileRadius ?? 1));
    this._maxConcurrentRequests = Math.max(1, Math.floor(options?.maxConcurrentRequests ?? 8));
    this._maxCachedTiles = Math.max(9, Math.floor(options?.maxCachedTiles ?? 64));
    this._fullCoverageMaxZoom = clampInt(options?.fullCoverageMaxZoom ?? 4, 0, this._maxZoom);
    this._retainFrames = Math.max(0, Math.floor(options?.retainFrames ?? 75));
    this._retryLimit = Math.max(0, Math.floor(options?.retryLimit ?? 1));
    this._tileSegments = Math.max(8, Math.floor(options?.tileSegments ?? 48));
    this._exaggeration = Math.max(0.1, Number(options?.exaggeration ?? 1));
    this._zOffset = Number(options?.zOffset ?? 0);
    this._decodeScale = Number(options?.decodeScale ?? 0.1);
    this._decodeOffset = Number(options?.decodeOffset ?? -10000);
    this._decodeMode = options?.decodeMode ?? 'auto';
    this._seamOverlapWorld = Math.max(
      0,
      Number(options?.seamOverlapMeters ?? 0.5) / this._geo.metersPerUnit
    );
    this._showOrientationHelper = options?.showOrientationHelper ?? true;

    this._enabled = options?.enabled ?? false;
    if (this._showOrientationHelper) {
      this.createOrientationHelper();
      this._root.add(this._orientationHelper);
    }
    this._root.visible = this._enabled;
    this._debugInfo = {
      enabled: this._enabled,
      zoom: this._minZoom,
      centerX: 0,
      centerY: 0,
      tileRadius: this._tileRadius,
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

  get debugInfo(): TerrainLayerDebugInfo {
    return { ...this._debugInfo };
  }

  setEnabled(enabled: boolean): void {
    if (this._disposed) return;
    this._enabled = enabled;
    this._root.visible = enabled;
    this._debugInfo = {
      ...this._debugInfo,
      enabled
    };
  }

  update(focusLon: number, focusLat: number, cameraDistance: number): void {
    if (this._disposed || !this._enabled) return;

    this._frame += 1;
    const safeLon = normalizeLon(focusLon);
    const safeLat = clampNumber(focusLat, -85.05112878, 85.05112878);
    this.updateOrientationHelper(safeLon, safeLat);
    const zoom = this.pickZoom(cameraDistance);
    const centerTile = this._geo.lonLatToTile(safeLon, safeLat, zoom);

    const desired =
      zoom <= this._fullCoverageMaxZoom
        ? this.collectFullCoverageTiles(zoom, centerTile)
        : this.collectLocalTiles(zoom, centerTile, this.resolveTileRadius(zoom, cameraDistance));

    const wantedKeys = new Set<string>();
    for (const desiredTile of desired) {
      const tileId = desiredTile.tileId;
      const key = tileKey(tileId);
      wantedKeys.add(key);
      let tile = this._tiles.get(key);
      if (!tile) {
        tile = {
          tileId,
          key,
          state: 'idle',
          attempts: 0,
          lastWantedFrame: this._frame,
          priority: Number.POSITIVE_INFINITY,
          heightTexture: null,
          colorTexture: null,
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
      tile.heightTexture?.dispose();
      tile.colorTexture?.dispose();
    }
    this._tiles.clear();
    this._debugInfo = {
      ...this._debugInfo,
      tileCount: 0,
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

    for (const tile of this._tiles.values()) {
      if (tile.state === 'loading') loadingCount += 1;
      if (tile.state === 'ready') readyCount += 1;
      if (tile.state === 'error') errorCount += 1;
    }

    this._debugInfo = {
      enabled: this._enabled,
      zoom,
      centerX,
      centerY,
      tileRadius: this._tileRadius,
      tileCount: this._tiles.size,
      queuedCount: this._loadQueue.length,
      loadingCount,
      readyCount,
      errorCount
    };
  }

  private pickZoom(cameraHeight: number): number {
    const byDistance = getZoomLevelByDistance(cameraHeight);
    return clampInt(byDistance, this._minZoom, this._maxZoom);
  }

  private resolveTileRadius(zoom: number, cameraDistance: number): number {
    const altitudeMeters = Math.max(0, cameraDistance * this._geo.metersPerUnit);
    if (zoom <= 5 && altitudeMeters > 1_000_000) return Math.max(this._tileRadius, 8);
    if (zoom <= 6 && altitudeMeters > 500_000) return Math.max(this._tileRadius, 6);
    if (zoom <= 7 && altitudeMeters > 250_000) return Math.max(this._tileRadius, 4);
    return this._tileRadius;
  }

  private collectFullCoverageTiles(
    zoom: number,
    centerTile: { x: number; y: number }
  ): DesiredTile[] {
    const desired: DesiredTile[] = [];
    const n = 2 ** zoom;
    const centerY = clampInt(centerTile.y, 0, n - 1);

    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        const dx = shortestTileDx(centerTile.x, x, n);
        const dy = y - centerY;
        desired.push({
          tileId: { x, y, z: zoom },
          priority: dx * dx + dy * dy
        });
      }
    }

    return desired;
  }

  private collectLocalTiles(
    zoom: number,
    centerTile: { x: number; y: number },
    radius: number
  ): DesiredTile[] {
    const desired: DesiredTile[] = [];
    const n = 2 ** zoom;
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

  private async startLoad(tile: TerrainTile): Promise<void> {
    tile.state = 'loading';
    tile.attempts += 1;
    const attempt = tile.attempts;
    this._inflight += 1;

    try {
      const heightPromise =
        this._rgbUrlTemplate.length > 0
          ? loadHeightTexture(this.buildUrl(this._rgbUrlTemplate, tile.tileId, this._yType)).catch(() => null)
          : Promise.resolve(null);
      const colorPromise = this._imageryUrlTemplate
        ? loadColorTexture(
            this.buildUrl(this._imageryUrlTemplate, tile.tileId, this._imageryYType, this._imagerySubdomains)
          ).catch(() => null)
        : Promise.resolve(null);
      const [heightTexture, colorTexture] = await Promise.all([heightPromise, colorPromise]);
      const current = this._tiles.get(tile.key);
      if (!current || current.attempts !== attempt || this._disposed) {
        heightTexture?.dispose();
        colorTexture?.dispose();
        return;
      }

      const mesh = this.buildTileMesh(current.tileId, heightTexture, colorTexture);
      if (current.mesh) {
        this._root.remove(current.mesh);
        current.mesh.geometry.dispose();
        current.mesh.material.dispose();
        current.heightTexture?.dispose();
        current.colorTexture?.dispose();
      }
      current.heightTexture = heightTexture;
      current.colorTexture = colorTexture;
      current.mesh = mesh;
      current.state = 'ready';
      this._root.add(mesh);
    } catch {
      const current = this._tiles.get(tile.key);
      if (current && current.attempts === attempt) {
        current.state = 'error';
      }
    } finally {
      this._inflight = Math.max(0, this._inflight - 1);
      this.processQueue();
    }
  }

  private buildTileMesh(
    tileId: TileId,
    heightTexture: THREE.Texture | null,
    colorTexture: THREE.Texture | null
  ): THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> {
    const bounds = tileBounds(tileId, this._geo, this._seamOverlapWorld);
    const targetSegments = this.pickSegmentsByZoom(tileId.z);
    const segmentsX = Math.max(8, targetSegments);
    const segmentsY = Math.max(8, targetSegments);
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
        const world = this._geo.wgs84ToThree(lat, lon, 0);
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
    geometry.computeVertexNormals();

    const material = heightTexture
      ? createGpuTerrainMaterial({
          heightTexture,
          colorTexture,
          imageryOpacity: this._imageryOpacity,
          decodeMode: resolveDecodeMode(this._decodeMode),
          decodeScale: this._decodeScale,
          decodeOffset: this._decodeOffset,
          exaggeration: this._exaggeration,
          zOffsetMeters: this._zOffset * this._geo.metersPerUnit,
          metersPerUnit: this._geo.metersPerUnit
        })
      : createEllipsoidImageryMaterial({
          colorTexture,
          imageryOpacity: this._imageryOpacity
        });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 1;
    mesh.frustumCulled = false;
    return mesh;
  }

  private pickSegmentsByZoom(zoom: number): number {
    const high = this._tileSegments;
    if (zoom >= 12) return Math.max(24, high);
    if (zoom >= 10) return Math.max(20, Math.min(high, 36));
    if (zoom >= 8) return Math.max(16, Math.min(high, 28));
    return Math.max(12, Math.min(high, 20));
  }

  private createOrientationHelper(): void {
    this._northArrow = new THREE.ArrowHelper(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0, 0, 0),
      90,
      0x22c55e,
      12,
      6
    );
    this._eastArrow = new THREE.ArrowHelper(
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 0, 0),
      90,
      0xef4444,
      12,
      6
    );
    this._northArrow.renderOrder = 30;
    this._eastArrow.renderOrder = 30;
    this._orientationHelper.add(this._northArrow, this._eastArrow);
  }

  private updateOrientationHelper(focusLon: number, focusLat: number): void {
    if (!this._showOrientationHelper) return;
    if (!this._northArrow || !this._eastArrow) return;

    const base = this._geo.wgs84ToThree(focusLat, focusLon, 150);
    const northSample = this._geo.wgs84ToThree(clampNumber(focusLat + 0.08, -89.9, 89.9), focusLon, 150);
    const eastSample = this._geo.wgs84ToThree(focusLat, normalizeLon(focusLon + 0.08), 150);

    const northDir = new THREE.Vector3(
      northSample.x - base.x,
      northSample.y - base.y,
      northSample.z - base.z
    ).normalize();
    const eastDir = new THREE.Vector3(
      eastSample.x - base.x,
      eastSample.y - base.y,
      eastSample.z - base.z
    ).normalize();

    this._orientationHelper.position.set(base.x, base.y, base.z);
    this._northArrow.setDirection(northDir);
    this._eastArrow.setDirection(eastDir);
    this._orientationHelper.visible = true;
  }

  private buildUrl(
    template: string,
    tileId: TileId,
    yType: 'xyz' | 'tms',
    subdomains?: readonly string[]
  ): string {
    const n = 2 ** tileId.z;
    const y = yType === 'tms' ? n - 1 - tileId.y : tileId.y;
    const domainList = subdomains ?? [];
    const domain =
      domainList.length > 0
        ? domainList[Math.abs(tileId.x + tileId.y + tileId.z) % domainList.length] ?? ''
        : '';
    return template
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
      if (tile.mesh) {
        this._root.remove(tile.mesh);
        tile.mesh.geometry.dispose();
        tile.mesh.material.dispose();
      }
      tile.heightTexture?.dispose();
      tile.colorTexture?.dispose();
      this._tiles.delete(key);
      this._queuedKeys.delete(key);
    }

    if (this._tiles.size <= this._maxCachedTiles) return;

    const candidates = [...this._tiles.values()]
      .filter((tile) => !wantedKeys.has(tile.key) && tile.state !== 'loading')
      .sort((a, b) => a.lastWantedFrame - b.lastWantedFrame);

    for (const tile of candidates) {
      if (this._tiles.size <= this._maxCachedTiles) break;
      if (tile.mesh) {
        this._root.remove(tile.mesh);
        tile.mesh.geometry.dispose();
        tile.mesh.material.dispose();
      }
      tile.heightTexture?.dispose();
      tile.colorTexture?.dispose();
      this._tiles.delete(tile.key);
      this._queuedKeys.delete(tile.key);
    }
  }
}

function createEllipsoidImageryMaterial(options: {
  colorTexture: THREE.Texture | null;
  imageryOpacity: number;
}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: options.colorTexture ? 0xffffff : 0x6b7280,
    map: options.colorTexture,
    roughness: 0.95,
    metalness: 0,
    transparent: options.imageryOpacity < 0.999,
    opacity: options.imageryOpacity
  });
}

function resolveDecodeMode(mode: 'auto' | 'mapbox' | 'terrarium'): 'mapbox' | 'terrarium' {
  return mode === 'terrarium' ? 'terrarium' : 'mapbox';
}

function createGpuTerrainMaterial(options: {
  heightTexture: THREE.Texture;
  colorTexture: THREE.Texture | null;
  imageryOpacity: number;
  decodeMode: 'mapbox' | 'terrarium';
  decodeScale: number;
  decodeOffset: number;
  exaggeration: number;
  zOffsetMeters: number;
  metersPerUnit: number;
}): THREE.MeshStandardMaterial {
  const {
    heightTexture,
    colorTexture,
    imageryOpacity,
    decodeMode,
    decodeScale,
    decodeOffset,
    exaggeration,
    zOffsetMeters,
    metersPerUnit
  } = options;

  const material = new THREE.MeshStandardMaterial({
    color: 0x6b7280,
    map: colorTexture,
    roughness: 0.95,
    metalness: 0,
    transparent: imageryOpacity < 0.999,
    opacity: imageryOpacity
  });
  material.defines = { ...(material.defines ?? {}), USE_UV: '' };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.sagHeightMap = { value: heightTexture };
    shader.uniforms.sagDecodeScale = { value: decodeScale };
    shader.uniforms.sagDecodeOffset = { value: decodeOffset };
    shader.uniforms.sagDecodeMode = { value: decodeMode === 'terrarium' ? 1 : 0 };
    shader.uniforms.sagExaggeration = { value: exaggeration };
    shader.uniforms.sagZOffsetMeters = { value: zOffsetMeters };
    shader.uniforms.sagMetersPerUnit = { value: metersPerUnit };

    shader.vertexShader = `
uniform sampler2D sagHeightMap;
uniform float sagDecodeScale;
uniform float sagDecodeOffset;
uniform int sagDecodeMode;
uniform float sagExaggeration;
uniform float sagZOffsetMeters;
uniform float sagMetersPerUnit;
${shader.vertexShader}
`;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <displacementmap_vertex>',
      `
vec3 sagRgb = texture2D(sagHeightMap, vUv).rgb;
float sagHeightMeters;
if (sagDecodeMode == 1) {
  sagHeightMeters = sagRgb.r * 255.0 * 256.0 + sagRgb.g * 255.0 + (sagRgb.b * 255.0) / 256.0 - 32768.0;
} else {
  float sagRaw = sagRgb.r * 255.0 * 256.0 * 256.0 + sagRgb.g * 255.0 * 256.0 + sagRgb.b * 255.0;
  sagHeightMeters = sagDecodeOffset + sagRaw * sagDecodeScale;
}
float sagHeightUnits = (sagHeightMeters * sagExaggeration + sagZOffsetMeters) / max(sagMetersPerUnit, 1e-6);
transformed += normalize(position) * sagHeightUnits;
`
    );
  };
  material.customProgramCacheKey = () => `sag_terrain_gpu_${decodeMode}`;
  return material;
}

function tileBounds(
  tileId: TileId,
  geo: GeoCoordinator,
  seamOverlapWorld: number
): { westLon: number; eastLon: number; northLat: number; southLat: number } {
  const nw = geo.tileToLonLat(tileId.x, tileId.y, tileId.z);
  const se = geo.tileToLonLat(tileId.x + 1, tileId.y + 1, tileId.z);
  if (seamOverlapWorld <= 0) {
    return {
      westLon: nw.lon,
      eastLon: se.lon,
      northLat: nw.lat,
      southLat: se.lat
    };
  }

  const earthRadius = geo.earthRadiusInThreeUnits();
  const overlapRad = seamOverlapWorld / Math.max(earthRadius, 1);
  const overlapDeg = (overlapRad * 180) / Math.PI;
  const meanLatRad = ((nw.lat + se.lat) * 0.5 * Math.PI) / 180;
  const lonOverlapDeg = overlapDeg / Math.max(0.05, Math.cos(meanLatRad));

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

function loadHeightTexture(url: string): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    loader.load(
      url,
      (texture) => {
        texture.generateMipmaps = true;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        (texture as THREE.Texture & { colorSpace?: THREE.ColorSpace }).colorSpace =
          (THREE as unknown as { NoColorSpace?: THREE.ColorSpace }).NoColorSpace ??
          THREE.LinearSRGBColorSpace;
        resolve(texture);
      },
      undefined,
      (err) => reject(err)
    );
  });
}

function loadColorTexture(url: string): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    loader.load(
      url,
      (texture) => {
        texture.generateMipmaps = true;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.colorSpace = THREE.SRGBColorSpace;
        resolve(texture);
      },
      undefined,
      (err) => reject(err)
    );
  });
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
    return out.length > 0 ? out : DEFAULT_IMAGERY_SUBDOMAINS;
  }

  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.length === 0) return DEFAULT_IMAGERY_SUBDOMAINS;
    const split = trimmed
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
    if (split.length > 0) return split;
    return [trimmed];
  }

  return DEFAULT_IMAGERY_SUBDOMAINS;
}
