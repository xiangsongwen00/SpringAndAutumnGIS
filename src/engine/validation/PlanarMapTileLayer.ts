import * as THREE from 'three';
import type { GeoCoordinator } from '../../geo/coords';

export type PlanarMapTileLayerOptions = {
  enabled?: boolean;
  originLon?: number;
  originLat?: number;
  minZoom?: number;
  maxZoom?: number;
  tileRadius?: number;
  maxDynamicTileRadius?: number;
  opacity?: number;
  zOffset?: number;
  urlTemplate?: string;
  yType?: 'xyz' | 'tms';
  subdomains?: readonly string[] | string;
  maxAnisotropy?: number;
  maxConcurrentRequests?: number;
  maxCachedTiles?: number;
  retainFrames?: number;
  retryLimit?: number;
  updateThrottleMs?: number;
  zoomThrottleMs?: number;
  immediateTileShift?: number;
  lodLevels?: readonly TileLodLevel[];
  debugOverlay?: boolean;
  enableProgressiveBlend?: boolean;
  fadeDurationMs?: number;
  maxParentSearchDepth?: number;
};

export type TileLodLevel = {
  zoom: number;
  maxTiles?: number;
  marginTiles?: number;
  updateThrottleMs?: number;
  zoomThrottleMs?: number;
  immediateTileShift?: number;
};

export type ViewportWorldBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export type PlanarMapTileDebugInfo = {
  enabled: boolean;
  zoom: number;
  centerX: number;
  centerY: number;
  tileCount: number;
  tileRadius: number;
  queuedCount: number;
  loadingCount: number;
  readyCount: number;
  errorCount: number;
  requestedCount: number;
  renderedCount: number;
  renderedZoomStats: ReadonlyArray<{ zoom: number; count: number }>;
};

type TileId = {
  x: number;
  y: number;
  z: number;
};

type TileState = 'idle' | 'queued' | 'loading' | 'ready' | 'error';

type ActiveTile = {
  tileId: TileId;
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  texture: THREE.Texture | null;
  key: string;
  state: TileState;
  attempts: number;
  priority: number;
  lastWantedFrame: number;
  lastTouchedFrame: number;
  currentOpacity: number;
  targetOpacity: number;
  lastFadeUpdateMs: number;
};

type DesiredTile = {
  tileId: TileId;
  key: string;
  priority: number;
  tileRect?: { centerX: number; centerY: number; width: number; height: number };
};

type LayerViewState = {
  zoom: number;
  centerX: number;
  centerY: number;
  tileRadius: number;
  stateKey: string;
  viewportBounds: ViewportWorldBounds | null;
};

const DEFAULT_URL_TEMPLATE = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const DEFAULT_SUBDOMAINS = ['a', 'b', 'c'];
const WEB_MERCATOR_HALF_WORLD = Math.PI * 6378137;
const WEB_MERCATOR_WORLD_SIZE = WEB_MERCATOR_HALF_WORLD * 2;

export function getZoomLevelByDistance(distanceMeters: number): number {
  const d = Math.max(0, Number(distanceMeters) || 0);
  if (d <= 9) return 24;
  if (d <= 19) return 23;
  if (d <= 29) return 22;
  if (d <= 59) return 21;
  if (d <= 79) return 20;
  if (d <= 150) return 19;
  if (d <= 300) return 18;
  if (d <= 660) return 17;
  if (d <= 1300) return 16;
  if (d <= 2600) return 15;
  if (d <= 6400) return 14;
  if (d <= 13200) return 13;
  if (d <= 26000) return 12;
  if (d <= 68985) return 11;
  if (d <= 139780) return 10;
  if (d <= 250600) return 9;
  if (d <= 380000) return 8;
  if (d <= 640000) return 7;
  if (d <= 1280000) return 6;
  if (d <= 2600000) return 5;
  if (d <= 6100000) return 4;
  if (d <= 11900000) return 3;
  return 2;
}

export class PlanarMapTileLayer {
  private readonly _root = new THREE.Group();
  private readonly _geo: GeoCoordinator;
  private readonly _originMercator: { x: number; y: number };
  private readonly _minZoom: number;
  private readonly _maxZoom: number;
  private readonly _tileRadius: number;
  private readonly _maxDynamicTileRadius: number;
  private readonly _opacity: number;
  private readonly _zOffset: number;
  private readonly _urlTemplate: string;
  private readonly _yType: 'xyz' | 'tms';
  private readonly _subdomains: readonly string[];
  private readonly _maxAnisotropy: number;
  private readonly _enabled: boolean;
  private readonly _maxConcurrentRequests: number;
  private readonly _maxCachedTiles: number;
  private readonly _retainFrames: number;
  private readonly _retryLimit: number;
  private readonly _updateThrottleMs: number;
  private readonly _zoomThrottleMs: number;
  private readonly _immediateTileShift: number;
  private readonly _lodLevels: readonly TileLodLevel[];
  private readonly _debugOverlay: boolean;
  private readonly _enableProgressiveBlend: boolean;
  private readonly _fadeDurationMs: number;
  private readonly _maxParentSearchDepth: number;
  private readonly _debugRoot = new THREE.Group();
  private _viewportOverlay: THREE.LineLoop<THREE.BufferGeometry, THREE.LineBasicMaterial> | null = null;
  private _tileOverlay: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> | null = null;
  private readonly _textureLoader = new THREE.TextureLoader();

