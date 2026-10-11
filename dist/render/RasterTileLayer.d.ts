import * as THREE from 'three';
import { Ellipsoid } from '../core/geo/Ellipsoid';
import { type SelectedTile } from '../core/lod/GlobeLodSelector';
import type { RasterTileProvider } from '../core/tiles/RasterTileProvider';
import { TileStateMachine, type TileContentKind } from '../core/tiles/TileStateMachine';
import { type TileId } from '../core/tiling/GeographicTilingScheme';
import type { TerrainHeightSource } from './TerrainTileLayer';
import type { GroundBounds, GroundPatch } from './EntityGroundSurface';
import type { SurfaceRayHit } from '../core/geo/SurfacePicker';
export type RasterTileLayerOptions = {
    /** Short-lived previous high-detail coverage on the same surface mesh. */
    continuityMs?: number;
    maxContinuityBytes?: number;
    maxContinuityPatches?: number;
    segments?: number;
    maxConcurrentRequests?: number;
    maxCachedTiles?: number;
    /** Hard resident texture budget. Defaults to 192 MiB. */
    maxTextureBytes?: number;
    surfaceOffset?: number;
    maxAnisotropy?: number;
    terrain?: TerrainHeightSource;
    visible?: boolean;
    opacity?: number;
    order?: number;
    /** Transparent surface overlay such as a label tile layer. */
    overlay?: boolean;
    /** Shared lifecycle registry. GlobeEngine supplies one registry to every raster layer. */
    tileStateMachine?: TileStateMachine;
    contentKind?: Extract<TileContentKind, 'imagery' | 'rasterized-vector'>;
};
export type RasterTileLayerStats = Readonly<{
    ready: number;
    loading: number;
    queued: number;
    errors: number;
    fallbacks: number;
    textureBytes: number;
    desiredMinimumLevel: number | null;
    desiredMaximumLevel: number | null;
    displayedMinimumLevel: number | null;
    displayedMaximumLevel: number | null;
    lastError: string | null;
    continuityPatches: number;
    continuityBytes: number;
}>;
/** Visible-leaf raster consumer. Selection remains owned by GlobeLodSelector. */
export declare class RasterTileLayer {
    readonly object3d: THREE.Group<THREE.Object3DEventMap>;
    private surfaceToken;
    private surfaceGeneration;
    /** Ready source images for per-map polar baking, including cached non-visible ancestors. */
    polarTextureSources(): readonly {
        id: TileId;
        texture: THREE.Texture;
    }[];
    /** Borrowed visible border meshes. Polar completion never requests tiles or owns these textures. */
    polarBorderMeshes(): readonly {
        id: TileId;
        mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
        north: boolean;
    }[];
    get surfaceRevision(): string;
    surfacePatches(bounds: GroundBounds): readonly GroundPatch[];
    /** Query only; no change to tile selection, DEM publication or GPU geometry. */
    pickSurface(ray: THREE.Ray): SurfaceRayHit | null;
    provider: RasterTileProvider;
    private readonly ellipsoid;
    private readonly geometries;
    private readonly baseSegments;
    private readonly renderTiles;
    /** Recently hidden exact tile meshes; no imagery/DEM textures retained. */
    private readonly spareTiles;
    private spareBytes;
    private readonly textures;
    private readonly visibleTextureKeys;
    private readonly desiredTextureKeys;
    private readonly maxConcurrentRequests;
    private readonly maxCachedTiles;
    private readonly maxTextureBytes;
    private readonly surfaceOffset;
    private readonly maxAnisotropy;
    private readonly terrain?;
    private readonly overlay;
    readonly tileStateMachine: TileStateMachine;
    private readonly contentKind;
    private layerOpacity;
    private readonly cameraHigh;
    private readonly cameraLow;
    private readonly tileOrigin;
    private frame;
    private activeRequests;
    private disposed;
    private fallbackCount;
    private suspended;
    private lastSelection;
    private lastSurfaceSelection;
    private readonly surfaceSourceLevels;
    private edgeSelection;
    private edgeRevision;
    private edgeTileSignature;
    private readonly retainedEdgePoints;
    private materialsDirty;
    private observedTerrainRevision;
    private observedProviderRevision;
    private desiredMinimumLevel;
    private desiredMaximumLevel;
    private displayedMinimumLevel;
    private displayedMaximumLevel;
    private lastError;
    private warnedProviderId;
    private readonly transitionTextures;
    private readonly continuity;
    private continuitySamplingOrder;
    private readonly continuityMs;
    private readonly maxContinuityBytes;
    private readonly maxContinuityPatches;
    private coverageRun;
    private nextContinuityExpiry;
    private observedMappingOffset;
    constructor(ellipsoid: Ellipsoid, provider: RasterTileProvider, options?: RasterTileLayerOptions);
    get visible(): boolean;
    get opacity(): number;
    setVisible(visible: boolean): void;
    setOpacity(opacity: number): void;
    setOrder(order: number): void;
    update(selection: readonly SelectedTile[], cameraPosition?: THREE.Vector3, surfaceSelection?: readonly SelectedTile[]): RasterTileLayerStats;
    get stats(): RasterTileLayerStats;
    dispose(): void;
    setProvider(provider: RasterTileProvider): void;
    handleContextLost(): void;
    handleContextRestored(): void;
    private syncRenderTiles;
    private continuityBytes;
    private captureContinuity;
    private pruneContinuity;
    private continuityTarget;
    private bindContinuity;
    /**
     * Keep the angular size of a raster triangle approximately constant through
     * the coarse globe levels. The powers of two also make every parent edge
     * sample coincide with its two children, preventing T-junction cracks.
     */
    private geometryForLevel;
    private segmentsForLevel;
    private createMaterial;
    private queueVisibleTextures;
    private queueTexture;
    private pumpQueue;
    private load;
    private completeTextureLoad;
    private failTextureLoad;
    private syncMaterials;
    private syncTerrainEdges;
    private findReadyAncestor;
    private evictTextures;
    private residentTextureBytes;
    private releaseTexture;
    private contentKey;
    private cancelTileRecord;
    private releaseActiveRequest;
    private maximumSourceLevel;
    private releaseTransitionTextures;
}
export declare function loadTextureWithFetch(url: string, signal: AbortSignal): Promise<THREE.Texture>;
//# sourceMappingURL=RasterTileLayer.d.ts.map