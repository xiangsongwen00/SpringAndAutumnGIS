import type { TileId } from '../../core/tiling/GeographicTilingScheme';
import type { DecodedFeature } from '../style/VectorStyleTypes';
export type GeometryBuilder = {
    coordinates: number[];
    positions: number[];
    heights: number[];
    indices: number[];
    uvs: number[];
    distances?: number[];
};
/** Pixel-width stroke quads for the cartographic GPU surface pass (butt caps). */
export declare function buildLineStrokeGeometry(id: TileId, features: readonly DecodedFeature[], width: number, tileSize: number): GeometryBuilder;
export declare function buildFillGeometry(id: TileId, features: readonly DecodedFeature[], subdivide?: boolean): GeometryBuilder;
export declare function buildBackgroundGeometry(id: TileId): GeometryBuilder;
export declare function buildLineGeometry(id: TileId, features: readonly DecodedFeature[]): GeometryBuilder;
export declare function buildPointGeometry(id: TileId, features: readonly DecodedFeature[]): GeometryBuilder;
export declare function firstPoint(id: TileId, feature: DecodedFeature): readonly [number, number] | null;
/** Convert public/terrain degree coordinates to the native globe shader contract. */
export declare function geographicDegreesToShaderRadians(longitude: number, latitude: number): readonly [number, number];
export declare function webMercatorTileBounds(id: TileId): readonly [number, number, number, number];
export declare function ancestorAtLevel(id: TileId, level: number): TileId;
//# sourceMappingURL=VectorGeometryBuilder.d.ts.map