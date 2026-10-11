import * as THREE from 'three';
import type { TileId } from '../tiling/GeographicTilingScheme';
export type TerrainTileScheme = 'xyz' | 'tms';
export type TerrainRgbEncoding = 'mapbox' | 'terrarium';
export type TerrainTileData = {
    readonly id: TileId;
    readonly width: number;
    readonly height: number;
    readonly heights: Float32Array;
    readonly minimumHeight: number;
    readonly maximumHeight: number;
    readonly texture: THREE.DataTexture;
};
export interface TerrainProvider {
    readonly id: string;
    readonly minLevel: number;
    readonly maxLevel: number;
    readonly attribution?: string;
    /** Dataset geometric error in metres. Omit to use the explicit LOD estimate. */
    geometricError?(tile: TileId): number;
    loadTile(tile: TileId, signal?: AbortSignal): Promise<TerrainTileData>;
}
export type TerrainRgbProviderOptions = {
    id?: string;
    /** Ordered failover templates. Tile coordinates passed to the provider stay XYZ. */
    urlTemplates?: readonly string[];
    /** Optional TileJSON endpoint. Its tiles/minzoom/maxzoom/scheme fill missing options. */
    tileJsonUrl?: string;
    scheme?: TerrainTileScheme;
    encoding?: TerrainRgbEncoding;
    minLevel?: number;
    maxLevel?: number;
    attribution?: string;
    /** Explicit flat height for 404/204 coverage gaps only. Omit to keep ancestor fallback; never applied to 401/403. */
    noDataHeight?: number;
};
/** Loads Terrain-RGB pixels into a CPU-queryable float heightfield and GPU texture. */
export declare class TerrainRgbProvider implements TerrainProvider {
    readonly id: string;
    readonly minLevel: number;
    readonly attribution?: string;
    private readonly configuredTemplates;
    private readonly tileJsonUrl?;
    private readonly configuredScheme?;
    private readonly encoding;
    private readonly configuredMaxLevel;
    private readonly noDataHeight?;
    private metadataPromise;
    private resolvedMaxLevel;
    private readonly disabledTemplates;
    private readonly warnedTemplates;
    constructor(options: TerrainRgbProviderOptions);
    get maxLevel(): number;
    loadTile(tile: TileId, signal?: AbortSignal): Promise<TerrainTileData>;
    private metadata;
    private loadMetadata;
}
export declare function sampleTerrainTile(data: TerrainTileData, u: number, v: number): number;
/** Decode one RGB triplet without requiring DOM image APIs; useful for tests and workers. */
export declare function decodeTerrainRgbHeight(red: number, green: number, blue: number, encoding?: TerrainRgbEncoding): number;
//# sourceMappingURL=TerrainProvider.d.ts.map