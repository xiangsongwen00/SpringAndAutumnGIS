import type { TileId } from '../tiling/GeographicTilingScheme';
import { type RasterTileProvider } from './RasterTileProvider';
export type WmtsResourceUrl = Readonly<{
    format: string;
    resourceType: string;
    template: string;
}>;
export type WmtsLayer = Readonly<{
    identifier: string;
    title?: string;
    formats: readonly string[];
    styles: readonly Readonly<{
        identifier: string;
        isDefault: boolean;
    }>[];
    tileMatrixSets: readonly string[];
    tileMatrixSetLinks: readonly WmtsTileMatrixSetLink[];
    resourceUrls: readonly WmtsResourceUrl[];
}>;
export type WmtsTileMatrixLimit = Readonly<{
    tileMatrix: string;
    minTileRow: number;
    maxTileRow: number;
    minTileCol: number;
    maxTileCol: number;
}>;
export type WmtsTileMatrixSetLink = Readonly<{
    identifier: string;
    limits: readonly WmtsTileMatrixLimit[];
}>;
export type WmtsTileMatrix = Readonly<{
    identifier: string;
    scaleDenominator: number;
    topLeftCorner: readonly [number, number];
    tileWidth: number;
    tileHeight: number;
    matrixWidth: number;
    matrixHeight: number;
}>;
export type WmtsTileMatrixSet = Readonly<{
    identifier: string;
    supportedCrs: string;
    matrices: readonly WmtsTileMatrix[];
}>;
export type WmtsCapabilities = Readonly<{
    version: string;
    getTileKvpUrl?: string;
    layers: readonly WmtsLayer[];
    tileMatrixSets: readonly WmtsTileMatrixSet[];
}>;
export type WmtsRasterProviderOptions = Readonly<{
    id?: string;
    capabilities: WmtsCapabilities;
    layer: string;
    tileMatrixSet: string;
    style?: string;
    format?: string;
    requestEncoding?: 'auto' | 'rest' | 'kvp';
    /** Replaces the advertised endpoint origin, typically with a same-origin dev proxy. */
    endpointBaseUrl?: string;
    levelOffset?: number;
    attribution?: string;
}>;
export declare function loadWmtsCapabilities(url: string, fetcher?: typeof fetch): Promise<WmtsCapabilities>;
/** Namespace-tolerant WMTS 1.0.0 parser that also works in Node without DOMParser. */
export declare function parseWmtsCapabilities(xml: string): WmtsCapabilities;
/** Raster provider created from advertised WMTS matrix identifiers and REST/KVP endpoints. */
export declare class WmtsRasterProvider implements RasterTileProvider {
    readonly id: string;
    readonly minLevel = 0;
    readonly maxLevel: number;
    readonly levelOffset = 0;
    readonly estimatedTextureBytes: number;
    readonly attribution?: string;
    private readonly layer;
    private readonly matrixSet;
    private readonly matrixSetLink;
    private readonly style;
    private readonly format;
    private readonly restTemplate?;
    private readonly kvpUrl?;
    private readonly endpointBaseUrl?;
    private _viewLevelOffset;
    private viewSourceLevel;
    private _revision;
    constructor(options: WmtsRasterProviderOptions);
    get revision(): number;
    get viewLevelOffset(): number | null;
    get currentSourceLevel(): number;
    setViewLevel(cameraLevel: number): void;
    setViewLevelOffset(offset: number | null): void;
    maximumSourceLevel(renderLevel: number): number;
    hasTile(tile: TileId): boolean;
    url(tile: TileId): string;
}
//# sourceMappingURL=WmtsSource.d.ts.map