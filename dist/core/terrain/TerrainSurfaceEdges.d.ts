import * as THREE from 'three';
import type { TileId } from '../tiling/GeographicTilingScheme';
export type TerrainSurfaceTile = {
    id: TileId;
    segments: number;
    /** Same resolved DEM/ancestor and exaggeration as the vertex shader. */
    height: (u: number, v: number) => number;
    /** Immutable binding/content token; omit to disable cross-frame caching. */
    heightKey?: string;
};
/** Reconcile the actual rendered ECEF polylines, not merely DEM texels.
 * Fine T-junctions lie on the coarse edge's straight segment. Shared corners
 * use one canonical authority, including mixed-LOD and ancestor fallback.
 */
export declare function terrainSurfaceEdges(tiles: readonly TerrainSurfaceTile[], heightOffset?: number, persistentPoints?: Map<string, THREE.Vector3>): Map<TerrainSurfaceTile, Map<number, THREE.Vector3>>;
//# sourceMappingURL=TerrainSurfaceEdges.d.ts.map