  private readonly _tiles = new Map<string, ActiveTile>();
  private readonly _queuedKeys = new Set<string>();

  private _frame = 0;
  private _stateKey = '';
  private _inflightCount = 0;
  private _loadQueue: string[] = [];
  private _lastLayoutUpdateMs = 0;
  private _pendingViewState: LayerViewState | null = null;
  private _appliedViewState: LayerViewState | null = null;
  private _activeDesiredTiles: DesiredTile[] = [];
  private _requestedCount = 0;
  private _debugInfo: PlanarMapTileDebugInfo = {
    enabled: false,
    zoom: 0,
    centerX: 0,
    centerY: 0,
    tileCount: 0,
    tileRadius: 0,
    queuedCount: 0,
    loadingCount: 0,
    readyCount: 0,
    errorCount: 0,
    requestedCount: 0,
    renderedCount: 0,
    renderedZoomStats: []
  };

  constructor(geo: GeoCoordinator, options?: PlanarMapTileLayerOptions) {
    this._geo = geo;
    this._enabled = options?.enabled ?? true;
    const originLon = options?.originLon ?? 0;
    const originLat = options?.originLat ?? 0;
    this._originMercator = this._geo.lonLatToWebMercator(originLon, originLat);
    this._minZoom = clampInt(options?.minZoom ?? 0, 0, 22);
    this._maxZoom = clampInt(options?.maxZoom ?? 18, 0, 22);
    this._tileRadius = Math.max(0, Math.floor(options?.tileRadius ?? 2));
    this._maxDynamicTileRadius = Math.max(this._tileRadius, Math.floor(options?.maxDynamicTileRadius ?? 10));
    this._opacity = clampNumber(options?.opacity ?? 1, 0, 1);
    this._zOffset = options?.zOffset ?? -0.35;
    this._urlTemplate = options?.urlTemplate ?? DEFAULT_URL_TEMPLATE;
    this._yType = options?.yType ?? 'xyz';
    this._subdomains = normalizeSubdomains(options?.subdomains);
    this._maxAnisotropy = Math.max(1, Math.floor(options?.maxAnisotropy ?? 1));
    this._maxConcurrentRequests = Math.max(1, Math.floor(options?.maxConcurrentRequests ?? 8));
    this._maxCachedTiles = Math.max(16, Math.floor(options?.maxCachedTiles ?? 600));
    this._retainFrames = Math.max(0, Math.floor(options?.retainFrames ?? 90));
    this._retryLimit = Math.max(0, Math.floor(options?.retryLimit ?? 2));
    this._updateThrottleMs = Math.max(16, Math.floor(options?.updateThrottleMs ?? 80));
    this._zoomThrottleMs = Math.max(this._updateThrottleMs, Math.floor(options?.zoomThrottleMs ?? 140));
    this._immediateTileShift = Math.max(1, Math.floor(options?.immediateTileShift ?? 2));
    this._lodLevels = normalizeLodLevels(options?.lodLevels);
    this._debugOverlay = options?.debugOverlay ?? true;
    this._enableProgressiveBlend = options?.enableProgressiveBlend ?? true;
    this._fadeDurationMs = Math.max(30, Math.floor(options?.fadeDurationMs ?? 180));
    this._maxParentSearchDepth = Math.max(1, Math.floor(options?.maxParentSearchDepth ?? 6));

    this._textureLoader.setCrossOrigin('anonymous');

    this._debugInfo = {
      enabled: this._enabled,
      zoom: this._minZoom,
      centerX: 0,
      centerY: 0,
      tileCount: 0,
      tileRadius: this._tileRadius,
      queuedCount: 0,
      loadingCount: 0,
      readyCount: 0,
      errorCount: 0,
      requestedCount: 0,
      renderedCount: 0,
      renderedZoomStats: []
    };

    this._debugRoot.renderOrder = 50;
    this._root.add(this._debugRoot);
  }

  get object3d(): THREE.Object3D {
    return this._root;
  }

  get debugInfo(): PlanarMapTileDebugInfo {
    return {
      ...this._debugInfo,
      renderedZoomStats: this._debugInfo.renderedZoomStats.map((item) => ({ ...item }))
    };
  }

  worldXYToLonLat(x: number, y: number): { lon: number; lat: number } {
    const mercatorX = this._originMercator.x + x * this._geo.metersPerUnit;
    const mercatorY = this._originMercator.y + y * this._geo.metersPerUnit;
    return this._geo.webMercatorToLonLat(mercatorX, mercatorY);
  }

