import * as THREE from 'three';
import { Ellipsoid } from '../geo/Ellipsoid';
import {
  GeographicTilingScheme,
  tileKey,
  type Rectangle,
  type TileId,
  type TilingScheme
} from '../tiling/GeographicTilingScheme';

export type SelectedTile = Readonly<{
  id: TileId;
  rectangle: Rectangle;
  screenPixels: number;
}>;

export type GlobeLodStats = Readonly<{
  selected: number;
  visited: number;
  horizonCulled: number;
  frustumCulled: number;
  levels: ReadonlyMap<number, number>;
}>;

export type GlobeLodSelectorOptions = {
  minLevel?: number;
  maxLevel?: number;
  targetPixels?: number;
  collapseFactor?: number;
  maxTiles?: number;
  horizonPaddingDegrees?: number;
  tilingScheme?: TilingScheme;
};

type Candidate = SelectedTile & { canSplit: boolean };

/** Camera-dependent selection only. It intentionally knows nothing about meshes or imagery. */
export class GlobeLodSelector {
  readonly tilingScheme: TilingScheme;
  readonly ellipsoid: Ellipsoid;
  readonly minLevel: number;
  readonly maxLevel: number;
  readonly targetPixels: number;
  readonly collapseFactor: number;
  readonly maxTiles: number;

  private readonly horizonPaddingRadians: number;
  private readonly previousSplits = new Set<string>();
  private readonly cameraDirection = new THREE.Vector3();
  private readonly cameraPosition = new THREE.Vector3();
  private readonly tileDirection = new THREE.Vector3();
  private readonly sampleDirection = new THREE.Vector3();
  private readonly surfacePoint = new THREE.Vector3();
  private readonly projectionView = new THREE.Matrix4();
  private readonly clipPoint = new THREE.Vector4();
  private cameraDistance = 0;
  private cameraLongitude = 0;
  private cameraLatitude = 0;
  private focalPixels = 1;
  private visited = 0;
  private horizonCulled = 0;
  private frustumCulled = 0;

  constructor(options: GlobeLodSelectorOptions = {}) {
    this.ellipsoid = Ellipsoid.WGS84;
    this.tilingScheme = options.tilingScheme ?? new GeographicTilingScheme();
    this.minLevel = clampInteger(options.minLevel ?? 1, 0, 18);
    this.maxLevel = clampInteger(options.maxLevel ?? 9, this.minLevel, 22);
    this.targetPixels = Math.max(24, options.targetPixels ?? 150);
    this.collapseFactor = THREE.MathUtils.clamp(options.collapseFactor ?? 0.72, 0.1, 0.99);
    this.maxTiles = Math.max(8, Math.round(options.maxTiles ?? 384));
    this.horizonPaddingRadians = THREE.MathUtils.degToRad(options.horizonPaddingDegrees ?? 0.75);
  }

  select(camera: THREE.PerspectiveCamera, viewportHeight: number): {
    tiles: SelectedTile[];
    stats: GlobeLodStats;
  } {
    camera.updateMatrixWorld();
    camera.getWorldPosition(this.cameraPosition);
    this.cameraDistance = this.cameraPosition.length();
    this.cameraDirection.copy(this.cameraPosition).normalize();
    this.cameraLongitude = THREE.MathUtils.radToDeg(
      Math.atan2(this.cameraDirection.x, this.cameraDirection.z)
    );
    this.cameraLatitude = THREE.MathUtils.radToDeg(
      Math.asin(THREE.MathUtils.clamp(this.cameraDirection.y, -1, 1))
    );
    this.focalPixels =
      Math.max(1, viewportHeight) /
      (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5));
    this.visited = 0;
    this.horizonCulled = 0;
    this.frustumCulled = 0;
    this.projectionView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

    const leaves = this.tilingScheme
      .rootTiles()
      .map((id) => this.evaluate(id))
      .filter((candidate): candidate is Candidate => candidate !== null);
    const nextSplits = new Set<string>();

