import * as THREE from 'three';
import { type SelectedTile, type GlobeLodStats, type SurfaceDisplacementBoundsSource } from './GlobeLodSelector';
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
export declare class TerrainLodSelector {
    private readonly provider;
    private readonly surface;
    private readonly options;
    private readonly exaggeration;
    private selector;
    private level;
    private capacity;
    private result;
    private readonly position;
    private readonly quaternion;
    private readonly projection;
    private viewport;
    private revision;
    private selectedAt;
    private readonly interval;
    constructor(provider: TerrainProvider, surface: SurfaceDisplacementBoundsSource, options?: TerrainLodOptions, exaggeration?: number);
    select(camera: THREE.PerspectiveCamera, viewportHeight: number, now?: number, residentTargetCapacity?: number): {
        tiles: readonly SelectedTile[];
        stats: GlobeLodStats;
    };
}
//# sourceMappingURL=TerrainLodSelector.d.ts.map