  update(
    focusX: number,
    focusY: number,
    cameraHeight: number,
    viewRadiusWorld?: number,
    viewportBounds?: ViewportWorldBounds | null
  ): void {
    if (!this._enabled) return;

    this._frame += 1;

    const focusMercator = {
      x: this._originMercator.x + focusX * this._geo.metersPerUnit,
      y: this._originMercator.y + focusY * this._geo.metersPerUnit
    };
    const focusLonLat = this._geo.webMercatorToLonLat(focusMercator.x, focusMercator.y);
    const zoom = this.pickZoom(cameraHeight);
    const centerTile = this._geo.lonLatToTile(focusLonLat.lon, focusLonLat.lat, zoom);
    const effectiveRadius = this.resolveTileRadius(zoom, centerTile, viewRadiusWorld);
    const safeViewport = sanitizeViewportBounds(viewportBounds ?? null);
    const viewportKey = this.buildViewportStateKey(safeViewport, zoom);
    const nextViewState: LayerViewState = {
      zoom,
      centerX: centerTile.x,
      centerY: centerTile.y,
      tileRadius: effectiveRadius,
      stateKey: `${zoom}|${centerTile.x}|${centerTile.y}|${effectiveRadius}|${viewportKey}`,
      viewportBounds: safeViewport
    };

    const now = nowMs();
    let applyState = nextViewState;
    if (nextViewState.stateKey !== this._stateKey && !this.shouldApplyNow(nextViewState, now)) {
      this._pendingViewState = nextViewState;
      applyState = this._appliedViewState ?? nextViewState;
    } else if (this._pendingViewState) {
      applyState = this._pendingViewState;
      this._pendingViewState = null;
    }

    if (applyState.stateKey !== this._stateKey) {
      this.applyViewState(applyState);
      this._lastLayoutUpdateMs = now;
      this._appliedViewState = applyState;
    }

    this.processLoadQueue();
    this.updateProgressiveVisibility(now);
    this.refreshDebugInfo(
      this._appliedViewState?.zoom ?? zoom,
      this._appliedViewState?.centerX ?? centerTile.x,
      this._appliedViewState?.centerY ?? centerTile.y,
      this._appliedViewState?.tileRadius ?? effectiveRadius
    );
  }

  dispose(): void {
    this._loadQueue = [];
    this._queuedKeys.clear();
    for (const [key, tile] of this._tiles) {
      this.disposeTile(key, tile);
    }
    this._tiles.clear();
    this._stateKey = '';
    this._pendingViewState = null;
    this._appliedViewState = null;
    this._activeDesiredTiles = [];
    this._requestedCount = 0;
    this.clearDebugOverlays();
  }

  private shouldApplyNow(next: LayerViewState, nowMsValue: number): boolean {
    if (this._stateKey.length === 0 || this._appliedViewState === null) {
      return true;
    }

    const current = this._appliedViewState;
    const elapsed = nowMsValue - this._lastLayoutUpdateMs;
    const centerShift = Math.abs(next.centerX - current.centerX) + Math.abs(next.centerY - current.centerY);
    const zoomShift = Math.abs(next.zoom - current.zoom);
    const radiusShift = Math.abs(next.tileRadius - current.tileRadius);
    const lod = this.getLodLevel(next.zoom);
    const updateThrottleMs = Math.max(16, Math.floor(lod?.updateThrottleMs ?? this._updateThrottleMs));
    const zoomThrottleMs = Math.max(updateThrottleMs, Math.floor(lod?.zoomThrottleMs ?? this._zoomThrottleMs));
    const immediateTileShift = Math.max(1, Math.floor(lod?.immediateTileShift ?? this._immediateTileShift));

    if (centerShift >= immediateTileShift) return true;
    if (zoomShift >= 2) return true;
    if (zoomShift >= 1 || radiusShift >= 1) {
      return elapsed >= zoomThrottleMs;
    }
    return elapsed >= updateThrottleMs;
  }

  private applyViewState(state: LayerViewState): void {
    const desiredTiles = this.collectDesiredTiles(
      { x: state.centerX, y: state.centerY },
      state.zoom,
      state.tileRadius,
      state.viewportBounds
    );
    this._requestedCount = desiredTiles.length;
    this._activeDesiredTiles = desiredTiles;
    const wantedKeys = new Set<string>();

    for (const desired of desiredTiles) {
      wantedKeys.add(desired.key);
      let tile = this._tiles.get(desired.key);
      if (!tile) {
        tile = this.createTileShell(desired.tileId, desired.key);
        this._tiles.set(desired.key, tile);
      }

      tile.priority = desired.priority;
      tile.lastWantedFrame = this._frame;
      tile.lastTouchedFrame = this._frame;

      if (tile.state === 'idle') {
        this.enqueueTileLoad(tile.key);
      } else if (tile.state === 'error' && tile.attempts <= this._retryLimit) {
        this.enqueueTileLoad(tile.key);
      }
    }

    for (const tile of this._tiles.values()) {
      if (wantedKeys.has(tile.key)) continue;
      const age = this._frame - tile.lastWantedFrame;
      if (age > this._retainFrames) {
        tile.targetOpacity = 0;
      }
    }

    this._stateKey = state.stateKey;
    this.updateDebugOverlays(state.viewportBounds, state.zoom, desiredTiles);
    this.evictTiles(wantedKeys);
  }

  private updateProgressiveVisibility(now: number): void {
    const visibleKeys = new Set<string>();
    const touchedAncestorKeys = new Set<string>();

    for (const desired of this._activeDesiredTiles) {
      const current = this._tiles.get(desired.key);
      if (!current) continue;

      if (current.state === 'ready') {
        visibleKeys.add(current.key);
        current.lastWantedFrame = this._frame;
        continue;
      }

      const fallback = this.findReadyAncestor(desired.tileId, touchedAncestorKeys);
      if (fallback) {
        visibleKeys.add(fallback.key);
        fallback.lastWantedFrame = this._frame;
      }
    }

    for (const tile of this._tiles.values()) {
      const age = this._frame - tile.lastWantedFrame;
      const shouldBeVisible = visibleKeys.has(tile.key) && tile.state === 'ready' && age <= this._retainFrames;
      tile.targetOpacity = shouldBeVisible ? this._opacity : 0;
      this.animateTileOpacity(tile, now);
    }
  }

