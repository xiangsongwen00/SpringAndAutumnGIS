import * as THREE from 'three';
import type { GeoCoordinator } from '../../geo/coords';
import {
  UrlTileProvider,
  tileKey,
  type TileCoord,
  type TileProvider,
  type TileYType
} from '../tiles/TileProvider';

export type GlobeLodGridOptions = {
  enabled?: boolean;
  minLevel?: number;
  maxLevel?: number;
  targetTilePixels?: number;
  collapseHysteresis?: number;
  maxVisibleTiles?: number;
  tileSegments?: number;
  maxTileSegments?: number;
  surfaceOffsetMeters?: number;
  lineOffsetMeters?: number;
  horizonPaddingDeg?: number;
  fillOpacity?: number;
  gridOpacity?: number;
  showGrid?: boolean;
  imageryUrlTemplate?: string;
  imageryYType?: TileYType;
  imagerySubdomains?: readonly string[] | string;
  maxConcurrentRequests?: number;
  maxCachedTiles?: number;
  maxAnisotropy?: number;
};

export type GlobeLodGridDebugInfo = {
  enabled: boolean;
  selectedCount: number;
  testedCount: number;
  culledCount: number;
  triangleCount: number;
  geometryRebuilds: number;
  readyCount: number;
  loadingCount: number;
  queuedCount: number;
  errorCount: number;
  fallbackCount: number;
  levels: ReadonlyArray<{ level: number; count: number }>;
};

type TileSelection = {
  id: TileCoord;
  key: string;
  projectedPixels: number;
  canSplit: boolean;
};

type TextureState = 'queued' | 'loading' | 'ready' | 'error';

type TextureRecord = {
  id: TileCoord;
  key: string;
  state: TextureState;
  priority: number;
  lastUsedFrame: number;
  texture: THREE.Texture | null;
};

type RenderTile = {
  id: TileCoord;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  sourceKey: string;
};

const DEFAULT_IMAGERY_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const WGS84_FLATTENING = 1 / 298.257223563;

/**
 * A screen-space-error quadtree whose nodes are Web Mercator XYZ tiles.
 * Geometry is projected onto the WGS84 ellipsoid; only selected leaf nodes render.
 */
export class GlobeLodGrid {
  private readonly _root = new THREE.Group();
  private readonly _surfaceGroup = new THREE.Group();
  private readonly _lineGeometry = new THREE.BufferGeometry();
  private readonly _lineMaterial: THREE.LineBasicMaterial;
  private readonly _lineSegments: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private readonly _placeholderMaterial: THREE.MeshBasicMaterial;
  private readonly _geo: GeoCoordinator;
  private readonly _provider: TileProvider;
  private readonly _textureLoader = new THREE.TextureLoader();
  private readonly _earthRadius: number;
  private readonly _horizonRadius: number;
  private readonly _minLevel: number;
  private readonly _maxLevel: number;
  private readonly _targetTilePixels: number;
  private readonly _collapseHysteresis: number;
  private readonly _maxVisibleTiles: number;
  private readonly _tileSegments: number;
  private readonly _maxTileSegments: number;
  private readonly _surfaceOffsetMeters: number;
  private readonly _lineOffsetMeters: number;
  private readonly _horizonPaddingRad: number;
  private readonly _fillOpacity: number;
  private readonly _maxConcurrentRequests: number;
  private readonly _maxCachedTiles: number;
  private readonly _maxAnisotropy: number;
  private readonly _frustum = new THREE.Frustum();
  private readonly _projectionView = new THREE.Matrix4();
  private readonly _cameraLocal = new THREE.Vector3();
  private readonly _cameraDirection = new THREE.Vector3();
  private readonly _tileDirection = new THREE.Vector3();
  private readonly _cornerDirection = new THREE.Vector3();
  private readonly _tileCenter = new THREE.Vector3();
  private readonly _surfaceCenter = new THREE.Vector3();
  private readonly _worldCenter = new THREE.Vector3();
  private readonly _worldScale = new THREE.Vector3();
  private readonly _boundingSphere = new THREE.Sphere();
  private readonly _previousExpanded = new Set<string>();
  private readonly _textures = new Map<string, TextureRecord>();
  private readonly _renderTiles = new Map<string, RenderTile>();

  private _enabled: boolean;
  private _disposed = false;
  private _selectionSignature = '';
  private _geometryRebuilds = 0;
  private _triangleCount = 0;
  private _activeRequests = 0;
  private _frame = 0;
  private _fallbackCount = 0;
  private _debugInfo: GlobeLodGridDebugInfo;

