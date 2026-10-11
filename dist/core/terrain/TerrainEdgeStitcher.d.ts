import { type TerrainTileData } from './TerrainProvider';
import type { TileId } from '../tiling/GeographicTilingScheme';
export type StitchableTerrainTile = Readonly<{
    id: TileId;
    data: TerrainTileData;
}>;
export type TerrainStitchBounds = Readonly<{
    minimumHeight: number;
    maximumHeight: number;
}>;
export type TerrainStitchResult = Readonly<{
    modified: ReadonlySet<StitchableTerrainTile>;
    bounds: ReadonlyMap<StitchableTerrainTile, TerrainStitchBounds>;
    stitchedEdges: number;
}>;
export type TerrainEdgeStitchOptions = Readonly<{
    minimumBlendTexels?: number;
    maximumBlendTexels?: number;
    /** Maximum slope introduced perpendicular to an edge (rise / run). */
    maximumAddedSlope?: number;
}>;
/**
 * Reconciles only exact shared boundaries affected by one newly loaded tile.
 * Interior samples are untouched except for an adaptive slope-limited easing band.
 */
export declare function stitchTerrainNeighborhood(loaded: StitchableTerrainTile, readyTiles: readonly StitchableTerrainTile[], optionsInput?: TerrainEdgeStitchOptions | number): TerrainStitchResult;
//# sourceMappingURL=TerrainEdgeStitcher.d.ts.map