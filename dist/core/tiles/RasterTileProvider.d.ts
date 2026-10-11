import type { TileId } from '../tiling/GeographicTilingScheme';
import type * as THREE from 'three';
import { type PolarStylePalette } from '../../render/PolarStyle';
/** Default continuous mapping: source zoom = floor(camera zoom + offset). */
export declare const DEFAULT_LEVEL_OFFSET = -1.7;
export interface RasterTileProvider {
    readonly id: string;
    readonly minLevel: number;
    readonly maxLevel: number;
    /** Data zoom = globe LOD zoom + levelOffset. Only zero or negative offsets are supported. */
    readonly levelOffset?: number;
    /** @deprecated Engine no longer forces a provider's minimum across the viewport. */
    readonly minimumLodLevelOffset?: number;
    /** Receives the continuous camera level before each selection/update. */
    setViewLevel?(cameraLevel: number): void;
    /** Changes the continuous camera-to-source zoom offset for diagnostics. */
    setViewLevelOffset?(offset: number | null): void;
    /** Current continuous camera-to-source zoom offset. */
    readonly viewLevelOffset?: number | null;
    /** Current integer data zoom selected from the continuous camera level. */
    readonly currentSourceLevel?: number;
    /** Increments when source-level mapping changes without replacing the provider. */
    readonly revision?: number;
    /** Approximate resident GPU bytes reserved by one decoded texture, including mipmaps. */
    readonly estimatedTextureBytes?: number;
    /** Resolves the highest data level allowed for a globe render tile. */
    maximumSourceLevel?(renderLevel: number): number;
    readonly attribution?: string;
    /** Stable configuration/style identity, independent of camera/source LOD revision. */
    readonly polarAppearanceKey?: string;
    readonly polarStylePalette?: PolarStylePalette | null;
    /** Returns false when the source has no content for this tile. */
    hasTile?(tile: TileId): boolean;
    url(tile: TileId): string;
    loadTexture?(tile: TileId, signal?: AbortSignal): Promise<THREE.Texture>;
}
export type UrlTemplateRasterProviderOptions = {
    id?: string;
    urlTemplate: string;
    minLevel?: number;
    maxLevel?: number;
    levelOffset?: number;
    /** Optional data zoom = floor(camera zoom + offset), e.g. -1.7. */
    viewLevelOffset?: number | null;
    attribution?: string;
    subdomains?: readonly string[];
    tileSize?: number;
    /** Geographic coverage [west, south, east, north] in WGS84 degrees. */
    bounds?: readonly [number, number, number, number];
};
/** XYZ URL template provider supporting {z}, {x}, {y} and optional {s}. */
export declare class UrlTemplateRasterProvider implements RasterTileProvider {
    readonly id: string;
    readonly minLevel: number;
    readonly maxLevel: number;
    readonly levelOffset: number;
    readonly estimatedTextureBytes: number;
    readonly attribution?: string;
    private readonly urlTemplate;
    private readonly subdomains;
    private readonly bounds?;
    private _viewLevelOffset;
    private viewSourceLevel;
    private _revision;
    private readonly polarKey;
    get polarAppearanceKey(): string;
    constructor(options: UrlTemplateRasterProviderOptions);
    get revision(): number;
    get currentSourceLevel(): number;
    get viewLevelOffset(): number | null;
    setViewLevel(cameraLevel: number): void;
    setViewLevelOffset(offset: number | null): void;
    maximumSourceLevel(renderLevel: number): number;
    hasTile(tile: TileId): boolean;
    url(tile: TileId): string;
}
//# sourceMappingURL=RasterTileProvider.d.ts.map