  private findReadyAncestor(tileId: TileId, touched: Set<string>): ActiveTile | null {
    let x = tileId.x;
    let y = tileId.y;
    let z = tileId.z;
    let bestReady: ActiveTile | null = null;

    for (let i = 0; i < this._maxParentSearchDepth && z > this._minZoom; i += 1) {
      x = Math.floor(x / 2);
      y = Math.floor(y / 2);
      z -= 1;

      const key = `${z}/${x}/${y}`;
      let parent = this._tiles.get(key);
      if (!parent) {
        parent = this.createTileShell({ x, y, z }, key);
        this._tiles.set(key, parent);
      }

      if (!touched.has(key)) {
        touched.add(key);
        parent.lastWantedFrame = this._frame;
        parent.lastTouchedFrame = this._frame;
        if (parent.state === 'idle') {
          this.enqueueTileLoad(parent.key);
        } else if (parent.state === 'error' && parent.attempts <= this._retryLimit) {
          this.enqueueTileLoad(parent.key);
        }
      }

      if (parent.state === 'ready') {
        bestReady = parent;
        break;
      }
    }

    return bestReady;
  }

  private animateTileOpacity(tile: ActiveTile, now: number): void {
    if (!this._enableProgressiveBlend) {
      const visible = tile.targetOpacity > 0.001;
      tile.currentOpacity = visible ? this._opacity : 0;
      tile.mesh.material.opacity = 1;
      tile.mesh.material.transparent = false;
      tile.mesh.visible = visible;
      tile.lastFadeUpdateMs = now;
      return;
    }

    const dt = Math.max(0, now - tile.lastFadeUpdateMs);
    tile.lastFadeUpdateMs = now;
    if (dt <= 0) return;

    if (Math.abs(tile.targetOpacity - tile.currentOpacity) < 1e-4) {
      tile.currentOpacity = tile.targetOpacity;
    } else {
      const step = Math.min(1, dt / this._fadeDurationMs);
      tile.currentOpacity += (tile.targetOpacity - tile.currentOpacity) * step;
    }

    tile.currentOpacity = clampNumber(tile.currentOpacity, 0, this._opacity);
    tile.mesh.material.opacity = tile.currentOpacity;
    tile.mesh.material.transparent = tile.currentOpacity < 0.999;
    tile.mesh.visible = tile.currentOpacity > 0.001;
  }

  private pickZoom(cameraHeight: number): number {
    const byDistance = getZoomLevelByDistance(cameraHeight);
    return clampInt(byDistance, this._minZoom, this._maxZoom);
  }

  private resolveTileRadius(zoom: number, centerTile: { x: number; y: number }, viewRadiusWorld?: number): number {
    const n = 2 ** zoom;

    if (n <= 8) {
      return Math.max(this._tileRadius, Math.ceil(n / 2));
    }

    let radius = this._tileRadius;
    if (viewRadiusWorld !== undefined && Number.isFinite(viewRadiusWorld) && viewRadiusWorld > 0) {
      const sampleRect = tileRectInWorld(
        this._geo,
        { x: centerTile.x, y: centerTile.y, z: zoom },
        this._originMercator.x,
        this._originMercator.y
      );
      const tileSize = Math.max(1e-3, Math.min(sampleRect.width, sampleRect.height));
      const needed = Math.ceil(viewRadiusWorld / tileSize) + 1;
      radius = Math.max(radius, needed);
    }

    return clampInt(radius, this._tileRadius, this._maxDynamicTileRadius);
  }

  private collectDesiredTiles(
    centerTile: { x: number; y: number },
    zoom: number,
    radius: number,
    viewportBounds: ViewportWorldBounds | null
  ): DesiredTile[] {
    const lod = this.getLodLevel(zoom);
    const marginTiles = Math.max(0, Math.floor(lod?.marginTiles ?? 1));
    const maxTiles = Math.max(16, Math.floor(lod?.maxTiles ?? this.defaultMaxTilesByZoom(zoom)));

    const byViewport = viewportBounds
      ? this.collectDesiredTilesByViewport(centerTile, zoom, viewportBounds, marginTiles)
      : [];
    const list = byViewport.length > 0 ? byViewport : this.collectDesiredTilesByRadius(centerTile, zoom, radius);

    list.sort((a, b) => a.priority - b.priority);
    if (list.length > maxTiles) {
      return list.slice(0, maxTiles);
    }
    return list;
  }

