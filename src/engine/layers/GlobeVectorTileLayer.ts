import * as THREE from 'three';
import { PbfReader as Pbf } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import type { GeoCoordinator } from '../../geo/coords';

export type VectorTileStyle = {
  fillColor?: number;
  lineColor?: number;
  pointColor?: number;
  fillOpacity?: number;
  lineWidth?: number;
  pointSize?: number;
  layerFilter?: string[];
};

export type GlobeVectorTileLayerOptions = {
  enabled?: boolean;
  urlTemplate: string;
  yType?: 'xyz' | 'tms';
  minZoom?: number;
  maxZoom?: number;
  style?: VectorTileStyle;
  surfaceOffsetMeters?: number;
  maxConcurrentRequests?: number;
  maxCachedTiles?: number;
  retainFrames?: number;
  retryLimit?: number;
};

export type GlobeVectorTileLayerDebugInfo = {
  enabled: boolean;
  zoom: number;
  tileCount: number;
  featureCount: number;
  loadedTiles: number;
  errorCount: number;
};

type TileId = {
  x: number;
  y: number;
  z: number;
};

type VtTile = {
  tileId: TileId;
  key: string;
  state: 'idle' | 'loading' | 'ready' | 'error';
  attempts: number;
  lastWantedFrame: number;
  group: THREE.Group | null;
  featureCount: number;
};

const DEFAULT_STYLE: Required<VectorTileStyle> = {
  fillColor: 0x3388ff,
  lineColor: 0xffffff,
  pointColor: 0xff4444,
  fillOpacity: 0.3,
  lineWidth: 2,
  pointSize: 4,
  layerFilter: []
};

export class GlobeVectorTileLayer {
  private readonly _root = new THREE.Group();
  private readonly _geo: GeoCoordinator;
  private readonly _urlTemplate: string;
  private readonly _yType: 'xyz' | 'tms';
  private readonly _minZoom: number;
  private readonly _maxZoom: number;
  private readonly _style: Required<VectorTileStyle>;
  private readonly _surfaceOffsetMeters: number;
  private readonly _maxConcurrentRequests: number;
  private readonly _maxCachedTiles: number;
  private readonly _retainFrames: number;
  private readonly _retryLimit: number;

  private readonly _tiles = new Map<string, VtTile>();
  private _loadQueue: string[] = [];
  private _inflight = 0;
  private _frame = 0;
  private _enabled = false;
  private _disposed = false;
  private _debugInfo: GlobeVectorTileLayerDebugInfo;

  constructor(geo: GeoCoordinator, options: GlobeVectorTileLayerOptions) {
    this._geo = geo;
    this._urlTemplate = options.urlTemplate;
    this._yType = options.yType ?? 'xyz';
    this._minZoom = Math.max(0, Math.floor(options.minZoom ?? 0));
    this._maxZoom = Math.max(this._minZoom, Math.floor(options.maxZoom ?? 22));
    this._style = { ...DEFAULT_STYLE, ...options.style };
    this._surfaceOffsetMeters = Math.max(0, Number(options.surfaceOffsetMeters ?? 80));
    this._maxConcurrentRequests = Math.max(1, Math.floor(options.maxConcurrentRequests ?? 8));
    this._maxCachedTiles = Math.max(16, Math.floor(options.maxCachedTiles ?? 400));
    this._retainFrames = Math.max(0, Math.floor(options.retainFrames ?? 75));
    this._retryLimit = Math.max(0, Math.floor(options.retryLimit ?? 2));

    this._enabled = options.enabled ?? true;
    this._root.visible = this._enabled;
    this._debugInfo = {
      enabled: this._enabled,
      zoom: this._minZoom,
      tileCount: 0,
      featureCount: 0,
      loadedTiles: 0,
      errorCount: 0
    };
  }

