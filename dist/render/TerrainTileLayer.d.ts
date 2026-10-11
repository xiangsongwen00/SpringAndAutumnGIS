import * as THREE from 'three';
import { Ellipsoid } from '../core/geo/Ellipsoid';
import { type SelectedTile } from '../core/lod/GlobeLodSelector';
import type { SurfaceDisplacementBoundsSource } from '../core/lod/GlobeLodSelector';
import type { SurfaceDisplacementRange } from '../core/lod/GlobeLodSelector';
import { type TerrainProvider } from '../core/terrain/TerrainProvider';
import { type TileId } from '../core/tiling/GeographicTilingScheme';
import type { FrameWorkBudget } from '../core/tiles/FrameWorkBudget';
export type TerrainTileLayerOptions = {
    /** Experimental transactional coverage. Not visually accepted; opt in only. */
    regionalCoverage?: boolean;
    /** Engine supplies independent DEM leaves instead of imagery leaves. */
    independentSelection?: boolean;
    /** Schedules the existing LOD leaves; it does not change selection/DEM precision. */
    requestPriority?: 'camera-near' | 'screen-error';
    /** Opt in: one far request may yield after camera motion; off by default. */
    preemptFarDetail?: boolean;
    segments?: number;
    maxConcurrentRequests?: number;
    maxCachedTiles?: number;
    /** Combined CPU heightfield and GPU texture budget. Defaults to 96 MiB. */
    maxResourceBytes?: number;
    exaggeration?: number;
    /** Draw a standalone coloured terrain mesh for diagnostics. */
    showDebugSurface?: boolean;
    /** Bounded DEM publication/upload per update. Defaults: 2 tiles, 2ms, 1MiB. */
    maxCommitsPerFrame?: number;
    commitBudgetMs?: number;
    maxUploadBytesPerFrame?: number;
    /** Engine supplies renderer.initTexture so uploads happen inside the budget. */
    prepareTexture?: (texture: THREE.DataTexture) => void;
    workBudget?: FrameWorkBudget;
    /** Bound fetch+decode slot occupancy. Timeout preserves the committed parent. */
    requestTimeoutMs?: number;
};
export type TerrainTileLayerStats = Readonly<{
    ready: number;
    loading: number;
    queued: number;
    errors: number;
    fallbacks: number;
    resourceBytes: number;
    stitchedEdges: number;
    coverageReady: boolean;
    stitchLastMs: number;
    stitchMaxMs: number;
    pending: number;
    committed: number;
    commitMs: number;
    /** Uploaded resources are not necessarily part of the displayed surface. */
    displayed: number;
    waitingRegions: number;
    qualityLimitedRegions: number;
    displayGeneration: number;
    preparingPatches: number;
    prepareMs: number;
    timeouts: number;
    requestPriority: 'camera-near' | 'screen-error';
    preemptedRequests: number;
    lodMode: 'independent' | 'shared';
    targetTiles: number;
    targetMinimumLevel: number | null;
    targetMaximumLevel: number | null;
    readyTargets: number;
    /** Resolved DEM source levels for current targets (not mesh/request levels). */
    sourceMinimumLevel: number | null;
    sourceMaximumLevel: number | null;
}>;
export type TerrainTextureBinding = Readonly<{
    key: string;
    texture: THREE.Texture;
    scale: number;
    offsetX: number;
    offsetY: number;
    sourceLevel: number;
    width: number;
    height: number;
    parentKey: string;
    parentTexture: THREE.Texture | null;
    parentScale: number;
    parentOffsetX: number;
    parentOffsetY: number;
}>;
export interface TerrainHeightSource extends SurfaceDisplacementBoundsSource {
    readonly revision: number;
    readonly exaggeration: number;
    readonly enabled: boolean;
    resolveTexture(id: TileId): TerrainTextureBinding | undefined;
    sampleHeight(longitude: number, latitude: number): number | null;
    /** CPU equivalent of resolveTexture + shader UV sampling, including exaggeration. */
    sampleTileHeight?(id: TileId, u: number, v: number): number | null;
    /** Resolve an immutable ancestor once for all boundary samples. */
    tileHeightSampler?(id: TileId): {
        key: string;
        sample: (u: number, v: number) => number;
    };
    /** Token of the actual height source used by sampleHeight at an anchor. */
    heightVersionAt?(longitude: number, latitude: number): string;
    /** False only for newly exposed holes after an initial trustworthy surface. */
    hasSurfaceCoverage?(id: TileId): boolean;
}
/** Read-only terrain surface with CPU heightfields and GPU vertex displacement. */
export declare class TerrainTileLayer implements TerrainHeightSource {
    readonly object3d: THREE.Group<THREE.Object3DEventMap>;
    readonly provider: TerrainProvider;
    readonly exaggeration: number;
    private readonly ellipsoid;
    private readonly baseSegments;
    private readonly maxConcurrentRequests;
    private readonly maxCachedTiles;
    private readonly maxResourceBytes;
    private readonly showDebugSurface;
    private readonly geometries;
    private readonly records;
    private readonly renderTiles;
    private readonly visibleKeys;
    private readonly cameraHigh;
    private readonly cameraLow;
    private frame;
    private activeRequests;
    private fallbackCount;
    private disposed;
    private suspended;
    private _enabled;
    private _revision;
    private readonly knownHeightRanges;
    private lastSelection;
    private materialsDirty;
    private stitchedEdges;
    private stitchLastMs;
    private stitchMaxMs;
    private coverageReady;
    private hasInitialCoverage;
    private readonly publishedKeys;
    private readonly displayKeys;
    private readonly bindings;
    private readonly displayedData;
    private readonly displaySignatures;
    private preparation;
    private readonly pressureBlockedRegions;
    private schedulerDirty;
    private needsPublication;
    private waitingRegions;
    private qualityLimitedRegions;
    private displayGeneration;
    private uploadedBytes;
    private prepareMs;
    private estimatedTileBytes;
    private readonly maxCommitsPerFrame;
    private readonly commitBudgetMs;
    private readonly maxUploadBytesPerFrame;
    private readonly prepareTexture?;
    private committed;
    private commitMs;
    private readonly workBudget?;
    private readonly requestTimeoutMs;
    private readonly regionalCoverage;
    private timeouts;
    private readonly requestPriority;
    private readonly preemptFarDetail;
    private readonly coordinates;
    private readonly priorityCamera;
    private hasPriorityCamera;
    private prioritySelection;
    private prioritized;
    private priorityRevision;
    private readonly requestDistances;
    private detailTurns;
    private lastPreemption;
    private preemptedRequests;
    private nextNearRequest;
    private readonly independentSelection;
    private preemptionArmed;
    constructor(ellipsoid: Ellipsoid, provider: TerrainProvider, options?: TerrainTileLayerOptions);
    get revision(): number;
    get enabled(): boolean;
    /** Reserve space for parents/in-flight work rather than pinning a full cache. */
    get targetCapacity(): number;
    /** Actual loaded/displayed footprints for common surface tessellation. */
    surfaceTiles(): readonly SelectedTile[];
    hasSurfaceCoverage(id: TileId): boolean;
    get stats(): TerrainTileLayerStats;
    update(selection: readonly SelectedTile[], cameraPosition?: THREE.Vector3): TerrainTileLayerStats;
    resolveTexture(id: TileId): TerrainTextureBinding | undefined;
    sampleTileHeight(id: TileId, u: number, v: number): number | null;
    tileHeightSampler(id: TileId): {
        key: string;
        sample: (u: number, v: number) => number;
    };
    heightVersionAt(longitude: number, latitude: number): string;
    sampleHeight(longitude: number, latitude: number): number | null;
    maximumHeight(id: TileId): number | null;
    heightRange(id: TileId): SurfaceDisplacementRange | null;
    dispose(): void;
    setEnabled(enabled: boolean): void;
    handleContextLost(): void;
    handleContextRestored(): void;
    private syncRenderTiles;
    private geometryForLevel;
    private get useNearPriority();
    private refreshPriorityCamera;
    private orderSelection;
    private queueVisibleTiles;
    private updateLegacy;
    private queueLegacyTiles;
    private refreshCoverage;
    /** One parent family: at most four equal-level visible target patches. */
    private regions;
    private publishRegions;
    private findDisplayAncestor;
    private findCommittedAncestor;
    private parentEdgeMask;
    private advancePreparation;
    private cancelPreparation;
    private queueTile;
    private eligible;
    private chooseRequest;
    private preemptDistantDetail;
    private pumpQueue;
    private load;
    private commitPending;
    private cancelRequest;
    private releaseActiveRequest;
    private syncMaterials;
    private findReadyAncestor;
    private evictTiles;
    private makeRequestRoom;
    private residentResourceBytes;
    private releaseTexture;
    /** Legacy diagnostic helper; normal loading preserves immutable raw DEM. */
    private stitchLoadedTerrain;
    private createMaterial;
}
//# sourceMappingURL=TerrainTileLayer.d.ts.map