    while (leaves.length < this.maxTiles) {
      let bestIndex = -1;
      let bestScore = 1;
      for (let index = 0; index < leaves.length; index += 1) {
        const candidate = leaves[index];
        if (!candidate || !candidate.canSplit || candidate.id.level >= this.maxLevel) continue;
        const threshold = this.previousSplits.has(tileKey(candidate.id))
          ? this.targetPixels * this.collapseFactor
          : this.targetPixels;
        const score = candidate.id.level < this.minLevel
          ? Number.POSITIVE_INFINITY
          : candidate.screenPixels / threshold;
        if (score > bestScore) {
          bestScore = score;
          bestIndex = index;
        }
      }
      if (bestIndex < 0) break;

      const parent = leaves[bestIndex];
      if (!parent) break;
      const children = this.tilingScheme
        .children(parent.id)
        .map((id) => this.evaluate(id))
        .filter((candidate): candidate is Candidate => candidate !== null);
      if (children.length === 0 || leaves.length - 1 + children.length > this.maxTiles) {
        parent.canSplit = false;
        continue;
      }
      leaves.splice(bestIndex, 1, ...children);
      nextSplits.add(tileKey(parent.id));
    }

    this.previousSplits.clear();
    for (const key of nextSplits) this.previousSplits.add(key);
    leaves.sort((a, b) => a.id.level - b.id.level || a.id.y - b.id.y || a.id.x - b.id.x);

