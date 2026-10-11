import type { TileId } from '../../core/tiling/GeographicTilingScheme';
import type { DecodedVectorTile, StyleLayer } from '../style/VectorStyleTypes';
import { VectorStyleRuntime } from '../style/VectorStyleRuntime';
export type SurfaceChunk = {
    layer: StyleLayer;
    order: number;
    positions: Float32Array;
    distances: Float32Array;
    indices: Uint16Array;
    bytes: number;
};
export type SurfaceBuildInput = {
    sourceId: string;
    sourceTile: TileId;
    zoom: number;
    offset: {
        x: number;
        y: number;
    };
    scale: number;
    tileSize: number;
    decoded: DecodedVectorTile;
};
export type SurfacePlan = {
    chunks: SurfaceChunk[];
    buildMs: number;
    bytes: number;
};
export declare function buildSurfacePlan(runtime: VectorStyleRuntime, input: SurfaceBuildInput): SurfacePlan;
export declare function filterToSubtile(tile: DecodedVectorTile, offset: {
    x: number;
    y: number;
}, scale: number, tileSize: number): DecodedVectorTile;
//# sourceMappingURL=VectorSurfaceBuild.d.ts.map