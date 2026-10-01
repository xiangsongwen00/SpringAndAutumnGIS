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
  /** Approximate distance from the viewport centre in normalized device coordinates. */
  viewCenterDistance: number;
}>;

/** Higher means more urgent: error dominates, centre preference is bounded. */
export function tileRequestUrgency(tile: SelectedTile): number {
  return tile.screenPixels / (1 + 0.25 * Math.min(2, Math.max(0, tile.viewCenterDistance)));
}

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
  /** @deprecated Projection now accounts for grazing angles per axis; ignored. */
  horizonDetailExponent?: number;
  /** Conservative positive GPU surface displacement used by culling, in metres. */
  maximumSurfaceDisplacement?: number;
  tilingScheme?: TilingScheme;
};

export interface SurfaceDisplacementBoundsSource {
  readonly revision: number;
  maximumHeight(id: TileId): number | null;
  /** Exact loaded height interval when available. */
  heightRange?(id: TileId): SurfaceDisplacementRange | null;
}

export type SurfaceDisplacementRange = Readonly<{
  minimumHeight: number;
  maximumHeight: number;
}>;

type Candidate = SelectedTile & { canSplit: boolean };
type ViewSurfaceSample = {
  longitude: number;
  latitude: number;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  screenDistance: number;
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
  private readonly previousSplits = new Set<string>();
  private readonly boundsCache = new Map<string, { sphere: THREE.Sphere; box?: {
    center: THREE.Vector3; axes: THREE.Vector3[]; halfSize: THREE.Vector3
  } }>();
  private readonly boundsDelta = new THREE.Vector3();
  private readonly cameraDirection = new THREE.Vector3();
  private readonly cameraPosition = new THREE.Vector3();
  private readonly tileDirection = new THREE.Vector3();
  private readonly sampleDirection = new THREE.Vector3();
  private readonly displacedSample = new THREE.Vector3();
  private readonly boundsNormal = new THREE.Vector3();
  private readonly surfacePoint = new THREE.Vector3();
  private readonly surfaceToCamera = new THREE.Vector3();
  private readonly cameraRight = new THREE.Vector3();
  private readonly cameraUp = new THREE.Vector3();
  private readonly cameraForward = new THREE.Vector3();
  private readonly tangentEast = new THREE.Vector3();
  private readonly tangentNorth = new THREE.Vector3();
  private readonly projectionView = new THREE.Matrix4();
  private readonly projectedCenter = new THREE.Vector3();
  private readonly frustum = new THREE.Frustum();
  private readonly tileBounds = new THREE.Sphere();
  private readonly viewSurfaceSamples: ViewSurfaceSample[] = [];
  private surfaceDisplacementSource?: SurfaceDisplacementBoundsSource;
  private surfaceDisplacementRevision = -1;
  private cameraDistance = 0;
  private scaledCameraDistance = 0;
  private cameraLongitude = 0;
  private cameraLatitude = 0;
  private focalPixels = 1;
  private nearestVisibleDistance = Infinity;
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
    this.horizonPaddingRadians = THREE.MathUtils.degToRad(options.horizonPaddingDegrees ?? 0.05);
    this.minimumHorizonDetailFactor = THREE.MathUtils.clamp(
      options.minimumHorizonDetailFactor ?? 0.08,
      0.01,
      1
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
    this.cameraRight.setFromMatrixColumn(camera.matrixWorld, 0);
    this.cameraUp.setFromMatrixColumn(camera.matrixWorld, 1);
    this.cameraForward.setFromMatrixColumn(camera.matrixWorld, 2).negate();
    this.cameraDistance = this.cameraPosition.length();
    this.cameraDirection.copy(this.cameraPosition).normalize();
    this.cameraLongitude = THREE.MathUtils.radToDeg(
      Math.atan2(this.cameraDirection.x, this.cameraDirection.z)
    );
    this.cameraLatitude = THREE.MathUtils.radToDeg(
      Math.atan2(this.cameraPosition.y / this.ellipsoid.polarRadius,
        Math.hypot(this.cameraPosition.x, this.cameraPosition.z) / this.ellipsoid.equatorialRadius)
    );
    this.scaledCameraDistance = Math.hypot(this.cameraPosition.x / this.ellipsoid.equatorialRadius,
      this.cameraPosition.y / this.ellipsoid.polarRadius, this.cameraPosition.z / this.ellipsoid.equatorialRadius);
    // Read the effective projection, including PerspectiveCamera.zoom.
    this.focalPixels = Math.max(1, viewportHeight) * camera.projectionMatrix.elements[5]! * 0.5;
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
    if (id.level > 0 && !this.isAboveHorizon(rectangle, surfaceDisplacement.maximumHeight)) {
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
    this.projectedCenter.copy(this.surfacePoint).applyMatrix4(this.projectionView);
    const centreOnScreen = Math.abs(this.projectedCenter.x) <= 1.05 && Math.abs(this.projectedCenter.y) <= 1.05 &&
      this.projectedCenter.z >= -1 && this.projectedCenter.z <= 1;
    // An off-screen coarse centre must not steal the foreground's budget.
    // Retain a distance-based fallback for thin visible slivers between rays.
    let screenPixels = centreOnScreen
      ? this.projectedDetailPixels(this.surfacePoint, ellipsoidSurfaceNormal(this.surfacePoint, this.ellipsoid), worldSpan)
      : worldSpan * this.focalPixels / Math.max(1, this.cameraPosition.distanceTo(this.surfacePoint)) * this.minimumHorizonDetailFactor;
    if (centreOnScreen) screenPixels *= this.detailImportance(this.surfacePoint, Math.hypot(this.projectedCenter.x, this.projectedCenter.y));
    // Tile centres are insufficient for a near-horizontal view: the centre of
    // a coarse tile may be far outside the viewport while a small foreground
    // portion crosses it. Surface samples from the actual viewport preserve
    // refinement around the centre/bottom foreground without forcing the
    // entire horizon to the same level.
    for (const sample of this.viewSurfaceSamples) {
      if (!rectangleContains(rectangle, sample.longitude, sample.latitude)) continue;
      screenPixels = Math.max(
        screenPixels,
        this.projectedDetailPixels(sample.point, sample.normal, worldSpan) * this.detailImportance(sample.point, sample.screenDistance)
      );
    }
    let viewCenterDistance = Math.hypot(this.projectedCenter.x, this.projectedCenter.y);
    for (const sample of this.viewSurfaceSamples) {
      if (rectangleContains(rectangle, sample.longitude, sample.latitude)) {
        viewCenterDistance = Math.min(viewCenterDistance, sample.screenDistance);
      }
    }
    return { id, rectangle, screenPixels, viewCenterDistance, canSplit: true };
  }

  private detailImportance(point: THREE.Vector3, screenDistance: number): number {
    const distance = Math.max(1, this.cameraPosition.distanceTo(point));
    const nearRatio = Math.min(1, this.nearestVisibleDistance / distance);
    // A continuous peripheral gradient, with a foreground exception. Near
    // ground stays detailed even at the bottom edge of a grazing view; distant
    // edges no longer demand the same pixel density as the focus region.
    return Math.max(0.3, 1 / (1 + 2 * screenDistance ** 2), 0.75 * nearRatio ** 4);
  }

  private projectedDetailPixels(
    point: THREE.Vector3,
    normal: THREE.Vector3,
    worldSpan: number
  ): number {
    this.surfaceToCamera.copy(this.cameraPosition).sub(point);
    const distance = Math.max(1, this.surfaceToCamera.length());
    const depth = -this.surfaceToCamera.dot(this.cameraForward);
    if (depth <= 0) return 0;
    // Perspective Jacobian of the local tangent plane, in physical pixels/m.
    // Its largest singular value retains cross-view detail at grazing angles:
    // foreshortening one axis must not reduce the other axis's resolution.
    this.tangentEast.set(normal.z, 0, -normal.x);
    if (this.tangentEast.lengthSq() < 1e-12) this.tangentEast.set(1, 0, 0);
    this.tangentEast.normalize();
    this.tangentNorth.crossVectors(normal, this.tangentEast).normalize();
    const cameraX = -this.surfaceToCamera.dot(this.cameraRight);
    const cameraY = -this.surfaceToCamera.dot(this.cameraUp);
    const derivative = (tangent: THREE.Vector3, axis: THREE.Vector3, coordinate: number) =>
      this.focalPixels / depth * (tangent.dot(axis) - coordinate / depth * tangent.dot(this.cameraForward));
    const a = derivative(this.tangentEast, this.cameraRight, cameraX);
    const b = derivative(this.tangentNorth, this.cameraRight, cameraX);
    const c = derivative(this.tangentEast, this.cameraUp, cameraY);
    const d = derivative(this.tangentNorth, this.cameraUp, cameraY);
    const trace = a * a + b * b + c * c + d * d;
    const determinant = (a * d - b * c) ** 2;
    const maximumScale = Math.sqrt((trace + Math.sqrt(Math.max(0, trace * trace - 4 * determinant))) / 2);
    // Only a floor for degenerate cases; no extra whole-tile pitch penalty.
    return worldSpan * Math.max(maximumScale, this.minimumHorizonDetailFactor * this.focalPixels / distance);
  }

  private updateViewSurfaceSamples(camera: THREE.PerspectiveCamera): void {
    this.viewSurfaceSamples.length = 0;
    this.nearestVisibleDistance = Infinity;
    const ndcSamples: Array<readonly [number, number]> = [];
    // Symmetric coverage works for roll/heading as well as the usual bottom
    // foreground. Rays that see only sky simply have no surface sample.
    for (const y of [-.98, -.66, -.33, 0, .33, .66, .98]) {
      for (const x of [-.98, -.66, -.33, 0, .33, .66, .98]) ndcSamples.push([x, y]);
    }
    for (const [x, y] of ndcSamples) {
      const direction = new THREE.Vector3(x, y, 0.5)
        .unproject(camera)
        .sub(this.cameraPosition)
        .normalize();
      const point = intersectEllipsoid(this.cameraPosition, direction, this.ellipsoid);
      if (!point) continue;
      this.nearestVisibleDistance = Math.min(this.nearestVisibleDistance, this.cameraPosition.distanceTo(point));
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
        normal: ellipsoidSurfaceNormal(point, this.ellipsoid),
        screenDistance: Math.hypot(x, y)
      });
    }
  }

  private surfaceDisplacementForTile(id: TileId): SurfaceDisplacementRange {
    const loadedRange = this.surfaceDisplacementSource?.heightRange?.(id);
    if (loadedRange) {
      const minimumHeight = THREE.MathUtils.clamp(
        loadedRange.minimumHeight,
        -this.maximumSurfaceDisplacement,
        this.maximumSurfaceDisplacement
      );
      const maximumHeight = THREE.MathUtils.clamp(
        loadedRange.maximumHeight,
        minimumHeight,
        this.maximumSurfaceDisplacement
      );
      return { minimumHeight, maximumHeight };
    }
    const height = this.surfaceDisplacementSource?.maximumHeight(id);
    return height === null || height === undefined
      ? { minimumHeight: 0, maximumHeight: this.maximumSurfaceDisplacement }
      : {
          minimumHeight: 0,
          maximumHeight: THREE.MathUtils.clamp(height, 0, this.maximumSurfaceDisplacement)
        };
  }

  private isAboveHorizon(rectangle: Rectangle, surfaceDisplacement: number): boolean {
    if (this.scaledCameraDistance <= 1) return true;
    const horizonAngle = Math.acos(THREE.MathUtils.clamp(1 / this.scaledCameraDistance, -1, 1));
    // A displaced mountain can be visible beyond the reference ellipsoid's
    // tangent point. The extra angle is the horizon extension seen from the
    // highest permitted surface displacement. Without it, CPU LOD culling
    // removes tiles that the GPU later would have lifted into the viewport.
    const displacedRadius = 1 + surfaceDisplacement / this.ellipsoid.polarRadius;
    const displacementAngle = surfaceDisplacement > 0
      ? Math.acos(THREE.MathUtils.clamp(1 / displacedRadius, -1, 1))
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
    // Geodetic latitude is not the latitude in ellipsoid-scaled unit space.
    const reducedLatitude = (degrees: number) => Math.atan(
      this.ellipsoid.polarRadius / this.ellipsoid.equatorialRadius * Math.tan(THREE.MathUtils.degToRad(degrees)));
    const south = reducedLatitude(rectangle.south);
    const north = reducedLatitude(rectangle.north);
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
    surfaceDisplacement: SurfaceDisplacementRange
  ): boolean {
    const key = tileKey(id);
    const cached = this.boundsCache.get(key);
    if (cached) return this.frustum.intersectsSphere(cached.sphere) && (!cached.box || this.boxInsideFrustum(cached.box));

    const longitudeCenter = (rectangle.west + rectangle.east) * 0.5;
    const latitudeCenter = (rectangle.south + rectangle.north) * 0.5;
    this.ellipsoid.cartographicToCartesian(
      { longitude: longitudeCenter, latitude: latitudeCenter },
      this.tileBounds.center
    );
    const displacementMidpoint =
      (surfaceDisplacement.minimumHeight + surfaceDisplacement.maximumHeight) * 0.5;
    if (displacementMidpoint !== 0) {
      const a2 = this.ellipsoid.equatorialRadius ** 2;
      const b2 = this.ellipsoid.polarRadius ** 2;
      this.boundsNormal.set(
        this.tileBounds.center.x / a2,
        this.tileBounds.center.y / b2,
        this.tileBounds.center.z / a2
      ).normalize();
      this.tileBounds.center.addScaledVector(
        this.boundsNormal,
        displacementMidpoint
      );
    }

    // A conservative world-space sphere catches curved tiles that merely cross
    // a viewport edge. The old projected-point test could reject such a tile
    // when none of its sparse samples happened to land inside the viewport.
    let radius = 0;
    const sampleSteps = 4;
    const longitudeRadians = THREE.MathUtils.degToRad(longitudeCenter);
    const latitudeRadians = THREE.MathUtils.degToRad(latitudeCenter);
    const east = new THREE.Vector3(Math.cos(longitudeRadians), 0, -Math.sin(longitudeRadians));
    const up = new THREE.Vector3(Math.cos(latitudeRadians) * Math.sin(longitudeRadians), Math.sin(latitudeRadians),
      Math.cos(latitudeRadians) * Math.cos(longitudeRadians));
    const axes = [east, up.clone().cross(east).normalize(), up];
    const minimum = new THREE.Vector3(Infinity, Infinity, Infinity);
    const maximum = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    const include = (point: THREE.Vector3) => {
      this.boundsDelta.copy(point).sub(this.tileBounds.center);
      for (let axis = 0; axis < 3; axis++) {
        const value = this.boundsDelta.dot(axes[axis]!);
        minimum.setComponent(axis, Math.min(minimum.getComponent(axis), value));
        maximum.setComponent(axis, Math.max(maximum.getComponent(axis), value));
      }
    };
    for (let y = 0; y <= sampleSteps; y += 1) {
      const latitude = THREE.MathUtils.lerp(rectangle.south, rectangle.north, y / sampleSteps);
      for (let x = 0; x <= sampleSteps; x += 1) {
        const longitude = THREE.MathUtils.lerp(rectangle.west, rectangle.east, x / sampleSteps);
        this.ellipsoid.cartographicToCartesian(
          { longitude, latitude },
          this.sampleDirection
        );
        radius = Math.max(radius, this.tileBounds.center.distanceTo(this.sampleDirection));
        include(this.sampleDirection);
        if (surfaceDisplacement.minimumHeight !== 0) {
          this.ellipsoid.cartographicToCartesian(
            { longitude, latitude, height: surfaceDisplacement.minimumHeight },
            this.displacedSample
          );
          radius = Math.max(radius, this.tileBounds.center.distanceTo(this.displacedSample));
          include(this.displacedSample);
        }
        if (surfaceDisplacement.maximumHeight !== surfaceDisplacement.minimumHeight) {
          this.ellipsoid.cartographicToCartesian(
            { longitude, latitude, height: surfaceDisplacement.maximumHeight },
            this.displacedSample
          );
          radius = Math.max(radius, this.tileBounds.center.distanceTo(this.displacedSample));
          include(this.displacedSample);
        }
      }
    }
    // The centre is halfway between the reference and maximum displaced
    // surfaces; sampling both surfaces is much tighter than adding the full
    // height in every direction while remaining conservative for GPU lift.
    this.tileBounds.radius = radius * 1.01 + 1;
    if (this.boundsCache.size >= this.maxTiles * 64) this.boundsCache.clear();
    // Tight ENU box: terrain height expands the up axis, not every lateral
    // axis as a sphere does. Curvature margin keeps unsampled arcs inside.
    const halfSize = maximum.clone().sub(minimum).multiplyScalar(0.5);
    const dLatitude = THREE.MathUtils.degToRad(rectangle.north - rectangle.south) / sampleSteps;
    const dLongitude = THREE.MathUtils.degToRad(rectangle.east - rectangle.west) / sampleSteps;
    const margin = (this.ellipsoid.equatorialRadius + Math.max(Math.abs(surfaceDisplacement.minimumHeight),
      Math.abs(surfaceDisplacement.maximumHeight))) * (dLatitude ** 2 + dLongitude ** 2) / 2 + 1;
    halfSize.addScalar(margin);
    const midpoint = maximum.clone().add(minimum).multiplyScalar(0.5);
    const boxCenter = this.tileBounds.center.clone();
    axes.forEach((axis, index) => boxCenter.addScaledVector(axis, midpoint.getComponent(index)));
    const box = { center: boxCenter, axes, halfSize };
    const bounds = { sphere: this.tileBounds.clone(), box: id.level >= 4 ? box : undefined };
    this.boundsCache.set(key, bounds);
    return this.frustum.intersectsSphere(bounds.sphere) && (!bounds.box || this.boxInsideFrustum(bounds.box));
  }

  private boxInsideFrustum(box: { center: THREE.Vector3; axes: THREE.Vector3[]; halfSize: THREE.Vector3 }): boolean {
    return this.frustum.planes.every((plane) => {
      const support = box.axes.reduce((sum, axis, index) => sum + Math.abs(plane.normal.dot(axis)) * box.halfSize.getComponent(index), 0);
      return plane.distanceToPoint(box.center) + support >= 0;
    });
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
