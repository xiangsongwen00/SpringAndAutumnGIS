export type TileId = Readonly<{
    level: number;
    x: number;
    y: number;
}>;
export type Rectangle = Readonly<{
    west: number;
    south: number;
    east: number;
    north: number;
}>;
export interface TilingScheme {
    readonly id: string;
    readonly levelZeroTilesX: number;
    readonly levelZeroTilesY: number;
    rootTiles(): TileId[];
    children(tile: TileId): TileId[];
    rectangle(tile: TileId): Rectangle;
}
/** EPSG:4326-like quadtree: level zero contains two 180-by-180-degree roots. */
export declare class GeographicTilingScheme implements TilingScheme {
    readonly id = "geographic";
    readonly levelZeroTilesX = 2;
    readonly levelZeroTilesY = 1;
    rootTiles(): TileId[];
    children(tile: TileId): TileId[];
    rectangle(tile: TileId): Rectangle;
}
export declare function quadtreeChildren(tile: TileId): TileId[];
export declare function tileKey(tile: TileId): string;
//# sourceMappingURL=GeographicTilingScheme.d.ts.map