import * as THREE from 'three';
import type { GeoCoordinator } from '../../geo/coords';

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
};

export type GlobeLodGridDebugInfo = {
  enabled: boolean;
  selectedCount: number;
  testedCount: number;
  culledCount: number;
  triangleCount: number;
  geometryRebuilds: number;
  levels: ReadonlyArray<{ level: number; count: number }>;
};

type CubeFace = 0 | 1 | 2 | 3 | 4 | 5;

type GlobeTileId = {
  face: CubeFace;
  level: number;
  x: number;
  y: number;
};

type TileSelection = {
  id: GlobeTileId;
  key: string;
  projectedPixels: number;
  canSplit: boolean;
};

const ROOT_FACES: readonly CubeFace[] = [0, 1, 2, 3, 4, 5];
const WGS84_FLATTENING = 1 / 298.257223563;

export class GlobeLodGrid {
  private readonly _root = new THREE.Group();
  private readonly _surfaceGeometry = new THREE.BufferGeometry();
  private readonly _lineGeometry = new THREE.BufferGeometry();
  private readonly _surfaceMaterial: THREE.MeshStandardMaterial;
  private readonly _lineMaterial: THREE.LineBasicMaterial;
  private readonly _surfaceMesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  private readonly _lineSegments: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private readonly _geo: GeoCoordinator;
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
  private readonly _frustum = new THREE.Frustum();
  private readonly _projectionView = new THREE.Matrix4();
  private readonly _cameraLocal = new THREE.Vector3();
  private readonly _cameraDirection = new THREE.Vector3();
  private readonly _cubeDirection = new THREE.Vector3();
  private readonly _tileDirection = new THREE.Vector3();
  private readonly _tileCenter = new THREE.Vector3();
  private readonly _surfaceCenter = new THREE.Vector3();
  private readonly _worldCenter = new THREE.Vector3();
  private readonly _worldScale = new THREE.Vector3();
  private readonly _boundingSphere = new THREE.Sphere();
  private readonly _previousExpanded = new Set<string>();

  private _enabled: boolean;
  private _disposed = false;
  private _selectionSignature = '';
  private _geometryRebuilds = 0;
  private _triangleCount = 0;
  private _debugInfo: GlobeLodGridDebugInfo;