  constructor(geo: GeoCoordinator, options?: GlobeLodGridOptions) {
    this._geo = geo;
    this._earthRadius = geo.earthRadiusInThreeUnits();
    this._horizonRadius = this._earthRadius * (1 - WGS84_FLATTENING);
    this._minLevel = clampInt(options?.minLevel ?? 1, 0, 12);
    this._maxLevel = clampInt(options?.maxLevel ?? 6, this._minLevel, 12);
    this._targetTilePixels = Math.max(48, Number(options?.targetTilePixels ?? 220));
    this._collapseHysteresis = clampNumber(options?.collapseHysteresis ?? 0.72, 0.25, 0.95);
    this._maxVisibleTiles = Math.max(16, Math.floor(options?.maxVisibleTiles ?? 192));
    this._tileSegments = clampInt(options?.tileSegments ?? 6, 1, 24);
    this._maxTileSegments = clampInt(options?.maxTileSegments ?? 32, this._tileSegments, 64);
    this._surfaceOffsetMeters = Number(options?.surfaceOffsetMeters ?? 30);
    this._lineOffsetMeters = Math.max(
      this._surfaceOffsetMeters,
      Number(options?.lineOffsetMeters ?? this._surfaceOffsetMeters + 120)
    );
    this._horizonPaddingRad = THREE.MathUtils.degToRad(
      clampNumber(options?.horizonPaddingDeg ?? 1.5, 0, 15)
    );
    this._fillOpacity = clampNumber(options?.fillOpacity ?? 1, 0, 1);
    this._maxConcurrentRequests = clampInt(options?.maxConcurrentRequests ?? 8, 1, 24);
    this._maxCachedTiles = Math.max(32, Math.floor(options?.maxCachedTiles ?? 384));
    this._maxAnisotropy = Math.max(1, Math.floor(options?.maxAnisotropy ?? 1));
    this._enabled = options?.enabled ?? true;

    this._provider = new UrlTileProvider({
      id: 'globe-lod-imagery',
      urlTemplate: options?.imageryUrlTemplate ?? DEFAULT_IMAGERY_URL,
      minZoom: 0,
      maxZoom: this._maxLevel,
      yType: options?.imageryYType ?? 'xyz',
      subdomains: options?.imagerySubdomains ?? []
    });

    this._textureLoader.setCrossOrigin('anonymous');
    this._placeholderMaterial = new THREE.MeshBasicMaterial({
      color: 0x173947,
      transparent: this._fillOpacity < 0.999,
      opacity: this._fillOpacity,
      depthWrite: true,
      depthTest: true,
      side: THREE.FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1
    });
    this._lineMaterial = new THREE.LineBasicMaterial({
      color: 0x89edf2,
      transparent: true,
      opacity: clampNumber(options?.gridOpacity ?? 0.5, 0, 1),
      depthWrite: false,
      depthTest: true
    });
    this._lineSegments = new THREE.LineSegments(this._lineGeometry, this._lineMaterial);
    this._lineSegments.frustumCulled = false;
    this._lineSegments.renderOrder = 2;
    this._lineSegments.visible = options?.showGrid ?? true;
    this._surfaceGroup.renderOrder = 1;
    this._root.add(this._surfaceGroup, this._lineSegments);
    this._root.visible = this._enabled;

    this._debugInfo = this.createDebugInfo();
  }

  get object3d(): THREE.Object3D {
    return this._root;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  get debugInfo(): GlobeLodGridDebugInfo {
    return {
      ...this._debugInfo,
      levels: this._debugInfo.levels.map((item) => ({ ...item }))
    };
  }

  setEnabled(enabled: boolean): void {
    if (this._disposed) return;
    this._enabled = enabled;
    this._root.visible = enabled;
    this._debugInfo = { ...this._debugInfo, enabled };
  }

  update(camera: THREE.PerspectiveCamera, viewportHeight: number): void {
    if (this._disposed || !this._enabled) return;
    this._frame += 1;

    camera.updateMatrixWorld();
    this._root.updateWorldMatrix(true, false);
    this._projectionView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._projectionView);
    camera.getWorldPosition(this._cameraLocal);
    this._root.worldToLocal(this._cameraLocal);
    this._cameraDirection.copy(this._cameraLocal).normalize();
    this._root.getWorldScale(this._worldScale);

    const counters = { tested: 0, culled: 0 };
    const focalPixels = Math.max(1, viewportHeight) /
      (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5));
    const rootId: TileCoord = { z: 0, x: 0, y: 0 };
    const root = this.evaluateTile(rootId, focalPixels, counters);
    const leaves: TileSelection[] = root ? [root] : [];
    const nextExpanded = new Set<string>();

