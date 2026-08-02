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
  /** Lowest screen-error multiplier for tiles at a grazing/horizon angle. */
  minimumHorizonDetailFactor?: number;
  /** Shape of the transition from foreground detail to horizon detail. */
  horizonDetailExponent?: number;
  /** Conservative positive GPU surface displacement used by culling, in metres. */
  maximumSurfaceDisplacement?: number;
  tilingScheme?: TilingScheme;
};

export interface SurfaceDisplacementBoundsSource {
  readonly revision: number;
  maximumHeight(id: TileId): number | null;
}

type Candidate = SelectedTile & { canSplit: boolean };
type ViewSurfaceSample = {
  longitude: number;
  latitude: number;
  point: THREE.Vector3;
  normal: THREE.Vector3;
};

/** Camera-dependent selection only. It intentionally knows nothing about meshes or imagery. */
export class GlobeLodSelector {
  readonly tilingScheme: TilingScheme;
  readonly ellipsoid: Ellipsoid;
  readonly minLevel: number;
  readonly maxLevel: number;
  readonly targetPixels: number;
  readonly collapseFactor: number;
  readonly maxTiles: number;
  maximumSurfaceDisplacement: number;

  private readonly horizonPaddingRadians: number;
  private readonly minimumHorizonDetailFactor: number;
  private readonly horizonDetailExponent: number;
  private readonly previousSplits = new Set<string>();
  private readonly boundsCache = new Map<string, THREE.Sphere>();
  private readonly cameraDirection = new THREE.Vector3();
  private readonly cameraPosition = new THREE.Vector3();
  private readonly tileDirection = new THREE.Vector3();
  private readonly sampleDirection = new THREE.Vector3();
  private readonly displacedSample = new THREE.Vector3();
  private readonly boundsNormal = new THREE.Vector3();
  private readonly surfacePoint = new THREE.Vector3();
  private readonly surfaceToCamera = new THREE.Vector3();
  private readonly projectionView = new THREE.Matrix4();
  private readonly frustum = new THREE.Frustum();
  private readonly tileBounds = new THREE.Sphere();
  private readonly viewSurfaceSamples: ViewSurfaceSample[] = [];
  private surfaceDisplacementSource?: SurfaceDisplacementBoundsSource;
  private surfaceDisplacementRevision = -1;
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
    this.minLevel = clampInteger(options.minLevel ?? 2, 0, 27);
    // JavaScript numbers can represent XYZ tile coordinates exactly well beyond
    // level 27. Keep a little headroom for future data sources while making 27
    // a first-class supported level today.
    this.maxLevel = clampInteger(options.maxLevel ?? 27, this.minLevel, 30);
    this.targetPixels = Math.max(24, options.targetPixels ?? 150);
    this.collapseFactor = THREE.MathUtils.clamp(options.collapseFactor ?? 0.72, 0.1, 0.99);
    this.maxTiles = Math.max(8, Math.round(options.maxTiles ?? 384));
    this.maximumSurfaceDisplacement = Math.max(
      0,
      options.maximumSurfaceDisplacement ?? 0
    );
    this.horizonPaddingRadians = THREE.MathUtils.degToRad(options.horizonPaddingDegrees ?? 0.75);
    this.minimumHorizonDetailFactor = THREE.MathUtils.clamp(
      options.minimumHorizonDetailFactor ?? 0.08,
      0.01,
      1
    );
    this.horizonDetailExponent = THREE.MathUtils.clamp(
      options.horizonDetailExponent ?? 0.5,
      0.1,
      4
    );
  }

  setMaximumSurfaceDisplacement(displacement: number): void {
    const next = Math.max(0, displacement);
    if (next === this.maximumSurfaceDisplacement) return;
    this.maximumSurfaceDisplacement = next;
    this.boundsCache.clear();
    this.previousSplits.clear();
  }

  setSurfaceDisplacementSource(source?: SurfaceDisplacementBoundsSource): void {
    if (source === this.surfaceDisplacementSource) return;
    this.surfaceDisplacementSource = source;
    this.surfaceDisplacementRevision = source?.revision ?? -1;
    this.boundsCache.clear();
    this.previousSplits.clear();
  }

  select(
    camera: THREE.PerspectiveCamera,
    viewportHeight: number,
    minimumLevelOverride?: number
  ): {
    tiles: SelectedTile[];
    stats: GlobeLodStats;
  } {
    const displacementRevision = this.surfaceDisplacementSource?.revision ?? -1;
    if (displacementRevision !== this.surfaceDisplacementRevision) {
      this.surfaceDisplacementRevision = displacementRevision;
      this.boundsCache.clear();
    }
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
    const effectiveMinimumLevel = minimumLevelOverride === undefined
      ? this.minLevel
      : clampInteger(minimumLevelOverride, this.minLevel, this.maxLevel);
    this.projectionView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projectionView);
    this.updateViewSurfaceSamples(camera);

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
        const score = candidate.id.level < effectiveMinimumLevel
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
      if (children.length === 0) {
        // The parent sphere was a conservative false positive. If none of its
        // four children survives exact horizon/frustum checks, the parent does
        // not cover visible surface and must not be rendered as a giant patch.
        leaves.splice(bestIndex, 1);
        continue;
      }
      if (leaves.length - 1 + children.length > this.maxTiles) {
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
    this.ellipsoid.cartographicToCartesian({ longitude, latitude }, this.surfacePoint);

    const surfaceDisplacement = this.surfaceDisplacementForTile(id);
    if (id.level > 0 && !this.isAboveHorizon(rectangle, surfaceDisplacement)) {
      this.horizonCulled += 1;
      return null;
    }
    if (id.level > 0 && !this.isInsideFrustum(id, rectangle, surfaceDisplacement)) {
      this.frustumCulled += 1;
      return null;
    }

    const angularSpan = Math.max(
      THREE.MathUtils.degToRad(rectangle.north - rectangle.south),
      THREE.MathUtils.degToRad(rectangle.east - rectangle.west) * Math.max(0.15, Math.cos(THREE.MathUtils.degToRad(latitude)))
    );
    const worldSpan = this.ellipsoid.equatorialRadius * angularSpan;
    let screenPixels = this.projectedDetailPixels(
      this.surfacePoint,
      this.tileDirection,
      worldSpan
    );
    // Tile centres are insufficient for a near-horizontal view: the centre of
    // a coarse tile may be far outside the viewport while a small foreground
    // portion crosses it. Surface samples from the actual viewport preserve
    // refinement around the centre/bottom foreground without forcing the
    // entire horizon to the same level.
    for (const sample of this.viewSurfaceSamples) {
      if (!rectangleContains(rectangle, sample.longitude, sample.latitude)) continue;
      screenPixels = Math.max(
        screenPixels,
        this.projectedDetailPixels(sample.point, sample.normal, worldSpan)
      );
    }
    return { id, rectangle, screenPixels, canSplit: true };
  }

  private projectedDetailPixels(
    point: THREE.Vector3,
    normal: THREE.Vector3,
    worldSpan: number
  ): number {
    this.surfaceToCamera.copy(this.cameraPosition).sub(point);
    const distance = Math.max(1, this.surfaceToCamera.length());
    const baseScreenPixels = (worldSpan * this.focalPixels) / distance;
    // Local elevation is 1 directly below the camera and approaches 0 at the
    // geometric horizon. It is different from the old camera-centre radial dot
    // product: this term models real grazing-angle compression, allowing the
    // distant horizon to use complete lower-level parent tiles while keeping
    // the foreground sharp and continuously covered.
    const elevationSine = THREE.MathUtils.clamp(
      this.surfaceToCamera.dot(normal) / distance,
      0,
      1
    );
    const horizonDetailFactor = THREE.MathUtils.lerp(
      this.minimumHorizonDetailFactor,
      1,
      elevationSine ** this.horizonDetailExponent
    );
    return baseScreenPixels * horizonDetailFactor;
  }

  private updateViewSurfaceSamples(camera: THREE.PerspectiveCamera): void {
    this.viewSurfaceSamples.length = 0;
    const ndcSamples: ReadonlyArray<readonly [number, number]> = [
      [0, 0],
      [0, -0.82],
      [-0.82, -0.82],
      [0.82, -0.82],
      [-0.82, 0],
      [0.82, 0]
    ];
    for (const [x, y] of ndcSamples) {
      const direction = new THREE.Vector3(x, y, 0.5)
        .unproject(camera)
        .sub(this.cameraPosition)
        .normalize();
      const point = intersectEllipsoid(this.cameraPosition, direction, this.ellipsoid);
      if (!point) continue;
      const horizontal = Math.hypot(point.x, point.z);
      const longitude = THREE.MathUtils.radToDeg(Math.atan2(point.x, point.z));
      const latitude = THREE.MathUtils.radToDeg(Math.atan2(
        point.y * this.ellipsoid.equatorialRadius ** 2,
        horizontal * this.ellipsoid.polarRadius ** 2
      ));
      this.viewSurfaceSamples.push({
        longitude,
        latitude,
        point,
        normal: ellipsoidSurfaceNormal(point, this.ellipsoid)
      });
    }
  }

  private surfaceDisplacementForTile(id: TileId): number {
    const height = this.surfaceDisplacementSource?.maximumHeight(id);
    return height === null || height === undefined
      ? this.maximumSurfaceDisplacement
      : THREE.MathUtils.clamp(height, 0, this.maximumSurfaceDisplacement);
  }

  private isAboveHorizon(rectangle: Rectangle, surfaceDisplacement: number): boolean {
    const radius = this.surfaceRadiusInDirection(this.cameraDirection);
    if (this.cameraDistance <= radius) return true;
    const horizonAngle = Math.acos(THREE.MathUtils.clamp(radius / this.cameraDistance, -1, 1));
    // A displaced mountain can be visible beyond the reference ellipsoid's
    // tangent point. The extra angle is the horizon extension seen from the
    // highest permitted surface displacement. Without it, CPU LOD culling
    // removes tiles that the GPU later would have lifted into the viewport.
    const displacedRadius = radius + surfaceDisplacement;
    const displacementAngle = surfaceDisplacement > 0
      ? Math.acos(THREE.MathUtils.clamp(radius / displacedRadius, -1, 1))
      : 0;
    const minimumFacing = Math.cos(
      Math.min(
        Math.PI,
        horizonAngle + displacementAngle + this.horizonPaddingRadians
      )
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

  private isInsideFrustum(
    id: TileId,
    rectangle: Rectangle,
    surfaceDisplacement: number
  ): boolean {
    const key = tileKey(id);
    const cached = this.boundsCache.get(key);
    if (cached) return this.frustum.intersectsSphere(cached);

    const longitudeCenter = (rectangle.west + rectangle.east) * 0.5;
    const latitudeCenter = (rectangle.south + rectangle.north) * 0.5;
    this.ellipsoid.cartographicToCartesian(
      { longitude: longitudeCenter, latitude: latitudeCenter },
      this.tileBounds.center
    );
    if (surfaceDisplacement > 0) {
      const a2 = this.ellipsoid.equatorialRadius ** 2;
      const b2 = this.ellipsoid.polarRadius ** 2;
      this.boundsNormal.set(
        this.tileBounds.center.x / a2,
        this.tileBounds.center.y / b2,
        this.tileBounds.center.z / a2
      ).normalize();
      this.tileBounds.center.addScaledVector(
        this.boundsNormal,
        surfaceDisplacement * 0.5
      );
    }

    // A conservative world-space sphere catches curved tiles that merely cross
    // a viewport edge. The old projected-point test could reject such a tile
    // when none of its sparse samples happened to land inside the viewport.
    let radius = 0;
    const sampleSteps = 4;
    for (let y = 0; y <= sampleSteps; y += 1) {
      const latitude = THREE.MathUtils.lerp(rectangle.south, rectangle.north, y / sampleSteps);
      for (let x = 0; x <= sampleSteps; x += 1) {
        const longitude = THREE.MathUtils.lerp(rectangle.west, rectangle.east, x / sampleSteps);
        this.ellipsoid.cartographicToCartesian(
          { longitude, latitude },
          this.sampleDirection
        );
        radius = Math.max(radius, this.tileBounds.center.distanceTo(this.sampleDirection));
        if (surfaceDisplacement > 0) {
          this.ellipsoid.cartographicToCartesian(
            { longitude, latitude, height: surfaceDisplacement },
            this.displacedSample
          );
          radius = Math.max(radius, this.tileBounds.center.distanceTo(this.displacedSample));
        }
      }
    }
    // The centre is halfway between the reference and maximum displaced
    // surfaces; sampling both surfaces is much tighter than adding the full
    // height in every direction while remaining conservative for GPU lift.
    this.tileBounds.radius = radius * 1.01 + 1;
    if (this.boundsCache.size >= this.maxTiles * 64) this.boundsCache.clear();
    this.boundsCache.set(key, this.tileBounds.clone());
    return this.frustum.intersectsSphere(this.tileBounds);
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

function rectangleContains(
  rectangle: Rectangle,
  longitude: number,
  latitude: number
): boolean {
  return longitude >= rectangle.west - 1e-9 &&
    longitude <= rectangle.east + 1e-9 &&
    latitude >= rectangle.south - 1e-9 &&
    latitude <= rectangle.north + 1e-9;
}

function ellipsoidSurfaceNormal(point: THREE.Vector3, ellipsoid: Ellipsoid): THREE.Vector3 {
  const a2 = ellipsoid.equatorialRadius ** 2;
  const b2 = ellipsoid.polarRadius ** 2;
  return new THREE.Vector3(point.x / a2, point.y / b2, point.z / a2).normalize();
}

function intersectEllipsoid(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  ellipsoid: Ellipsoid
): THREE.Vector3 | null {
  const a2 = ellipsoid.equatorialRadius ** 2;
  const b2 = ellipsoid.polarRadius ** 2;
  const quadraticA =
    (direction.x * direction.x + direction.z * direction.z) / a2 +
    (direction.y * direction.y) / b2;
  const quadraticB = 2 * (
    (origin.x * direction.x + origin.z * direction.z) / a2 +
    (origin.y * direction.y) / b2
  );
  const quadraticC =
    (origin.x * origin.x + origin.z * origin.z) / a2 +
    (origin.y * origin.y) / b2 - 1;
  const discriminant = quadraticB * quadraticB - 4 * quadraticA * quadraticC;
  if (discriminant < 0 || quadraticA <= 0) return null;
  const root = Math.sqrt(discriminant);
  const near = (-quadraticB - root) / (2 * quadraticA);
  const far = (-quadraticB + root) / (2 * quadraticA);
  const distance = near >= 0 ? near : far >= 0 ? far : -1;
  return distance >= 0 ? origin.clone().addScaledVector(direction, distance) : null;
}