  get object3d(): THREE.Object3D {
    return this._root;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  get debugInfo(): GlobeVectorTileLayerDebugInfo {
    return { ...this._debugInfo };
  }

  setEnabled(enabled: boolean): void {
    if (this._disposed) return;
    this._enabled = enabled;
    this._root.visible = enabled;
    this._debugInfo = { ...this._debugInfo, enabled };
  }

  update(focusLon: number, focusLat: number, cameraDistance: number): void {
    if (this._disposed || !this._enabled) return;

    this._frame += 1;
    const safeLon = normalizeLon(focusLon);
    const safeLat = clampNumber(focusLat, -85.05112878, 85.05112878);
    const zoom = this.pickZoom(cameraDistance);
    const centerTile = this._geo.lonLatToTile(safeLon, safeLat, zoom);
    const radius = 8;

    const desired: Array<{ tileId: TileId }> = [];
    const n = 2 ** zoom;
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        const y = centerTile.y + dy;
        if (y < 0 || y >= n) continue;
        const x = wrapInt(centerTile.x + dx, n);
        desired.push({ tileId: { x, y, z: zoom } });
      }
    }

    const wantedKeys = new Set<string>();
    for (const d of desired) {
      const key = tileKey(d.tileId);
      wantedKeys.add(key);
      let tile = this._tiles.get(key);
      if (!tile) {
        tile = {
          tileId: d.tileId,
          key,
          state: 'idle',
          attempts: 0,
          lastWantedFrame: this._frame,
          group: null,
          featureCount: 0
        };
        this._tiles.set(key, tile);
      }
      tile.lastWantedFrame = this._frame;
      if (tile.state === 'idle' || (tile.state === 'error' && tile.attempts <= this._retryLimit)) {
        this.enqueue(tile.key);
      }
    }