    while (leaves.length < this._maxVisibleTiles) {
      let bestIndex = -1;
      let bestScore = 1;
      for (let i = 0; i < leaves.length; i += 1) {
        const leaf = leaves[i];
        if (!leaf || !leaf.canSplit || leaf.id.z >= this._maxLevel) continue;
        const threshold = this._previousExpanded.has(leaf.key)
          ? this._targetTilePixels * this._collapseHysteresis
          : this._targetTilePixels;
        const score = leaf.id.z < this._minLevel
          ? Number.POSITIVE_INFINITY
          : leaf.projectedPixels / threshold;
        if (score > bestScore) {
          bestScore = score;
          bestIndex = i;
        }
      }

      if (bestIndex < 0) break;
      const parent = leaves[bestIndex];
      if (!parent) break;
      const children = this.evaluateChildren(parent.id, focalPixels, counters);
      const nextCount = leaves.length - 1 + children.length;
      if (children.length === 0 || nextCount > this._maxVisibleTiles) {
        parent.canSplit = false;
        continue;
      }
      leaves.splice(bestIndex, 1, ...children);
      nextExpanded.add(parent.key);
    }

    leaves.sort(compareSelection);
    this._previousExpanded.clear();
    for (const key of nextExpanded) this._previousExpanded.add(key);

    const signature = leaves.map((leaf) => leaf.key).join('|');
    if (signature !== this._selectionSignature) {
      this._selectionSignature = signature;
      this.rebuildSelection(leaves);
    }

