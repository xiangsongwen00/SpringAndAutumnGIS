import { type Rectangle, type TileId, type TilingScheme } from './GeographicTilingScheme';
/** Standard slippy-map XYZ quadtree used by raster tile servers. */
export declare class WebMercatorTilingScheme implements TilingScheme {
    readonly id = "web-mercator";
    readonly levelZeroTilesX = 1;
    readonly levelZeroTilesY = 1;
    rootTiles(): TileId[];
    children(tile: TileId): TileId[];
    rectangle(tile: TileId): Rectangle;
}
//# sourceMappingURL=WebMercatorTilingScheme.d.ts.map