    const levels = new Map<number, number>();
    for (const tile of leaves) levels.set(tile.id.level, (levels.get(tile.id.level) ?? 0) + 1);
    return {
      tiles: leaves,
      stats: {
        selected: leaves.length,
        visited: this.visited,
        horizonCulled: this.horizonCulled,
        frustumCulled: this.frustumCulled,
        levels
      }
    };
  }

  private evaluate(id: TileId): Candidate | null {
    this.visited += 1;
    const rectangle = this.tilingScheme.rectangle(id);
    const longitude = (rectangle.west + rectangle.east) * 0.5;
    const latitude = (rectangle.south + rectangle.north) * 0.5;
    this.tileDirection.copy(
      this.ellipsoid.cartographicToCartesian({ longitude, latitude }, this.tileDirection)
    ).normalize();
    const angularRadius = this.computeAngularRadius(rectangle);

    if (id.level > 0 && !this.isAboveHorizon(rectangle)) {
      this.horizonCulled += 1;
      return null;
    }
    if (id.level > 0 && !this.isInsideFrustum(rectangle)) {
      this.frustumCulled += 1;
      return null;
    }

    this.ellipsoid.cartographicToCartesian({ longitude, latitude }, this.surfacePoint);
    const distance = Math.max(1, this.surfacePoint.distanceTo(this.cameraPosition));
    const angularSpan = Math.max(
      THREE.MathUtils.degToRad(rectangle.north - rectangle.south),
      THREE.MathUtils.degToRad(rectangle.east - rectangle.west) * Math.max(0.15, Math.cos(THREE.MathUtils.degToRad(latitude)))
    );
    const worldSpan = this.ellipsoid.equatorialRadius * angularSpan;
    const facing = THREE.MathUtils.clamp(
      this.cameraDirection.dot(this.tileDirection),
      0,
      1
    );
    const foreshortening = 0.2 + 0.8 * facing;
    const screenPixels = (worldSpan * this.focalPixels * foreshortening) / distance;
    return { id, rectangle, screenPixels, canSplit: true };
  }

  private computeAngularRadius(rectangle: Rectangle): number {
    let maximum = 0;
    const center = this.tileDirection;
    const samples: ReadonlyArray<readonly [number, number]> = [
      [rectangle.west, rectangle.north],
      [rectangle.east, rectangle.north],
      [rectangle.east, rectangle.south],
      [rectangle.west, rectangle.south],
      [(rectangle.west + rectangle.east) * 0.5, rectangle.north],
      [(rectangle.west + rectangle.east) * 0.5, rectangle.south]
    ];
    for (const [longitude, latitude] of samples) {
      this.ellipsoid
        .cartographicToCartesian({ longitude, latitude }, this.sampleDirection)
        .normalize();
      maximum = Math.max(maximum, Math.acos(THREE.MathUtils.clamp(center.dot(this.sampleDirection), -1, 1)));
    }
    return maximum;
  }

  private isAboveHorizon(rectangle: Rectangle): boolean {
    const radius = this.surfaceRadiusInDirection(this.cameraDirection);
    if (this.cameraDistance <= radius) return true;
    const horizonAngle = Math.acos(THREE.MathUtils.clamp(radius / this.cameraDistance, -1, 1));
    const minimumFacing = Math.cos(
      Math.min(Math.PI, horizonAngle + this.horizonPaddingRadians)
    );
    return this.maximumFacingInRectangle(rectangle) >= minimumFacing;
  }

  private surfaceRadiusInDirection(direction: THREE.Vector3): number {
    const a = this.ellipsoid.equatorialRadius;
    const b = this.ellipsoid.polarRadius;
    return 1 / Math.sqrt(
      (direction.x * direction.x + direction.z * direction.z) / (a * a) +
      (direction.y * direction.y) / (b * b)
    );
  }

  private maximumFacingInRectangle(rectangle: Rectangle): number {
    const longitude = closestLongitudeInRectangle(
      this.cameraLongitude,
      rectangle.west,
      rectangle.east
    );
    const deltaLongitude = THREE.MathUtils.degToRad(longitude - this.cameraLongitude);
    const cameraLatitudeRadians = THREE.MathUtils.degToRad(this.cameraLatitude);
    const a = Math.sin(cameraLatitudeRadians);
    const b = Math.cos(cameraLatitudeRadians) * Math.cos(deltaLongitude);
    const optimumLatitude = Math.atan2(a, b);
    const south = THREE.MathUtils.degToRad(rectangle.south);
    const north = THREE.MathUtils.degToRad(rectangle.north);
    const candidates = [
      south,
      north,
      THREE.MathUtils.clamp(optimumLatitude, south, north)
    ];
    let maximum = -1;
    for (const latitude of candidates) {
      maximum = Math.max(
        maximum,
        a * Math.sin(latitude) + b * Math.cos(latitude)
      );
    }
    return maximum;
  }

  private isInsideFrustum(rectangle: Rectangle): boolean {
    const longitudeSamples = [
      rectangle.west,
      (rectangle.west + rectangle.east) * 0.5,
      rectangle.east,
      closestLongitudeInRectangle(this.cameraLongitude, rectangle.west, rectangle.east)
    ];
    const latitudeSamples = [
      rectangle.south,
      (rectangle.south + rectangle.north) * 0.5,
      rectangle.north,
      THREE.MathUtils.clamp(this.cameraLatitude, rectangle.south, rectangle.north)
    ];
    let minimumX = Number.POSITIVE_INFINITY;
    let maximumX = Number.NEGATIVE_INFINITY;
    let minimumY = Number.POSITIVE_INFINITY;
    let maximumY = Number.NEGATIVE_INFINITY;
    let minimumZ = Number.POSITIVE_INFINITY;
    let maximumZ = Number.NEGATIVE_INFINITY;
    let projected = 0;

    for (const longitude of longitudeSamples) {
      for (const latitude of latitudeSamples) {
        this.ellipsoid.cartographicToCartesian(
          { longitude, latitude },
          this.surfacePoint
        );
        this.clipPoint
          .set(this.surfacePoint.x, this.surfacePoint.y, this.surfacePoint.z, 1)
          .applyMatrix4(this.projectionView);
        if (this.clipPoint.w <= 0) continue;
        const inverseW = 1 / this.clipPoint.w;
        const x = this.clipPoint.x * inverseW;
        const y = this.clipPoint.y * inverseW;
        const z = this.clipPoint.z * inverseW;
        minimumX = Math.min(minimumX, x);
        maximumX = Math.max(maximumX, x);
        minimumY = Math.min(minimumY, y);
        maximumY = Math.max(maximumY, y);
        minimumZ = Math.min(minimumZ, z);
        maximumZ = Math.max(maximumZ, z);
        projected += 1;
      }
    }

    const padding = 0.03;
    return projected > 0 &&
      maximumX >= -1 - padding && minimumX <= 1 + padding &&
      maximumY >= -1 - padding && minimumY <= 1 + padding &&
      maximumZ >= -1 && minimumZ <= 1;
  }
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function closestLongitudeInRectangle(longitude: number, west: number, east: number): number {
  if (east - west >= 360) return longitude;
  const candidates = [longitude - 360, longitude, longitude + 360];
  let closest = west;
  let distance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const clamped = THREE.MathUtils.clamp(candidate, west, east);
    const nextDistance = Math.abs(candidate - clamped);
    if (nextDistance < distance) {
      distance = nextDistance;
      closest = clamped;
    }
  }
  return closest;
}