    this.evict(wantedKeys);
    this.processQueue();
    this.refreshDebugInfo(zoom);
  }

  dispose(): void {
    this._disposed = true;
    this._loadQueue = [];
    for (const tile of this._tiles.values()) {
      if (tile.group) {
        this._root.remove(tile.group);
      }
    }
    this._tiles.clear();
  }

  private pickZoom(cameraHeight: number): number {
    const d = Math.max(0.05, Number(cameraHeight) || 0.05);
    const visibleMeters = 2 * d * Math.tan(Math.PI / 6);
    const metersPerPixel = visibleMeters / 768;
    const zoom = Math.round(Math.log2(156543.03392804097 / Math.max(1e-9, metersPerPixel)));
    return clampInt(zoom - 1, this._minZoom, this._maxZoom);
  }

  private enqueue(key: string): void {
    const tile = this._tiles.get(key);
    if (!tile) return;
    if (tile.state === 'loading' || tile.state === 'ready') return;
    tile.state = 'loading';
    this._loadQueue.push(key);
  }

  private processQueue(): void {
    while (this._inflight < this._maxConcurrentRequests && this._loadQueue.length > 0) {
      const key = this._loadQueue.shift()!;
      const tile = this._tiles.get(key);
      if (!tile || tile.state !== 'loading') continue;
      this.startLoad(tile);
    }
  }

  private startLoad(tile: VtTile): void {
    const attempt = tile.attempts;
    tile.attempts += 1;
    this._inflight += 1;

    const url = this.buildUrl(tile.tileId);

    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then((buffer) => {
        this._inflight = Math.max(0, this._inflight - 1);
        const current = this._tiles.get(tile.key);
        if (!current || current.attempts !== attempt || this._disposed) {
          this.processQueue();
          return;
        }
        this.parseAndRender(current, buffer);
        this.processQueue();
      })
      .catch(() => {
        this._inflight = Math.max(0, this._inflight - 1);
        const current = this._tiles.get(tile.key);
        if (current && current.attempts === attempt) {
          current.state = 'error';
        }
        this.processQueue();
      });
  }

  private parseAndRender(tile: VtTile, buffer: ArrayBuffer): void {
    try {
      const pbf = new Pbf(new Uint8Array(buffer));
      const vt = new VectorTile(pbf);
      const nw = this._geo.tileToLonLat(tile.tileId.x, tile.tileId.y, tile.tileId.z);
      const se = this._geo.tileToLonLat(tile.tileId.x + 1, tile.tileId.y + 1, tile.tileId.z);

      const westLon = nw.lon;
      const eastLon = se.lon;
      let northLat = nw.lat;
      let southLat = se.lat;

      if (tile.tileId.y === 0) northLat = Math.min(northLat, 85.0511);
      if (tile.tileId.y >= (1 << tile.tileId.z) - 1) southLat = Math.max(southLat, -85.0511);

      const group = new THREE.Group();
      let totalFeatures = 0;

      const layerNames = Object.keys(vt.layers);
      for (const layerName of layerNames) {
        if (this._style.layerFilter.length > 0 && !this._style.layerFilter.includes(layerName)) continue;
        const layer = vt.layers[layerName];
        if (!layer) continue;
        const extent = layer.extent ?? 4096;
        const featureCount = layer.length ?? 0;

        for (let fi = 0; fi < featureCount; fi += 1) {
          const feature = layer.feature(fi);
          if (!feature) continue;
          const geomType = feature.type ?? 0;
          const coords = feature.loadGeometry();

          if (geomType === 1) {
            this.renderPoints(group, coords, westLon, eastLon, northLat, southLat, extent);
            totalFeatures += 1;
          } else if (geomType === 2) {
            this.renderLines(group, coords, westLon, eastLon, northLat, southLat, extent);
            totalFeatures += 1;
          } else if (geomType === 3) {
            this.renderPolygons(group, coords, westLon, eastLon, northLat, southLat, extent);
            totalFeatures += 1;
          }
        }
      }

      if (tile.group) {
        this._root.remove(tile.group);
        disposeGroup(tile.group);
      }
      tile.group = group;
      tile.featureCount = totalFeatures;
      tile.state = 'ready';
      this._root.add(group);
    } catch {
      tile.state = 'error';
    }
  }

  private tileCoordToLonLat(
    mx: number,
    my: number,
    extent: number,
    westLon: number,
    eastLon: number,
    northLat: number,
    southLat: number
  ): { lon: number; lat: number } {
    const lon = westLon + (mx / extent) * (eastLon - westLon);
    const lat = northLat + (my / extent) * (southLat - northLat);
    return { lon, lat };
  }

  private renderPoints(
    group: THREE.Group,
    coords: Array<Array<{ x: number; y: number }>>,
    westLon: number,
    eastLon: number,
    northLat: number,
    southLat: number,
    extent: number
  ): void {
    const positions: number[] = [];
    for (const ring of coords) {
      for (const pt of ring) {
        const ll = this.tileCoordToLonLat(pt.x, pt.y, extent, westLon, eastLon, northLat, southLat);
        const p = this._geo.wgs84ToThree(ll.lat, ll.lon, this._surfaceOffsetMeters);
        positions.push(p.x, p.y, p.z);
      }
    }
    if (positions.length === 0) return;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    const mat = new THREE.PointsMaterial({
      color: this._style.pointColor,
      size: this._style.pointSize,
      sizeAttenuation: true
    });
    const mesh = new THREE.Points(geom, mat);
    mesh.renderOrder = 5;
    group.add(mesh);
  }

  private renderLines(
    group: THREE.Group,
    coords: Array<Array<{ x: number; y: number }>>,
    westLon: number,
    eastLon: number,
    northLat: number,
    southLat: number,
    extent: number
  ): void {
    for (const ring of coords) {
      if (ring.length < 2) continue;
      const positions: number[] = [];
      for (const pt of ring) {
        const ll = this.tileCoordToLonLat(pt.x, pt.y, extent, westLon, eastLon, northLat, southLat);
        const p = this._geo.wgs84ToThree(ll.lat, ll.lon, this._surfaceOffsetMeters);
        positions.push(p.x, p.y, p.z);
      }
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
      const mat = new THREE.LineBasicMaterial({
        color: this._style.lineColor,
        linewidth: this._style.lineWidth
      });
      const line = new THREE.Line(geom, mat);
      line.renderOrder = 5;
      group.add(line);
    }
  }

  private renderPolygons(
    group: THREE.Group,
    coords: Array<Array<{ x: number; y: number }>>,
    westLon: number,
    eastLon: number,
    northLat: number,
    southLat: number,
    extent: number
  ): void {
    for (const ring of coords) {
      if (ring.length < 3) continue;
      const pts: number[] = [];
      for (const pt of ring) {
        const ll = this.tileCoordToLonLat(pt.x, pt.y, extent, westLon, eastLon, northLat, southLat);
        const p = this._geo.wgs84ToThree(ll.lat, ll.lon, this._surfaceOffsetMeters);
        pts.push(p.x, p.y, p.z);
      }

      if (pts.length >= 12) {
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
        const indices = fanTriangulate(pts);
        if (indices.length >= 3) {
          geom.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
          geom.computeVertexNormals();
          const mat = new THREE.MeshBasicMaterial({
            color: this._style.fillColor,
            transparent: this._style.fillOpacity < 0.999,
            opacity: this._style.fillOpacity,
            side: THREE.DoubleSide,
            depthWrite: false
          });
          const mesh = new THREE.Mesh(geom, mat);
          mesh.renderOrder = 4;
          group.add(mesh);
        }
      }

      const outlineGeom = new THREE.BufferGeometry();
      outlineGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
      const outlineMat = new THREE.LineBasicMaterial({
        color: this._style.lineColor,
        linewidth: this._style.lineWidth
      });
      const outline = new THREE.LineLoop(outlineGeom, outlineMat);
      outline.renderOrder = 5;
      group.add(outline);
    }
  }

  private buildUrl(tileId: TileId): string {
    const n = 2 ** tileId.z;
    const y = this._yType === 'tms' ? n - 1 - tileId.y : tileId.y;
    return this._urlTemplate
      .replace('{z}', String(tileId.z))
      .replace('{x}', String(tileId.x))
      .replace('{y}', String(y));
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
      this.disposeTile(key);
    }
    if (this._tiles.size <= this._maxCachedTiles) return;
    const candidates = [...this._tiles.values()]
      .filter((tile) => !wantedKeys.has(tile.key) && tile.state !== 'loading')
      .sort((a, b) => a.lastWantedFrame - b.lastWantedFrame);
    for (const tile of candidates) {
      if (this._tiles.size <= this._maxCachedTiles) break;
      this.disposeTile(tile.key);
    }
  }

  private disposeTile(key: string): void {
    const tile = this._tiles.get(key);
    if (!tile) return;
    if (tile.group) {
      this._root.remove(tile.group);
      disposeGroup(tile.group);
    }
    this._tiles.delete(key);
  }

  private refreshDebugInfo(zoom: number): void {
    let loaded = 0;
    let errors = 0;
    let features = 0;
    for (const tile of this._tiles.values()) {
      if (tile.state === 'ready') {
        loaded += 1;
        features += tile.featureCount;
      } else if (tile.state === 'error') {
        errors += 1;
      }
    }
    this._debugInfo = {
      enabled: this._enabled,
      zoom,
      tileCount: this._tiles.size,
      featureCount: features,
      loadedTiles: loaded,
      errorCount: errors
    };
  }
}

function disposeGroup(group: THREE.Group): void {
  group.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      if (Array.isArray(child.material)) {
        child.material.forEach((m) => m.dispose());
      } else {
        child.material.dispose();
      }
    } else if (child instanceof THREE.Points) {
      child.geometry.dispose();
      child.material.dispose();
    } else if (child instanceof THREE.Line || child instanceof THREE.LineLoop) {
      child.geometry.dispose();
      child.material.dispose();
    }
  });
}

function fanTriangulate(pts: number[]): number[] {
  const n = pts.length / 3;
  if (n < 3) return [];
  const indices: number[] = [];
  for (let i = 1; i < n - 1; i += 1) {
    indices.push(0, i, i + 1);
  }
  return indices;
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

function normalizeLon(lon: number): number {
  let out = lon % 360;
  if (out > 180) out -= 360;
  if (out <= -180) out += 360;
  return out;
}