    this.requestSelectionTextures(leaves);
    this.pumpTextureQueue();
    this.syncTileMaterials(leaves);
    this.evictTextures();
    this.updateDebugInfo(leaves, counters);
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    for (const tile of this._renderTiles.values()) this.disposeRenderTile(tile);
    for (const record of this._textures.values()) record.texture?.dispose();
    this._renderTiles.clear();
    this._textures.clear();
    this._lineGeometry.dispose();
    this._lineMaterial.dispose();
    this._placeholderMaterial.dispose();
    this._root.clear();
    this._previousExpanded.clear();
  }

  private evaluateChildren(
    parent: TileCoord,
    focalPixels: number,
    counters: { tested: number; culled: number }
  ): TileSelection[] {
    const z = parent.z + 1;
    const x = parent.x * 2;
    const y = parent.y * 2;
    const candidates: TileCoord[] = [
      { z, x, y },
      { z, x: x + 1, y },
      { z, x, y: y + 1 },
      { z, x: x + 1, y: y + 1 }
    ];
    const visible: TileSelection[] = [];
    for (const child of candidates) {
      const selection = this.evaluateTile(child, focalPixels, counters);
      if (selection) visible.push(selection);
    }
    return visible;
  }

  private evaluateTile(
    id: TileCoord,
    focalPixels: number,
    counters: { tested: number; culled: number }
  ): TileSelection | null {
    counters.tested += 1;
    const bounds = tileBounds(this._geo, id);
    const center = this._geo.tileToLonLat(id.x + 0.5, id.y + 0.5, id.z);
    this.setSurfaceDirection(center.lon, center.lat, this._tileDirection);
    const angularRadius = this.tileAngularRadius(bounds, this._tileDirection);
    const capCenterDistance = this._earthRadius * Math.cos(angularRadius);
    const capRadius = this._earthRadius * Math.sin(angularRadius) +
      this._earthRadius * WGS84_FLATTENING;
    this._tileCenter.copy(this._tileDirection).multiplyScalar(capCenterDistance);

    // z0/z1 cover more than a hemisphere; their cap bounds are intentionally conservative.
    if (id.z >= 2) {
      if (!this.isAboveHorizon(this._tileDirection, angularRadius)) {
        counters.culled += 1;
        return null;
      }
      this._worldCenter.copy(this._tileCenter).applyMatrix4(this._root.matrixWorld);
      const maxScale = Math.max(this._worldScale.x, this._worldScale.y, this._worldScale.z);
      this._boundingSphere.center.copy(this._worldCenter);
      this._boundingSphere.radius = capRadius * maxScale;
      if (!this._frustum.intersectsSphere(this._boundingSphere)) {
        counters.culled += 1;
        return null;
      }
    }

    this._surfaceCenter.copy(this._tileDirection).multiplyScalar(this._earthRadius);
    const cameraDistance = Math.max(
      1,
      this._cameraLocal.distanceTo(this._surfaceCenter) - capRadius * 0.35
    );
    const projectedPixels =
      (2 * this._earthRadius * Math.sin(Math.min(angularRadius, Math.PI * 0.5)) * focalPixels) /
      cameraDistance;

    return { id, key: tileKey(id), projectedPixels, canSplit: true };
  }

  private setSurfaceDirection(lon: number, lat: number, target: THREE.Vector3): void {
    const point = this._geo.wgs84ToThree(lat, lon, 0);
    target.set(point.x, point.y, point.z).normalize();
  }

  private tileAngularRadius(
    bounds: ReturnType<typeof tileBounds>,
    centerDirection: THREE.Vector3
  ): number {
    let maxAngle = 0;
    const corners: readonly [number, number][] = [
      [bounds.west, bounds.north],
      [bounds.east, bounds.north],
      [bounds.east, bounds.south],
      [bounds.west, bounds.south]
    ];
    for (const [lon, lat] of corners) {
      this.setSurfaceDirection(lon, lat, this._cornerDirection);
      maxAngle = Math.max(
        maxAngle,
        Math.acos(clampNumber(centerDirection.dot(this._cornerDirection), -1, 1))
      );
    }
    return Math.min(Math.PI, maxAngle);
  }

  private isAboveHorizon(direction: THREE.Vector3, angularRadius: number): boolean {
    const cameraDistance = this._cameraLocal.length();
    if (cameraDistance <= this._horizonRadius) return true;
    const horizonAngle = Math.acos(clampNumber(this._horizonRadius / cameraDistance, -1, 1));
    const visibleAngle = Math.min(Math.PI, horizonAngle + angularRadius + this._horizonPaddingRad);
    return this._cameraDirection.dot(direction) >= Math.cos(visibleAngle);
  }

  private rebuildSelection(selection: readonly TileSelection[]): void {
    const selectedKeys = new Set(selection.map((leaf) => leaf.key));
    for (const [key, tile] of this._renderTiles) {
      if (selectedKeys.has(key)) continue;
      this.disposeRenderTile(tile);
      this._renderTiles.delete(key);
    }

    let triangleCount = 0;
    const linePositions: number[] = [];
    for (const leaf of selection) {
      let renderTile = this._renderTiles.get(leaf.key);
      if (!renderTile) {
        const geometry = this.createTileGeometry(leaf.id);
        const material = this._placeholderMaterial.clone();
        const mesh = new THREE.Mesh(geometry, material);
        mesh.frustumCulled = false;
        mesh.renderOrder = 1;
        renderTile = { id: leaf.id, mesh, sourceKey: '' };
        this._renderTiles.set(leaf.key, renderTile);
        this._surfaceGroup.add(mesh);
      }
      const segments = this.segmentsForLevel(leaf.id.z);
      triangleCount += segments * segments * 2;
      this.appendTileEdges(leaf.id, segments, linePositions);
    }

    this._lineGeometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(linePositions, 3)
    );
    this._lineGeometry.computeBoundingSphere();
    this._triangleCount = triangleCount;
    this._geometryRebuilds += 1;
  }

  private createTileGeometry(id: TileCoord): THREE.BufferGeometry {
    const bounds = tileBounds(this._geo, id);
    const segments = this.segmentsForLevel(id.z);
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    for (let iy = 0; iy <= segments; iy += 1) {
      const lat = THREE.MathUtils.lerp(bounds.north, bounds.south, iy / segments);
      for (let ix = 0; ix <= segments; ix += 1) {
        const lon = THREE.MathUtils.lerp(bounds.west, bounds.east, ix / segments);
        this.appendSurfaceVertex(lon, lat, this._surfaceOffsetMeters, positions, normals);
        uvs.push(ix / segments, 1 - iy / segments);
      }
    }

    const columns = segments + 1;
    for (let iy = 0; iy < segments; iy += 1) {
      for (let ix = 0; ix < segments; ix += 1) {
        const a = iy * columns + ix;
        const b = a + 1;
        const c = a + columns;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();
    return geometry;
  }

  private appendSurfaceVertex(
    lon: number,
    lat: number,
    heightMeters: number,
    positions: number[],
    normals?: number[]
  ): void {
    const world = this._geo.wgs84ToThree(lat, lon, heightMeters);
    positions.push(world.x, world.y, world.z);
    if (normals) {
      this._cornerDirection.set(world.x, world.y, world.z).normalize();
      normals.push(this._cornerDirection.x, this._cornerDirection.y, this._cornerDirection.z);
    }
  }

  private appendTileEdges(id: TileCoord, segments: number, positions: number[]): void {
    const bounds = tileBounds(this._geo, id);
    this.appendCurvedEdge(bounds.west, bounds.north, bounds.east, bounds.north, segments, positions);
    this.appendCurvedEdge(bounds.east, bounds.north, bounds.east, bounds.south, segments, positions);
    this.appendCurvedEdge(bounds.east, bounds.south, bounds.west, bounds.south, segments, positions);
    this.appendCurvedEdge(bounds.west, bounds.south, bounds.west, bounds.north, segments, positions);
  }

  private appendCurvedEdge(
    lon0: number,
    lat0: number,
    lon1: number,
    lat1: number,
    segments: number,
    positions: number[]
  ): void {
    for (let i = 0; i < segments; i += 1) {
      const t0 = i / segments;
      const t1 = (i + 1) / segments;
      this.appendSurfaceVertex(
        THREE.MathUtils.lerp(lon0, lon1, t0),
        THREE.MathUtils.lerp(lat0, lat1, t0),
        this._lineOffsetMeters,
        positions
      );
      this.appendSurfaceVertex(
        THREE.MathUtils.lerp(lon0, lon1, t1),
        THREE.MathUtils.lerp(lat0, lat1, t1),
        this._lineOffsetMeters,
        positions
      );
    }
  }

  private segmentsForLevel(level: number): number {
    const curvatureBoost = 2 ** Math.max(0, 3 - level);
    return Math.min(this._maxTileSegments, this._tileSegments * curvatureBoost);
  }

  private requestSelectionTextures(selection: readonly TileSelection[]): void {
    for (let rank = 0; rank < selection.length; rank += 1) {
      const leaf = selection[rank];
      if (!leaf) continue;
      for (let z = 0; z <= leaf.id.z; z += 1) {
        const shift = leaf.id.z - z;
        const ancestor: TileCoord = {
          z,
          x: Math.floor(leaf.id.x / 2 ** shift),
          y: Math.floor(leaf.id.y / 2 ** shift)
        };
        this.queueTexture(ancestor, z * 10_000 + rank);
      }
    }
  }

  private queueTexture(id: TileCoord, priority: number): void {
    const key = tileKey(id);
    const existing = this._textures.get(key);
    if (existing) {
      existing.lastUsedFrame = this._frame;
      if (existing.state === 'queued') existing.priority = Math.min(existing.priority, priority);
      return;
    }
    this._textures.set(key, {
      id,
      key,
      state: 'queued',
      priority,
      lastUsedFrame: this._frame,
      texture: null
    });
  }

  private pumpTextureQueue(): void {
    while (this._activeRequests < this._maxConcurrentRequests) {
      let next: TextureRecord | null = null;
      for (const record of this._textures.values()) {
        if (record.state !== 'queued') continue;
        if (!next || record.priority < next.priority) next = record;
      }
      if (!next) return;
      this.loadTexture(next);
    }
  }

  private loadTexture(record: TextureRecord): void {
    record.state = 'loading';
    this._activeRequests += 1;
    this._textureLoader.load(
      this._provider.getTileUrl(record.id),
      (texture) => {
        this._activeRequests = Math.max(0, this._activeRequests - 1);
        if (this._disposed || !this._textures.has(record.key)) {
          texture.dispose();
          return;
        }
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.anisotropy = this._maxAnisotropy;
        record.texture = texture;
        record.state = 'ready';
        record.lastUsedFrame = this._frame;
        this.pumpTextureQueue();
      },
      undefined,
      () => {
        this._activeRequests = Math.max(0, this._activeRequests - 1);
        if (!this._disposed && this._textures.has(record.key)) record.state = 'error';
        this.pumpTextureQueue();
      }
    );
  }

  private syncTileMaterials(selection: readonly TileSelection[]): void {
    this._fallbackCount = 0;
    for (const leaf of selection) {
      const renderTile = this._renderTiles.get(leaf.key);
      if (!renderTile) continue;
      const source = this.findReadyTexture(leaf.id);
      const sourceKey = source?.key ?? '';
      if (source && source.id.z < leaf.id.z) this._fallbackCount += 1;
      if (renderTile.sourceKey === sourceKey) continue;

      renderTile.sourceKey = sourceKey;
      renderTile.mesh.material.map = source?.texture ?? null;
      renderTile.mesh.material.color.setHex(source ? 0xffffff : 0x173947);
      renderTile.mesh.material.needsUpdate = true;
      this.updateTileUvs(renderTile.mesh.geometry, leaf.id, source?.id ?? leaf.id);
    }
  }

  private findReadyTexture(id: TileCoord): TextureRecord | null {
    for (let z = id.z; z >= 0; z -= 1) {
      const shift = id.z - z;
      const key = tileKey({
        z,
        x: Math.floor(id.x / 2 ** shift),
        y: Math.floor(id.y / 2 ** shift)
      });
      const record = this._textures.get(key);
      if (record?.state === 'ready' && record.texture) {
        record.lastUsedFrame = this._frame;
        return record;
      }
    }
    return null;
  }

  private updateTileUvs(geometry: THREE.BufferGeometry, leaf: TileCoord, source: TileCoord): void {
    const segments = this.segmentsForLevel(leaf.z);
    const levels = leaf.z - source.z;
    const scale = 2 ** levels;
    const localX = leaf.x - source.x * scale;
    const localY = leaf.y - source.y * scale;
    const uv = geometry.getAttribute('uv') as THREE.BufferAttribute;
    let index = 0;
    for (let iy = 0; iy <= segments; iy += 1) {
      for (let ix = 0; ix <= segments; ix += 1) {
        const u = (localX + ix / segments) / scale;
        const xyzV = (localY + iy / segments) / scale;
        uv.setXY(index, u, 1 - xyzV);
        index += 1;
      }
    }
    uv.needsUpdate = true;
  }

  private evictTextures(): void {
    if (this._textures.size <= this._maxCachedTiles) return;
    const protectedKeys = new Set<string>();
    for (const tile of this._renderTiles.values()) {
      if (tile.sourceKey) protectedKeys.add(tile.sourceKey);
    }
    const candidates = [...this._textures.values()]
      .filter((record) => record.state !== 'loading' && !protectedKeys.has(record.key))
      .sort((a, b) => a.lastUsedFrame - b.lastUsedFrame);
    while (this._textures.size > this._maxCachedTiles) {
      const record = candidates.shift();
      if (!record) break;
      record.texture?.dispose();
      this._textures.delete(record.key);
    }
  }

  private disposeRenderTile(tile: RenderTile): void {
    this._surfaceGroup.remove(tile.mesh);
    tile.mesh.geometry.dispose();
    tile.mesh.material.dispose();
  }

  private updateDebugInfo(
    leaves: readonly TileSelection[],
    counters: { tested: number; culled: number }
  ): void {
    const levelCounts = new Map<number, number>();
    for (const leaf of leaves) {
      levelCounts.set(leaf.id.z, (levelCounts.get(leaf.id.z) ?? 0) + 1);
    }
    const states = { ready: 0, loading: 0, queued: 0, error: 0 };
    for (const record of this._textures.values()) states[record.state] += 1;
    this._debugInfo = {
      enabled: this._enabled,
      selectedCount: leaves.length,
      testedCount: counters.tested,
      culledCount: counters.culled,
      triangleCount: this._triangleCount,
      geometryRebuilds: this._geometryRebuilds,
      readyCount: states.ready,
      loadingCount: states.loading,
      queuedCount: states.queued,
      errorCount: states.error,
      fallbackCount: this._fallbackCount,
      levels: [...levelCounts.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([level, count]) => ({ level, count }))
    };
  }

  private createDebugInfo(): GlobeLodGridDebugInfo {
    return {
      enabled: this._enabled,
      selectedCount: 0,
      testedCount: 0,
      culledCount: 0,
      triangleCount: 0,
      geometryRebuilds: 0,
      readyCount: 0,
      loadingCount: 0,
      queuedCount: 0,
      errorCount: 0,
      fallbackCount: 0,
      levels: []
    };
  }
}

function tileBounds(
  geo: GeoCoordinator,
  id: TileCoord
): { west: number; east: number; north: number; south: number } {
  const northWest = geo.tileToLonLat(id.x, id.y, id.z);
  const southEast = geo.tileToLonLat(id.x + 1, id.y + 1, id.z);
  return {
    west: northWest.lon,
    east: southEast.lon,
    north: northWest.lat,
    south: southEast.lat
  };
}

function compareSelection(a: TileSelection, b: TileSelection): number {
  return a.id.z - b.id.z || a.id.y - b.id.y || a.id.x - b.id.x;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
