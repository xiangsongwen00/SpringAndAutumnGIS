import * as THREE from 'three';
import type { TileId } from '../tiling/GeographicTilingScheme';
import { type RasterTileProvider } from './RasterTileProvider';
import type { MapStyleCapabilityReport } from '../../vector/style/MapStyleLoader';
import type { MapStyle } from '../../vector/style/VectorStyleTypes';
import { type PolarStylePalette } from '../../render/PolarStyle';
export type MvtRasterProviderOptions = Readonly<{
    id?: string;
    urlTemplate?: string;
    tileJsonUrl?: string;
    styleUrl?: string;
    style?: MapStyle;
    sourceId?: string;
    scheme?: 'xyz' | 'tms';
    subdomains?: readonly string[];
    minLevel?: number;
    maxLevel?: number;
    levelOffset?: number;
    viewLevelOffset?: number | null;
    minimumLodLevelOffset?: number;
    showCountryLabels?: boolean;
    tileSize?: number;
    bounds?: readonly [number, number, number, number];
    attribution?: string;
    fetcher?: typeof fetch;
}>;
/**
 * Generic MVT compatibility provider.
 *
 * It preserves vector decoding and custom Style v8 evaluation, then produces a
 * transparent raster tile so the existing surface compositor can drape it on
 * the exact same terrain mesh as imagery.
 */
export declare class MvtRasterProvider implements RasterTileProvider {
    readonly id: string;
    readonly minLevel: number;
    private resolvedMaxLevel;
    readonly levelOffset: number;
    readonly minimumLodLevelOffset: number;
    readonly estimatedTextureBytes: number;
    readonly attribution?: string;
    private readonly styleLoader;
    private readonly decoder;
    private readonly rasterizer;
    private readonly directSource?;
    private readonly bounds?;
    private readonly fetcher?;
    private source;
    private viewSourceLevel;
    private _viewLevelOffset;
    private _revision;
    private polarKey;
    private paletteReady;
    polarStylePalette: PolarStylePalette | null;
    get polarAppearanceKey(): string;
    constructor(options: MvtRasterProviderOptions);
    get revision(): number;
    get currentSourceLevel(): number;
    get viewLevelOffset(): number | null;
    setViewLevel(cameraLevel: number): void;
    setViewLevelOffset(offset: number | null): void;
    maximumSourceLevel(renderLevel: number): number;
    get maxLevel(): number;
    initialize(): Promise<void>;
    styleCapabilities(): Promise<MapStyleCapabilityReport>;
    hasTile(tile: TileId): boolean;
    url(tile: TileId): string;
    loadTexture(tile: TileId, signal?: AbortSignal): Promise<THREE.Texture>;
}
//# sourceMappingURL=MvtRasterProvider.d.ts.map