  constructor(geo: GeoCoordinator, options?: GlobeLodGridOptions) {
    this._geo = geo;
    this._earthRadius = geo.earthRadiusInThreeUnits();
    this._horizonRadius = this._earthRadius * (1 - WGS84_FLATTENING);
    this._minLevel = clampInt(options?.minLevel ?? 1, 0, 12);
    this._maxLevel = clampInt(options?.maxLevel ?? 9, this._minLevel, 12);
    this._targetTilePixels = Math.max(48, Number(options?.targetTilePixels ?? 180));
    this._collapseHysteresis = clampNumber(options?.collapseHysteresis ?? 0.72, 0.25, 0.95);
    this._maxVisibleTiles = Math.max(24, Math.floor(options?.maxVisibleTiles ?? 384));
    this._tileSegments = clampInt(options?.tileSegments ?? 4, 1, 16);
    this._maxTileSegments = clampInt(
      options?.maxTileSegments ?? 32,
      this._tileSegments,
      64
    );
    this._surfaceOffsetMeters = Number(options?.surfaceOffsetMeters ?? 30);
    this._lineOffsetMeters = Math.max(
      this._surfaceOffsetMeters,
      Number(options?.lineOffsetMeters ?? this._surfaceOffsetMeters + 120)
    );
    this._horizonPaddingRad = THREE.MathUtils.degToRad(
      clampNumber(options?.horizonPaddingDeg ?? 1.5, 0, 15)
    );
    this._enabled = options?.enabled ?? true;

    this._surfaceMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.92,
      metalness: 0,
      transparent: (options?.fillOpacity ?? 1) < 0.999,
      opacity: clampNumber(options?.fillOpacity ?? 1, 0, 1),
      depthWrite: true,
      depthTest: true,
      side: THREE.FrontSide
    });
    this._lineMaterial = new THREE.LineBasicMaterial({
      color: 0x7de7ee,
      transparent: true,
      opacity: clampNumber(options?.gridOpacity ?? 0.82, 0, 1),
      depthWrite: false,
      depthTest: true
    });

    this._surfaceMesh = new THREE.Mesh(this._surfaceGeometry, this._surfaceMaterial);
    this._surfaceMesh.frustumCulled = false;
    this._surfaceMesh.renderOrder = 1;
    this._lineSegments = new THREE.LineSegments(this._lineGeometry, this._lineMaterial);
    this._lineSegments.frustumCulled = false;
    this._lineSegments.renderOrder = 2;
    this._root.add(this._surfaceMesh, this._lineSegments);
    this._root.visible = this._enabled;

    this._debugInfo = {
      enabled: this._enabled,
      selectedCount: 0,
      testedCount: 0,
      culledCount: 0,
      triangleCount: 0,
      geometryRebuilds: 0,
      levels: []
    };
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

    camera.updateMatrixWorld();
    this._root.updateWorldMatrix(true, false);
    this._projectionView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._projectionView);
    camera.getWorldPosition(this._cameraLocal);
    this._root.worldToLocal(this._cameraLocal);
    this._cameraDirection.copy(this._cameraLocal).normalize();
    this._root.getWorldScale(this._worldScale);

    const leaves: TileSelection[] = [];
    const nextExpanded = new Set<string>();
    const counters = { tested: 0, culled: 0 };
    const safeViewportHeight = Math.max(1, viewportHeight);
    const focalPixels = safeViewportHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5));

    for (const face of ROOT_FACES) {
      const rootId: GlobeTileId = { face, level: 0, x: 0, y: 0 };
      const selection = this.evaluateTile(rootId, focalPixels, counters);
      if (selection) leaves.push(selection);
    }

    while (leaves.length < this._maxVisibleTiles) {
      let bestIndex = -1;
      let bestScore = 1;

      for (let i = 0; i < leaves.length; i += 1) {
        const leaf = leaves[i];
        if (!leaf || !leaf.canSplit || leaf.id.level >= this._maxLevel) continue;
        const threshold = this._previousExpanded.has(leaf.key)
          ? this._targetTilePixels * this._collapseHysteresis
          : this._targetTilePixels;
        const score = leaf.id.level < this._minLevel
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
      this.rebuildGeometry(leaves);
    }

    const levelCounts = new Map<number, number>();
    for (const leaf of leaves) {
      levelCounts.set(leaf.id.level, (levelCounts.get(leaf.id.level) ?? 0) + 1);
    }
    const levels = [...levelCounts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([level, count]) => ({ level, count }));

    this._debugInfo = {
      enabled: this._enabled,
      selectedCount: leaves.length,
      testedCount: counters.tested,
      culledCount: counters.culled,
      triangleCount: this._triangleCount,
      geometryRebuilds: this._geometryRebuilds,
      levels
    };
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._surfaceGeometry.dispose();
    this._lineGeometry.dispose();
    this._surfaceMaterial.dispose();
    this._lineMaterial.dispose();
    this._root.clear();
    this._previousExpanded.clear();
  }

  private evaluateChildren(
    parent: GlobeTileId,
    focalPixels: number,
    counters: { tested: number; culled: number }
  ): TileSelection[] {
    const nextLevel = parent.level + 1;
    const x = parent.x * 2;
    const y = parent.y * 2;
    const candidates: GlobeTileId[] = [
      { face: parent.face, level: nextLevel, x, y },
      { face: parent.face, level: nextLevel, x: x + 1, y },
      { face: parent.face, level: nextLevel, x, y: y + 1 },
      { face: parent.face, level: nextLevel, x: x + 1, y: y + 1 }
    ];
    const visible: TileSelection[] = [];
    for (const child of candidates) {
      const selection = this.evaluateTile(child, focalPixels, counters);
      if (selection) visible.push(selection);
    }
    return visible;
  }

  private evaluateTile(
    id: GlobeTileId,
    focalPixels: number,
    counters: { tested: number; culled: number }
  ): TileSelection | null {
    counters.tested += 1;
    const bounds = tileBounds(id);
    cubeFaceDirection(id.face, (bounds.u0 + bounds.u1) * 0.5, (bounds.v0 + bounds.v1) * 0.5, this._tileDirection);
    const angularRadius = tileAngularRadius(id.face, bounds, this._tileDirection, this._cubeDirection);
    const capCenterDistance = this._earthRadius * Math.cos(angularRadius);
    const capRadius = this._earthRadius * Math.sin(angularRadius) +
      this._earthRadius * WGS84_FLATTENING;
    this._tileCenter.copy(this._tileDirection).multiplyScalar(capCenterDistance);

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

    this._surfaceCenter.copy(this._tileDirection).multiplyScalar(this._earthRadius);
    const cameraDistance = Math.max(
      1,
      this._cameraLocal.distanceTo(this._surfaceCenter) - capRadius * 0.35
    );
    const projectedPixels =
      (2 * this._earthRadius * Math.sin(angularRadius) * focalPixels) / cameraDistance;

    return {
      id,
      key: tileKey(id),
      projectedPixels,
      canSplit: true
    };
  }

  private isAboveHorizon(direction: THREE.Vector3, angularRadius: number): boolean {
    const cameraDistance = this._cameraLocal.length();
    if (cameraDistance <= this._horizonRadius) return true;
    const horizonAngle = Math.acos(clampNumber(this._horizonRadius / cameraDistance, -1, 1));
    const visibleAngle = Math.min(Math.PI, horizonAngle + angularRadius + this._horizonPaddingRad);
    return this._cameraDirection.dot(direction) >= Math.cos(visibleAngle);
  }

  private rebuildGeometry(selection: readonly TileSelection[]): void {
    const positions: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    const linePositions: number[] = [];

    for (const leaf of selection) {
      this.appendTileGeometry(leaf.id, positions, normals, colors, indices, linePositions);
    }

    this._surfaceGeometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(positions, 3)
    );
    this._surfaceGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    this._surfaceGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this._surfaceGeometry.setIndex(indices);
    this._surfaceGeometry.computeBoundingSphere();

    this._lineGeometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(linePositions, 3)
    );
    this._lineGeometry.computeBoundingSphere();
    this._triangleCount = indices.length / 3;
    this._geometryRebuilds += 1;
  }

  private appendTileGeometry(
    id: GlobeTileId,
    positions: number[],
    normals: number[],
    colors: number[],
    indices: number[],
    linePositions: number[]
  ): void {
    const bounds = tileBounds(id);
    const segments = this.segmentsForLevel(id.level);
    const baseVertex = positions.length / 3;
    const tileColor = tileDebugColor(id);

    for (let iy = 0; iy <= segments; iy += 1) {
      const v = THREE.MathUtils.lerp(bounds.v0, bounds.v1, iy / segments);
      for (let ix = 0; ix <= segments; ix += 1) {
        const u = THREE.MathUtils.lerp(bounds.u0, bounds.u1, ix / segments);
        this.appendSurfaceVertex(
          id.face,
          u,
          v,
          this._surfaceOffsetMeters,
          positions,
          normals,
          colors,
          tileColor
        );
      }
    }

    const columns = segments + 1;
    for (let iy = 0; iy < segments; iy += 1) {
      for (let ix = 0; ix < segments; ix += 1) {
        const a = baseVertex + iy * columns + ix;
        const b = a + 1;
        const c = a + columns;
        const d = c + 1;
        indices.push(a, b, c, b, d, c);
      }
    }

    this.appendCurvedEdge(id.face, bounds.u0, bounds.v0, bounds.u1, bounds.v0, segments, linePositions);
    this.appendCurvedEdge(id.face, bounds.u1, bounds.v0, bounds.u1, bounds.v1, segments, linePositions);
    this.appendCurvedEdge(id.face, bounds.u1, bounds.v1, bounds.u0, bounds.v1, segments, linePositions);
    this.appendCurvedEdge(id.face, bounds.u0, bounds.v1, bounds.u0, bounds.v0, segments, linePositions);
  }

  private segmentsForLevel(level: number): number {
    const curvatureBoost = 2 ** Math.max(0, 4 - level);
    return Math.min(this._maxTileSegments, this._tileSegments * curvatureBoost);
  }

  private appendSurfaceVertex(
    face: CubeFace,
    u: number,
    v: number,
    heightMeters: number,
    positions: number[],
    normals?: number[],
    colors?: number[],
    color?: THREE.Color
  ): void {
    cubeFaceDirection(face, u, v, this._cubeDirection);
    const lat = THREE.MathUtils.radToDeg(Math.asin(clampNumber(this._cubeDirection.y, -1, 1)));
    const lon = normalizeLon(
      this._geo.frontLonDeg + THREE.MathUtils.radToDeg(Math.atan2(this._cubeDirection.x, this._cubeDirection.z))
    );
    const world = this._geo.wgs84ToThree(lat, lon, heightMeters);
    positions.push(world.x, world.y, world.z);
    normals?.push(this._cubeDirection.x, this._cubeDirection.y, this._cubeDirection.z);
    if (colors && color) colors.push(color.r, color.g, color.b);
  }

  private appendCurvedEdge(
    face: CubeFace,
    u0: number,
    v0: number,
    u1: number,
    v1: number,
    segments: number,
    positions: number[]
  ): void {
    for (let i = 0; i < segments; i += 1) {
      const t0 = i / segments;
      const t1 = (i + 1) / segments;
      this.appendSurfaceVertex(
        face,
        THREE.MathUtils.lerp(u0, u1, t0),
        THREE.MathUtils.lerp(v0, v1, t0),
        this._lineOffsetMeters,
        positions
      );
      this.appendSurfaceVertex(
        face,
        THREE.MathUtils.lerp(u0, u1, t1),
        THREE.MathUtils.lerp(v0, v1, t1),
        this._lineOffsetMeters,
        positions
      );
    }
  }
}

