import * as THREE from 'three';
import { GlobeLodSelector, type SelectedTile, type GlobeLodStats, type SurfaceDisplacementBoundsSource } from './GlobeLodSelector';
import { WebMercatorTilingScheme } from '../tiling/WebMercatorTilingScheme';
import { Ellipsoid } from '../geo/Ellipsoid';
import type { TerrainProvider } from '../terrain/TerrainProvider';

export type TerrainLodOptions = {
  /** Geometric screen error, not imagery tile pixels. Default 3 CSS pixels. */
  maximumScreenSpaceError?: number;
  /** Independent DEM target budget. Default 96. */
  maxTiles?: number;
  /** Common surface mesh budget, independent of image requests. Default 512. */
  maxSurfaceTiles?: number;
  /** Fallback estimate only: DEM samples across one tile. Default 256. */
  samplesPerTile?: number;
  /** Fallback slope bound; not a certified dataset error. Default 0.25. */
  estimatedSlope?: number;
  /** Selection is throttled during movement, publication still runs each frame. */
  updateIntervalMs?: number;
};

/** Independent DEM selection. Shares culling math, never imagery leaf IDs/offset. */
export class TerrainLodSelector {
  private selector: GlobeLodSelector | null = null;
  private level = -1;
  private result: { tiles: readonly SelectedTile[]; stats: GlobeLodStats } | null = null;
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly projection = new THREE.Matrix4();
  private viewport = 0;
  private revision = -1;
  private selectedAt = -Infinity;
  private readonly interval: number;

  constructor(private readonly provider: TerrainProvider,
    private readonly surface: SurfaceDisplacementBoundsSource,
    private readonly options: TerrainLodOptions = {}, private readonly exaggeration = 1) {
    this.interval = Math.max(0, options.updateIntervalMs ?? 100);
  }

  select(camera: THREE.PerspectiveCamera, viewportHeight: number, now = performance.now()) {
    if (!this.selector || this.level !== this.provider.maxLevel) {
      this.level = this.provider.maxLevel;
      const samples = Math.max(2, this.options.samplesPerTile ?? 256);
      const slope = Math.max(0, this.options.estimatedSlope ?? .25);
      this.selector = new GlobeLodSelector({ tilingScheme: new WebMercatorTilingScheme(),
        minLevel: this.provider.minLevel, maxLevel: this.provider.maxLevel,
        targetPixels: this.options.maximumScreenSpaceError ?? 3,
        maxTiles: this.options.maxTiles ?? 96, collapseFactor: .7,
        maximumSurfaceDisplacement: 12000 * this.exaggeration,
        geometricError: (id, rectangle) => {
          const supplied = this.provider.geometricError?.(id);
          if (supplied !== undefined && Number.isFinite(supplied) && supplied >= 0)
            return supplied * this.exaggeration;
          const latitude = (rectangle.north + rectangle.south) * .5 * Math.PI / 180;
          const span = 2 * Math.PI * Ellipsoid.WGS84.equatorialRadius * Math.max(.01, Math.cos(latitude)) / 2 ** id.level;
          // Unknown DEM is not flat. This is an explicit resolution/slope
          // estimate, plus ellipsoid tessellation sagitta, not measured error.
          return span / samples * slope * this.exaggeration + span ** 2 / (8 * Ellipsoid.WGS84.equatorialRadius * 64 ** 2);
        }
      });
      this.selector.setSurfaceDisplacementSource(this.surface);
      this.result = null;
    }
    const moved = this.position.distanceToSquared(camera.position) > 1 ||
      1 - Math.abs(this.quaternion.dot(camera.quaternion)) > 1e-10;
    const resized = this.viewport !== viewportHeight || !this.projection.equals(camera.projectionMatrix);
    const changed = moved || resized || this.revision !== this.surface.revision;
    if (!this.result || (changed && (resized || now - this.selectedAt >= this.interval))) {
      const next = this.selector.select(camera, viewportHeight);
      // Preserve identity if the dyadic footprints did not change. DEM arrival
      // must not cancel/recreate the same queue merely because arrays are new.
      if (!this.result || next.tiles.length !== this.result.tiles.length || next.tiles.some((t, i) => {
        const old = this.result!.tiles[i]!.id;
        return t.id.level !== old.level || t.id.x !== old.x || t.id.y !== old.y;
      })) this.result = next;
      this.position.copy(camera.position); this.quaternion.copy(camera.quaternion);
      this.projection.copy(camera.projectionMatrix); this.viewport = viewportHeight;
      this.revision = this.surface.revision; this.selectedAt = now;
    }
    return this.result!;
  }
}