  private collectDesiredTilesByRadius(
    centerTile: { x: number; y: number },
    zoom: number,
    radius: number
  ): DesiredTile[] {
    const list: DesiredTile[] = [];
    const n = 2 ** zoom;

    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        const tileY = centerTile.y + dy;
        if (tileY < 0 || tileY >= n) continue;
        const tileX = wrapInt(centerTile.x + dx, n);
        const tileId: TileId = { x: tileX, y: tileY, z: zoom };
        const priority = shortestTileDx(centerTile.x, tileX, n) ** 2 + dy * dy;
        list.push({
          tileId,
          key: `${zoom}/${tileX}/${tileY}`,
          priority,
          tileRect: this._debugOverlay
            ? tileRectInWorld(this._geo, tileId, this._originMercator.x, this._originMercator.y)
            : undefined
        });
      }
    }

    return list;
  }

  private collectDesiredTilesByViewport(
    centerTile: { x: number; y: number },
    zoom: number,
    viewportBounds: ViewportWorldBounds,
    marginTiles: number
  ): DesiredTile[] {
    const mercMinX = this._originMercator.x + viewportBounds.minX * this._geo.metersPerUnit;
    const mercMaxX = this._originMercator.x + viewportBounds.maxX * this._geo.metersPerUnit;
    const mercMinY = this._originMercator.y + viewportBounds.minY * this._geo.metersPerUnit;
    const mercMaxY = this._originMercator.y + viewportBounds.maxY * this._geo.metersPerUnit;

    const tileRange = mercatorBoundsToTileRange(
      Math.min(mercMinX, mercMaxX),
      Math.min(mercMinY, mercMaxY),
      Math.max(mercMinX, mercMaxX),
      Math.max(mercMinY, mercMaxY),
      zoom,
      marginTiles
    );
    if (!tileRange) return [];

    const list: DesiredTile[] = [];
    const seen = new Set<string>();
    const n = 2 ** zoom;

    const width = tileRange.maxXRaw - tileRange.minXRaw + 1;
    if (width >= n) {
      for (let tileY = tileRange.minY; tileY <= tileRange.maxY; tileY += 1) {
        for (let tileX = 0; tileX < n; tileX += 1) {
          const key = `${zoom}/${tileX}/${tileY}`;
          const dx = shortestTileDx(centerTile.x, tileX, n);
          const dy = tileY - centerTile.y;
          const tileId: TileId = { x: tileX, y: tileY, z: zoom };
          list.push({
            tileId,
            key,
            priority: dx * dx + dy * dy,
            tileRect: this._debugOverlay
              ? tileRectInWorld(this._geo, tileId, this._originMercator.x, this._originMercator.y)
              : undefined
          });
        }
      }
      return list;
    }

    for (let rawY = tileRange.minY; rawY <= tileRange.maxY; rawY += 1) {
      if (rawY < 0 || rawY >= n) continue;
      for (let rawX = tileRange.minXRaw; rawX <= tileRange.maxXRaw; rawX += 1) {
        const tileX = wrapInt(rawX, n);
        const key = `${zoom}/${tileX}/${rawY}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const dx = shortestTileDx(centerTile.x, tileX, n);
        const dy = rawY - centerTile.y;
        const tileId: TileId = { x: tileX, y: rawY, z: zoom };
        list.push({
          tileId,
          key,
          priority: dx * dx + dy * dy,
          tileRect: this._debugOverlay
            ? tileRectInWorld(this._geo, tileId, this._originMercator.x, this._originMercator.y)
            : undefined
        });
      }
    }

    return list;
  }

  private getLodLevel(zoom: number): TileLodLevel | undefined {
    for (const level of this._lodLevels) {
      if (level.zoom === zoom) return level;
    }
    return undefined;
  }

  private defaultMaxTilesByZoom(zoom: number): number {
    if (zoom >= 18) return 64;
    if (zoom >= 16) return 81;
    if (zoom >= 14) return 100;
    if (zoom >= 12) return 121;
    if (zoom >= 10) return 144;
    if (zoom >= 8) return 196;
    if (zoom >= 6) return 256;
    if (zoom >= 4) return 324;
    return 400;
  }

  private buildViewportStateKey(viewportBounds: ViewportWorldBounds | null, zoom: number): string {
    if (!viewportBounds) return 'none';
    const mercMinX = this._originMercator.x + viewportBounds.minX * this._geo.metersPerUnit;
    const mercMaxX = this._originMercator.x + viewportBounds.maxX * this._geo.metersPerUnit;
    const mercMinY = this._originMercator.y + viewportBounds.minY * this._geo.metersPerUnit;
    const mercMaxY = this._originMercator.y + viewportBounds.maxY * this._geo.metersPerUnit;
    const range = mercatorBoundsToTileRange(
      Math.min(mercMinX, mercMaxX),
      Math.min(mercMinY, mercMaxY),
      Math.max(mercMinX, mercMaxX),
      Math.max(mercMinY, mercMaxY),
      zoom,
      0
    );
    if (!range) return 'none';
    return `${range.minXRaw}:${range.maxXRaw}:${range.minY}:${range.maxY}`;
  }

  private updateDebugOverlays(
    viewportBounds: ViewportWorldBounds | null,
    zoom: number,
    desiredTiles: readonly DesiredTile[]
  ): void {
    if (!this._debugOverlay) {
      this.clearDebugOverlays();
      return;
    }

    const z = this._zOffset + 0.8;
    if (viewportBounds) {
      const viewportPositions = new Float32Array([
        viewportBounds.minX,
        viewportBounds.minY,
        z,
        viewportBounds.maxX,
        viewportBounds.minY,
        z,
        viewportBounds.maxX,
        viewportBounds.maxY,
        z,
        viewportBounds.minX,
        viewportBounds.maxY,
        z
      ]);

      this._viewportOverlay = upsertLineLoop(
        this._debugRoot,
        this._viewportOverlay,
        viewportPositions,
        0xef4444,
        0.95,
        60
      );
    } else {
      this.disposeLineLoop(this._viewportOverlay);
      this._viewportOverlay = null;
    }

    if (desiredTiles.length === 0) {
      this.disposeLineSegments(this._tileOverlay);
      this._tileOverlay = null;
      return;
    }

    const tileSegments = new Float32Array(desiredTiles.length * 8 * 3);
    let cursor = 0;
    for (const desired of desiredTiles) {
      const rect =
        desired.tileRect ??
        tileRectInWorld(this._geo, desired.tileId, this._originMercator.x, this._originMercator.y);
      const minX = rect.centerX - rect.width * 0.5;
      const maxX = rect.centerX + rect.width * 0.5;
      const minY = rect.centerY - rect.height * 0.5;
      const maxY = rect.centerY + rect.height * 0.5;

      tileSegments[cursor++] = minX;
      tileSegments[cursor++] = minY;
      tileSegments[cursor++] = z;
      tileSegments[cursor++] = maxX;
      tileSegments[cursor++] = minY;
      tileSegments[cursor++] = z;

      tileSegments[cursor++] = maxX;
      tileSegments[cursor++] = minY;
      tileSegments[cursor++] = z;
      tileSegments[cursor++] = maxX;
      tileSegments[cursor++] = maxY;
      tileSegments[cursor++] = z;

      tileSegments[cursor++] = maxX;
      tileSegments[cursor++] = maxY;
      tileSegments[cursor++] = z;
      tileSegments[cursor++] = minX;
      tileSegments[cursor++] = maxY;
      tileSegments[cursor++] = z;

      tileSegments[cursor++] = minX;
      tileSegments[cursor++] = maxY;
      tileSegments[cursor++] = z;
      tileSegments[cursor++] = minX;
      tileSegments[cursor++] = minY;
      tileSegments[cursor++] = z;
    }

    const tileColor = this.colorByZoom(zoom);
    this._tileOverlay = upsertLineSegments(
      this._debugRoot,
      this._tileOverlay,
      tileSegments,
      tileColor,
      0.55,
      59
    );
  }

  private colorByZoom(zoom: number): number {
    if (zoom >= 18) return 0x22c55e;
    if (zoom >= 14) return 0x3b82f6;
    if (zoom >= 10) return 0xf59e0b;
    return 0xa855f7;
  }

  private clearDebugOverlays(): void {
    this.disposeLineLoop(this._viewportOverlay);
    this.disposeLineSegments(this._tileOverlay);
    this._viewportOverlay = null;
    this._tileOverlay = null;
  }

  private disposeLineLoop(line: THREE.LineLoop<THREE.BufferGeometry, THREE.LineBasicMaterial> | null): void {
    if (!line) return;
    this._debugRoot.remove(line);
    line.geometry.dispose();
    line.material.dispose();
  }

  private disposeLineSegments(
    line: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> | null
  ): void {
    if (!line) return;
    this._debugRoot.remove(line);
    line.geometry.dispose();
    line.material.dispose();
  }

  private createTileShell(tileId: TileId, key: string): ActiveTile {
    const tileRect = tileRectInWorld(this._geo, tileId, this._originMercator.x, this._originMercator.y);
    const geometry = new THREE.PlaneGeometry(tileRect.width, tileRect.height, 1, 1);
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: true
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(tileRect.centerX, tileRect.centerY, this._zOffset + tileId.z * 0.001);
    mesh.renderOrder = 2 + tileId.z;
    mesh.frustumCulled = false;
    mesh.visible = false;

    this._root.add(mesh);

    return {
      tileId,
      mesh,
      texture: null,
      key,
      state: 'idle',
      attempts: 0,
      priority: Number.POSITIVE_INFINITY,
      lastWantedFrame: -1,
      lastTouchedFrame: this._frame,
      currentOpacity: 0,
      targetOpacity: 0,
      lastFadeUpdateMs: nowMs()
    };
  }

  private enqueueTileLoad(key: string): void {
    const tile = this._tiles.get(key);
    if (!tile) return;
    if (tile.state === 'loading' || tile.state === 'queued' || tile.state === 'ready') return;

    tile.state = 'queued';
    if (!this._queuedKeys.has(key)) {
      this._queuedKeys.add(key);
      this._loadQueue.push(key);
    }
  }

  private processLoadQueue(): void {
    while (this._inflightCount < this._maxConcurrentRequests && this._loadQueue.length > 0) {
      const nextIndex = this.pickBestQueueIndex();
      const key = this._loadQueue.splice(nextIndex, 1)[0];
      if (!key) break;
      this._queuedKeys.delete(key);

      const tile = this._tiles.get(key);
      if (!tile || tile.state !== 'queued') continue;
      this.startTileLoad(tile);
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

  private startTileLoad(tile: ActiveTile): void {
    tile.state = 'loading';
    tile.attempts += 1;
    const attempt = tile.attempts;
    this._inflightCount += 1;

    const url = this.buildUrl(tile.tileId);
    this._textureLoader.load(
      url,
      (texture) => {
        this._inflightCount = Math.max(0, this._inflightCount - 1);

        const current = this._tiles.get(tile.key);
        if (!current || current.attempts !== attempt) {
          texture.dispose();
          this.processLoadQueue();
          return;
        }

        texture.generateMipmaps = true;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.anisotropy = this._maxAnisotropy;
        texture.colorSpace = THREE.SRGBColorSpace;

        current.texture?.dispose();
        current.texture = texture;
        current.mesh.material.map = texture;
        current.mesh.material.color.setHex(0xffffff);
        current.mesh.material.needsUpdate = true;
        current.state = 'ready';

        this.processLoadQueue();
      },
      undefined,
      () => {
        this._inflightCount = Math.max(0, this._inflightCount - 1);

        const current = this._tiles.get(tile.key);
        if (!current || current.attempts !== attempt) {
          this.processLoadQueue();
          return;
        }

        current.state = 'error';
        if (current.attempts <= this._retryLimit) {
          current.state = 'idle';
          this.enqueueTileLoad(current.key);
        }

        this.processLoadQueue();
      }
    );
  }

  private evictTiles(wantedKeys: Set<string>): void {
    const staleKeys: string[] = [];

    for (const [key, tile] of this._tiles) {
      const age = this._frame - tile.lastWantedFrame;
      if (wantedKeys.has(key)) continue;
      if (tile.state === 'loading') continue;
      if (age > this._retainFrames) {
        staleKeys.push(key);
      }
    }

    for (const key of staleKeys) {
      const tile = this._tiles.get(key);
      if (!tile) continue;
      this.disposeTile(key, tile);
    }

    if (this._tiles.size <= this._maxCachedTiles) return;

    const evictCandidates = [...this._tiles.values()]
      .filter((tile) => !wantedKeys.has(tile.key) && tile.state !== 'loading')
      .sort((a, b) => a.lastTouchedFrame - b.lastTouchedFrame || b.priority - a.priority);

    for (const tile of evictCandidates) {
      if (this._tiles.size <= this._maxCachedTiles) break;
      this.disposeTile(tile.key, tile);
    }
  }

  private disposeTile(key: string, tile: ActiveTile): void {
    this._queuedKeys.delete(key);
    this._root.remove(tile.mesh);
    tile.mesh.geometry.dispose();
    tile.mesh.material.dispose();
    tile.texture?.dispose();
    this._tiles.delete(key);
  }

  private refreshDebugInfo(zoom: number, centerX: number, centerY: number, tileRadius: number): void {
    let loadingCount = 0;
    let readyCount = 0;
    let errorCount = 0;
    let renderedCount = 0;
    const renderedZoomStats = new Map<number, number>();

    for (const tile of this._tiles.values()) {
      if (tile.state === 'loading') loadingCount += 1;
      if (tile.state === 'ready') readyCount += 1;
      if (tile.state === 'error') errorCount += 1;
      if (tile.state === 'ready' && tile.mesh.visible && tile.currentOpacity > 0.001) {
        renderedCount += 1;
        renderedZoomStats.set(tile.tileId.z, (renderedZoomStats.get(tile.tileId.z) ?? 0) + 1);
      }
    }

    const renderedZoomStatsList = [...renderedZoomStats.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([zoomLevel, count]) => ({ zoom: zoomLevel, count }));

    this._debugInfo = {
      enabled: this._enabled,
      zoom,
      centerX,
      centerY,
      tileCount: this._tiles.size,
      tileRadius,
      queuedCount: this._loadQueue.length,
      loadingCount,
      readyCount,
      errorCount,
      requestedCount: this._requestedCount,
      renderedCount,
      renderedZoomStats: renderedZoomStatsList
    };
  }

  private buildUrl(tileId: TileId): string {
    const n = 2 ** tileId.z;
    const y = this._yType === 'tms' ? n - 1 - tileId.y : tileId.y;
    const subdomain = this.pickSubdomain(tileId);
    return this._urlTemplate
      .replace('{z}', String(tileId.z))
      .replace('{x}', String(tileId.x))
      .replace('{y}', String(y))
      .replace('{s}', subdomain);
  }

  private pickSubdomain(tileId: TileId): string {
    if (this._subdomains.length === 0) {
      return '';
    }
    const idx = Math.abs(tileId.x + tileId.y + tileId.z) % this._subdomains.length;
    return this._subdomains[idx] ?? '';
  }
}

function tileRectInWorld(
  geo: GeoCoordinator,
  tileId: TileId,
  originMercatorX: number,
  originMercatorY: number
): { centerX: number; centerY: number; width: number; height: number } {
  const nw = geo.tileToLonLat(tileId.x, tileId.y, tileId.z);
  const se = geo.tileToLonLat(tileId.x + 1, tileId.y + 1, tileId.z);

  const minMercator = geo.lonLatToWebMercator(nw.lon, se.lat);
  const maxMercator = geo.lonLatToWebMercator(se.lon, nw.lat);

  const widthMeters = Math.abs(maxMercator.x - minMercator.x);
  const heightMeters = Math.abs(maxMercator.y - minMercator.y);
  const centerMercatorX = (minMercator.x + maxMercator.x) * 0.5;
  const centerMercatorY = (minMercator.y + maxMercator.y) * 0.5;

  return {
    centerX: (centerMercatorX - originMercatorX) / geo.metersPerUnit,
    centerY: (centerMercatorY - originMercatorY) / geo.metersPerUnit,
    width: widthMeters / geo.metersPerUnit,
    height: heightMeters / geo.metersPerUnit
  };
}

function tileKey(tileId: TileId): string {
  return `${tileId.z}/${tileId.x}/${tileId.y}`;
}

function wrapInt(value: number, range: number): number {
  return ((value % range) + range) % range;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function shortestTileDx(centerX: number, tileX: number, n: number): number {
  const raw = Math.abs(tileX - centerX);
  return Math.min(raw, n - raw);
}

function sanitizeViewportBounds(bounds: ViewportWorldBounds | null): ViewportWorldBounds | null {
  if (!bounds) return null;
  if (
    !Number.isFinite(bounds.minX) ||
    !Number.isFinite(bounds.minY) ||
    !Number.isFinite(bounds.maxX) ||
    !Number.isFinite(bounds.maxY)
  ) {
    return null;
  }
  if (bounds.maxX <= bounds.minX || bounds.maxY <= bounds.minY) {
    return null;
  }
  return bounds;
}

function normalizeLodLevels(levels: readonly TileLodLevel[] | undefined): readonly TileLodLevel[] {
  if (!levels || levels.length === 0) return [];
  const out = levels
    .filter((level) => Number.isInteger(level.zoom) && level.zoom >= 0 && level.zoom <= 22)
    .map((level) => ({
      zoom: Math.floor(level.zoom),
      maxTiles: level.maxTiles,
      marginTiles: level.marginTiles,
      updateThrottleMs: level.updateThrottleMs,
      zoomThrottleMs: level.zoomThrottleMs,
      immediateTileShift: level.immediateTileShift
    }));
  out.sort((a, b) => b.zoom - a.zoom);
  return out;
}

function mercatorBoundsToTileRange(
  minMercatorX: number,
  minMercatorY: number,
  maxMercatorX: number,
  maxMercatorY: number,
  zoom: number,
  marginTiles: number
): { minXRaw: number; maxXRaw: number; minY: number; maxY: number } | null {
  if (
    !Number.isFinite(minMercatorX) ||
    !Number.isFinite(minMercatorY) ||
    !Number.isFinite(maxMercatorX) ||
    !Number.isFinite(maxMercatorY)
  ) {
    return null;
  }

  const n = 2 ** zoom;
  const tileSize = WEB_MERCATOR_WORLD_SIZE / n;
  const clampedMinY = Math.max(-WEB_MERCATOR_HALF_WORLD, Math.min(WEB_MERCATOR_HALF_WORLD, minMercatorY));
  const clampedMaxY = Math.max(-WEB_MERCATOR_HALF_WORLD, Math.min(WEB_MERCATOR_HALF_WORLD, maxMercatorY));

  const minXRaw = Math.floor((minMercatorX + WEB_MERCATOR_HALF_WORLD) / tileSize) - marginTiles;
  const maxXRaw = Math.floor((maxMercatorX + WEB_MERCATOR_HALF_WORLD) / tileSize) + marginTiles;
  const minY = clampInt(
    Math.floor((WEB_MERCATOR_HALF_WORLD - clampedMaxY) / tileSize) - marginTiles,
    0,
    n - 1
  );
  const maxY = clampInt(
    Math.floor((WEB_MERCATOR_HALF_WORLD - clampedMinY) / tileSize) + marginTiles,
    0,
    n - 1
  );

  if (maxY < minY) return null;
  return { minXRaw, maxXRaw, minY, maxY };
}

function upsertLineLoop(
  root: THREE.Group,
  existing: THREE.LineLoop<THREE.BufferGeometry, THREE.LineBasicMaterial> | null,
  positions: Float32Array,
  color: number,
  opacity: number,
  renderOrder: number
): THREE.LineLoop<THREE.BufferGeometry, THREE.LineBasicMaterial> {
  if (!existing) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({
      color,
      transparent: opacity < 0.999,
      opacity,
      depthWrite: false,
      depthTest: false
    });
    const line = new THREE.LineLoop(geometry, material);
    line.frustumCulled = false;
    line.renderOrder = renderOrder;
    root.add(line);
    return line;
  }

  existing.geometry.dispose();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  existing.geometry = geometry;
  existing.material.color.setHex(color);
  existing.material.opacity = opacity;
  existing.material.transparent = opacity < 0.999;
  existing.renderOrder = renderOrder;
  existing.visible = true;
  return existing;
}

function upsertLineSegments(
  root: THREE.Group,
  existing: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> | null,
  positions: Float32Array,
  color: number,
  opacity: number,
  renderOrder: number
): THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> {
  if (!existing) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({
      color,
      transparent: opacity < 0.999,
      opacity,
      depthWrite: false,
      depthTest: false
    });
    const line = new THREE.LineSegments(geometry, material);
    line.frustumCulled = false;
    line.renderOrder = renderOrder;
    root.add(line);
    return line;
  }

  existing.geometry.dispose();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  existing.geometry = geometry;
  existing.material.color.setHex(color);
  existing.material.opacity = opacity;
  existing.material.transparent = opacity < 0.999;
  existing.renderOrder = renderOrder;
  existing.visible = true;
  return existing;
}

function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function normalizeSubdomains(input: readonly string[] | string | undefined): readonly string[] {
  if (Array.isArray(input)) {
    const out = input.map((x) => String(x).trim()).filter((x) => x.length > 0);
    return out.length > 0 ? out : DEFAULT_SUBDOMAINS;
  }

  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      return DEFAULT_SUBDOMAINS;
    }
    const rangeMatch = /^(\d+)\s*-\s*(\d+)$/.exec(trimmed);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (Number.isInteger(start) && Number.isInteger(end) && end >= start) {
        const out: string[] = [];
        for (let i = start; i <= end; i += 1) out.push(String(i));
        return out.length > 0 ? out : DEFAULT_SUBDOMAINS;
      }
    }
    const split = trimmed
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
    if (split.length > 0) {
      return split;
    }
    if (trimmed.length > 1) {
      return trimmed.split('');
    }
    return [trimmed];
  }

  return DEFAULT_SUBDOMAINS;
}