function tileBounds(id: GlobeTileId): { u0: number; v0: number; u1: number; v1: number } {
  const divisions = 2 ** id.level;
  return {
    u0: -1 + (2 * id.x) / divisions,
    v0: -1 + (2 * id.y) / divisions,
    u1: -1 + (2 * (id.x + 1)) / divisions,
    v1: -1 + (2 * (id.y + 1)) / divisions
  };
}

function tileAngularRadius(
  face: CubeFace,
  bounds: { u0: number; v0: number; u1: number; v1: number },
  centerDirection: THREE.Vector3,
  scratch: THREE.Vector3
): number {
  let maxAngle = 0;
  cubeFaceDirection(face, bounds.u0, bounds.v0, scratch);
  maxAngle = Math.max(maxAngle, Math.acos(clampNumber(centerDirection.dot(scratch), -1, 1)));
  cubeFaceDirection(face, bounds.u1, bounds.v0, scratch);
  maxAngle = Math.max(maxAngle, Math.acos(clampNumber(centerDirection.dot(scratch), -1, 1)));
  cubeFaceDirection(face, bounds.u1, bounds.v1, scratch);
  maxAngle = Math.max(maxAngle, Math.acos(clampNumber(centerDirection.dot(scratch), -1, 1)));
  cubeFaceDirection(face, bounds.u0, bounds.v1, scratch);
  maxAngle = Math.max(maxAngle, Math.acos(clampNumber(centerDirection.dot(scratch), -1, 1)));
  return maxAngle;
}

