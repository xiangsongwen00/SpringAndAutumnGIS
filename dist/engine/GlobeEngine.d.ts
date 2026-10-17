import * as THREE from 'three';
import { CoordinateTransform } from '../core/coordinates/CoordinateTransform';
import { type SurfacePickOptions, type SurfacePickResult } from '../core/geo/SurfacePicker';
import type { ScreenPosition } from '../sdk/EntityTypes';
import type { EntityGroundSurface } from '../render/EntityGroundSurface';
import { Ellipsoid } from '../core/geo/Ellipsoid';
import { GlobeLodSelector, type GlobeLodSelectorOptions, type GlobeLodStats } from '../core/lod/GlobeLodSelector';
import { GlobeGridRenderer, type GlobeGridRendererOptions } from '../render/GlobeGridRenderer';
import { type PolarSurfaceLayerOptions } from '../render/PolarSurfaceLayer';
import type { RasterTileProvider } from '../core/tiles/RasterTileProvider';
import { TileStateMachine } from '../core/tiles/TileStateMachine';
import { TerrainLodSelector, type TerrainLodOptions } from '../core/lod/TerrainLodSelector';
import { RasterTileLayer, type RasterTileLayerOptions, type RasterTileLayerStats } from '../render/RasterTileLayer';
import type { TerrainProvider } from '../core/terrain/TerrainProvider';
import { TerrainTileLayer, type TerrainTileLayerOptions, type TerrainTileLayerStats } from '../render/TerrainTileLayer';
import { GeoJsonLayer } from '../render/GeoJsonLayer';
import { MvtVectorLayer, type MvtVectorLayerStats } from '../render/MvtVectorLayer';
import { FrameWorkBudget } from '../core/tiles/FrameWorkBudget';
import { GlobeCameraController, type GlobeCameraViewState, type GlobeFlyToOptions } from './GlobeCameraController';
export type GlobeFramePerformance = Readonly<{
    lodMs: number;
    terrainMs: number;
    surfaceMs: number;
    featureMs: number;
    renderSubmitMs: number;
    drawCalls: number;
    triangles: number;
    gpuMs: number | null;
    lodSelections: number;
}>;
export type GlobeEngineStats = GlobeLodStats & Readonly<{
    cameraLevel: number;
    imagery: RasterTileLayerStats | null;
    terrain: TerrainTileLayerStats | null;
    surfaceTiles: number;
    terrainSurfaceLimited: number;
    vectorLayers: ReadonlyMap<string, MvtVectorLayerStats>;
    performance: GlobeFramePerformance;
}>;
/** A disposable scene overlay, independent of the tile/terrain LOD pipeline. */
export interface GlobeSceneLayer {
    readonly object3d: THREE.Object3D;
    update(camera: THREE.PerspectiveCamera, width: number, height: number): void;
    dispose(): void;
}
export type GlobeNavigationOptions = {
    /** Maximum orbit speed used at global scale. */
    rotateSpeed?: number;
    /** Minimum orbit speed close to the surface. */
    minRotateSpeed?: number;
    /** Maximum wheel/pinch speed used at global scale. */
    zoomSpeed?: number;
    /** Minimum wheel/pinch speed close to the surface. */
    minZoomSpeed?: number;
    dampingFactor?: number;
    /** Closest camera altitude above the reference ellipsoid, in metres. */
    minAltitude?: number;
    /** Multiplier applied to altitude-proportional wheel speed near the surface. */
    zoomAltitudeGain?: number;
    /** Right-drag surface-focus orbit sensitivity. */
    lookSpeed?: number;
    /** Middle-drag surface-tilt sensitivity. */
    tiltSpeed?: number;
};
export type GlobeEngineOptions = {
    container: HTMLElement;
    pixelRatio?: number;
    /** Caps the drawing-buffer area after DPR scaling. Defaults to 8 megapixels. */
    maxDrawingBufferPixels?: number;
    clearColor?: number;
    lod?: GlobeLodSelectorOptions;
    grid?: GlobeGridRendererOptions;
    imagery?: false | RasterTileProvider;
    raster?: RasterTileLayerOptions;
    terrain?: false | TerrainProvider;
    /** Configure a provider while disabling DEM requests from the first frame. */
    terrainEnabled?: boolean;
    terrainLayer?: TerrainTileLayerOptions;
    /** Independent DEM error LOD (Mercator). false restores shared selection. */
    terrainLod?: false | TerrainLodOptions;
    /** Mercator-domain completion, not genuine polar imagery/DEM. Enabled by default for Mercator grids. */
    polarSurface?: boolean | PolarSurfaceLayerOptions;
    initialView?: {
        longitude: number;
        latitude: number;
        altitude: number;
    };
    navigation?: GlobeNavigationOptions;
    onStats?: (stats: GlobeEngineStats) => void;
    /** Optional lightweight profiler; runs each frame, unlike throttled UI stats. */
    onFramePerformance?: (timing: GlobeFramePerformance) => void;
};
/** Stage-one globe runtime: camera + WGS84 ellipsoid + geographic quadtree grid. */
export declare class GlobeEngine {
    readonly backgroundWorkBudget: FrameWorkBudget;
    readonly entityGroundSurface: EntityGroundSurface;
    pickPositionDetailed(screen: ScreenPosition, options?: SurfacePickOptions): SurfacePickResult | null;
    private framePerformance;
    private readonly gpuTimer;
    private lodSelections;
    readonly scene: THREE.Scene<THREE.Object3DEventMap>;
    readonly camera: THREE.PerspectiveCamera;
    readonly renderer: THREE.WebGLRenderer;
    readonly controls: GlobeCameraController;
    readonly ellipsoid: Ellipsoid;
    readonly coordinates: CoordinateTransform;
    readonly lod: GlobeLodSelector;
    readonly grid: GlobeGridRenderer;
    private _imagery;
    get imagery(): RasterTileLayer | null;
    readonly terrain: TerrainTileLayer | null;
    readonly terrainLod: TerrainLodSelector | null;
    private surfaceSelection;
    private surfaceSignature;
    private readonly maxSurfaceTiles;
    private terrainSurfaceLimited;
    private readonly polarSurface;
    /** Shared per-content lifecycle registry for all raster surface layers. */
    readonly tileStateMachine: TileStateMachine;
    private readonly container;
    private readonly onStats?;
    private readonly onFramePerformance?;
    private frameHandle;
    private lastStatsSignature;
    private viewportWidth;
    private viewportHeight;
    private rendererPixelRatio;
    private readonly requestedPixelRatio;
    private readonly maxDrawingBufferPixels;
    private readonly resizeObserver;
    private readonly navigation;
    private readonly terrainMaximumSurfaceDisplacement;
    private lodSelection;
    private lodSelectionTerrainRevision;
    private lodSelectionViewportWidth;
    private lodSelectionViewportHeight;
    private lodSelectionMinimumLevel;
    private observedTerrainRevision;
    private terrainRevisionRefreshAt;
    private readonly lodCameraPosition;
    private readonly lodCameraQuaternion;
    private contextLost;
    private disposed;
    private readonly imageryLayers;
    private readonly featureLayers;
    private readonly vectorLayers;
    private readonly sceneLayers;
    private readonly imageryLayerOptions;
    private readonly onContextLost;
    private readonly onContextRestored;
    constructor(options: GlobeEngineOptions);
    start(): void;
    stop(): void;
    dispose(): void;
    setImageryProvider(provider: RasterTileProvider): void;
    /** Configuration-level handoff; does not wait for all viewport tiles. */
    replaceBaseImagery(provider: RasterTileProvider | null): void;
    setLodGridVisible(visible: boolean): void;
    /** Adds a raster surface layer. Annotation layers should use overlay=true. */
    addImageryLayer(id: string, provider: RasterTileProvider, options?: RasterTileLayerOptions): RasterTileLayer;
    removeImageryLayer(id: string): boolean;
    getImageryLayer(id: string): RasterTileLayer | undefined;
    addFeatureLayer(id: string, layer: GeoJsonLayer): GeoJsonLayer;
    removeFeatureLayer(id: string): boolean;
    getFeatureLayer(id: string): GeoJsonLayer | undefined;
    addSceneLayer(id: string, layer: GlobeSceneLayer): void;
    removeSceneLayer(id: string): boolean;
    addVectorLayer(id: string, layer: MvtVectorLayer): MvtVectorLayer;
    removeVectorLayer(id: string): boolean;
    getVectorLayer(id: string): MvtVectorLayer | undefined;
    setTerrainEnabled(enabled: boolean): void;
    flyTo(options: GlobeFlyToOptions): void;
    setCameraPitch(pitch: number): void;
    getCameraViewState(): GlobeCameraViewState;
    getPolarSurfaceState(): Readonly<{
        mapId: string | null;
        north: {
            mode: "fallback" | "style" | "sampled";
            coverage: number;
        };
        south: {
            mode: "fallback" | "style" | "sampled";
            coverage: number;
        };
        warming: boolean;
        queued: number;
        failures: number;
        cachedMaps: number;
        textureBytes: number;
    }> | null;
    /** Continuous camera level using the same screen-error scale as the LOD selector. */
    getCameraLevel(): number;
    private resize;
    private updateNavigationSensitivity;
    private cameraAltitude;
    private focalPixels;
    private altitudeForCameraLevel;
    private surfaceRadiusInDirection;
    private terrainHeightUnderCamera;
    private emitStats;
}
//# sourceMappingURL=GlobeEngine.d.ts.map