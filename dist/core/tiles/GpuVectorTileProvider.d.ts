import * as THREE from 'three';
import { UrlTemplateRasterProvider } from './RasterTileProvider';
import type { TileId } from '../tiling/GeographicTilingScheme';
import { type MapStyleLoaderOptions } from '../../vector/style/MapStyleLoader';
import type { VectorSource } from '../../vector/style/VectorStyleTypes';
import type { MapStyleCapabilityReport } from '../../vector/style/MapStyleLoader';
import type { FrameWorkBudget } from './FrameWorkBudget';
import type { DecodedVectorTile } from '../../vector/style/VectorStyleTypes';
import { type PolarStylePalette } from '../../render/PolarStyle';
export type GpuVectorTileProviderOptions = MapStyleLoaderOptions & {
    id: string;
    renderer: THREE.WebGLRenderer;
    levelOffset?: number;
    minLevel?: number;
    maxLevel?: number;
    tileSize?: number;
    /** maxLevel is the network/PBF cap; display zoom remains independent. */
    displayMaxLevel?: number;
    maxDrawsPerFrame?: number;
    drawBudgetMs?: number;
    /** Catalog overrides; scheme changes request rows only, never MVT geometry. */
    source?: Partial<VectorSource>;
    workBudget?: FrameWorkBudget;
    maxUploadBytesPerFrame?: number;
    maxDrawChunksPerFrame?: number;
    /** Backpressure across worker preparation and unpublished RenderTargets. */
    maxPreparedTiles?: number;
};
/** GPU cartographic surface pass; textures drape on the shared terrain mesh.
 * No Canvas rasterizer. Symbols belong to a later independent placement pass.
 */
export declare class GpuVectorTileProvider extends UrlTemplateRasterProvider {
    private readonly loader;
    private readonly decoder;
    private readonly renderer;
    private readonly loaderFetcher?;
    private readonly tileSize;
    private readonly sourceOverride?;
    private _dataMaxLevel;
    private readonly configuredDataMaxLevel?;
    private readonly decodedTiles;
    private readonly maxDrawsPerFrame;
    private readonly drawBudgetMs;
    private readonly workBudget?;
    private drawFrame;
    private readonly drawQueue;
    private readonly surfaceBuilder;
    private readonly maxUploadBytesPerFrame;
    private readonly maxDrawChunksPerFrame;
    private building;
    private readonly maxPreparedTiles;
    private occupiedSlots;
    private readonly slotWaiters;
    private lastBuildMs;
    private lastUploadBytes;
    private lastDrawMs;
    private maxDrawMs;
    private readonly recentDraws;
    private issues;
    private initialized;
    private polarStyleKey;
    polarStylePalette: PolarStylePalette | null;
    get polarAppearanceKey(): string;
    private source;
    private sourceId;
    private readonly camera;
    private readonly surfaceMaterials;
    private disposed;
    private contextWasLost;
    private unsupportedLayers;
    capabilityReport: MapStyleCapabilityReport | null;
    readonly limitations: string[];
    constructor(options: GpuVectorTileProviderOptions);
    initialize(): Promise<void>;
    get styleIssues(): Readonly<{
        layerId: string;
        property: string;
        message: string;
    }>[];
    get dataMaxLevel(): number;
    get decodedCacheStats(): Readonly<{
        queued: number;
        active: number;
        cached: number;
        cacheBytes: number;
    }>;
    get drawStats(): {
        queued: number;
        lastMs: number;
        maxMs: number;
        worker: boolean;
        building: number;
        buildMs: number;
        uploadBytes: number;
        workerQueueMs: number;
        workerRoundTripMs: number;
        workerPostMs: number;
        recentCount: number;
        recentSteps: number;
        recentMs: number;
    };
    loadTexture(id: TileId, signal?: AbortSignal): Promise<THREE.Texture>;
    /** Shared PBF/Worker cache for the independent symbol pass; local XYZ UVs. */
    loadVectorTile(id: TileId, signal?: AbortSignal): Promise<DecodedVectorTile>;
    private loadSourceTile;
    private drawChunk;
    private acquireSlot;
    private releaseSlot;
    private warmPrograms;
    private materialForChunk;
    private enqueueDraw;
    private scheduleDrawFrame;
    dispose(): void;
}
//# sourceMappingURL=GpuVectorTileProvider.d.ts.map