function cubeFaceDirection(face: CubeFace, u: number, v: number, out: THREE.Vector3): THREE.Vector3 {
  switch (face) {
    case 0:
      return out.set(1, v, -u).normalize();
    case 1:
      return out.set(-1, v, u).normalize();
    case 2:
      return out.set(u, 1, -v).normalize();
    case 3:
      return out.set(u, -1, v).normalize();
    case 4:
      return out.set(u, v, 1).normalize();
    case 5:
      return out.set(-u, v, -1).normalize();
  }
}

function tileDebugColor(id: GlobeTileId): THREE.Color {
  const hue = 0.52 + id.face * 0.008;
  const lightness = clampNumber(0.15 + id.level * 0.012, 0.15, 0.27);
  return new THREE.Color().setHSL(hue, 0.48, lightness);
}

function tileKey(id: GlobeTileId): string {
  return `${id.face}/${id.level}/${id.x}/${id.y}`;
}

function compareSelection(a: TileSelection, b: TileSelection): number {
  return a.id.face - b.id.face || a.id.level - b.id.level || a.id.y - b.id.y || a.id.x - b.id.x;
}

function normalizeLon(lon: number): number {
  let out = lon % 360;
  if (out > 180) out -= 360;
  if (out <= -180) out += 360;
  return out;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
