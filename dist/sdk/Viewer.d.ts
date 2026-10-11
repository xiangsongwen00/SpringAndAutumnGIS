import { GlobeEngine, type GlobeEngineOptions } from '../engine/GlobeEngine';
import { type RasterTileProvider } from '../core/tiles/RasterTileProvider';
import type { MapStyle } from '../vector/style/VectorStyleTypes';
import type { MapStyleCapabilityReport } from '../vector/style/MapStyleLoader';
import type { TerrainProvider } from '../core/terrain/TerrainProvider';
import type { GlobeFlyToOptions } from '../engine/GlobeCameraController';
import { EntityCollection } from './EntityCollection';
import { EntityDrawingController } from './EntityDrawingController';
import { MeasurementController, measureDistance, measureArea } from './Measurement';
import { ViewerToolbar, type ViewerToolbarOptions } from './ViewerToolbar';
import type { EntitySnapshot, EntityPickOptions, ScreenPosition, EntityResourceState, EntityGroundState } from './EntityTypes';
import type { Cartographic } from '../core/geo/Ellipsoid';
import type { SurfacePickOptions, SurfacePickResult } from '../core/geo/SurfacePicker';
export type BaseMapDefinition = {
    id: string;
    type: 'xyz';
    url: string;
    scheme?: 'xyz' | 'tms';
    minLevel?: number;
    maxLevel?: number;
    levelOffset?: number | null;
    attribution?: string;
} | {
    id: string;
    type: 'provider';
    provider: RasterTileProvider;
} | {
    id: string;
    type: 'vector-style';
    style: string | MapStyle;
    sourceId?: string;
    levelOffset?: number;
    symbols?: boolean;
    fetcher?: typeof fetch;
};
export type ViewerOptions = Omit<GlobeEngineOptions, 'container' | 'imagery' | 'terrain' | 'terrainEnabled'> & {
    basemaps?: readonly BaseMapDefinition[];
    /** Omitted selects the first definition; null starts without a base map. */
    baseMap?: string | null;
    terrain?: false | {
        provider: TerrainProvider;
        enabled?: boolean;
    };
    showLodGrid?: boolean;
    autoStart?: boolean;
    /** Cancels creation/configuration loading; not the lifetime of a ready Viewer. */
    signal?: AbortSignal;
    /** Optional bundled icon toolbar, disabled unless requested. */
    toolbar?: boolean | ViewerToolbarOptions;
};
export type ViewerErrorCode = 'INVALID_OPTIONS' | 'DESTROYED' | 'ABORTED' | 'BASEMAP_LOAD_FAILED' | 'TERRAIN_UNAVAILABLE';
export declare class ViewerError extends Error {
    readonly code: ViewerErrorCode;
    constructor(code: ViewerErrorCode, message: string);
}
export type BaseMapState = Readonly<{
    id: string | null;
    type: BaseMapDefinition['type'] | null;
    capabilities: MapStyleCapabilityReport | null;
}>;
/** Public browser SDK facade. create() means configuration ready, not tile loading complete. */
export declare class Viewer {
    readonly engine: GlobeEngine;
    readonly entities: EntityCollection;
    readonly draw: EntityDrawingController;
    readonly measure: MeasurementController;
    private toolbar;
    private readonly entityLayer;
    private readonly definitions;
    private current;
    private state;
    private controller;
    private generation;
    private destroyed;
    private constructor();
    static create(container: string | HTMLElement, options?: ViewerOptions): Promise<Viewer>;
    get isDestroyed(): boolean;
    get baseMap(): BaseMapState;
    get terrainEnabled(): boolean;
    get lodGridVisible(): boolean;
    getBaseMaps(): readonly Readonly<BaseMapDefinition>[];
    setBaseMap(id: string | null): Promise<BaseMapState>;
    setTerrainEnabled(enabled: boolean): void;
    setLodGridVisible(visible: boolean): void;
    flyTo(view: GlobeFlyToOptions): void;
    getCameraViewState(): Readonly<{
        cameraLongitude: number;
        cameraLatitude: number;
        cameraAltitude: number;
        focusLongitude: number | null;
        focusLatitude: number | null;
        heading: number | null;
        pitch: number | null;
    }>;
    /** Public WGS84/world/Web-Mercator/tile/ENU converter; world axes are engine-specific. */
    get coordinates(): import("..").CoordinateTransform;
    selectEntity(id: string | null): EntitySnapshot | null;
    get selectedEntity(): EntitySnapshot | null;
    /** Already available DEM height only; no fetch, no zero-height substitution. */
    sampleTerrainHeight(longitude: number, latitude: number): number | null;
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
    orientNorthUp(): void;
    resetView(): void;
    setTileLevelOffset(offset: number): void;
    get tileLevelOffset(): number | null;
    /** Opt-in UI, owned and destroyed with the Viewer. Icons are bundled; no token/resource configuration included. */
    createToolbar(options?: ViewerToolbarOptions): ViewerToolbar;
    measureDistance: typeof measureDistance;
    measureArea: typeof measureArea;
    inspectAt(screen: ScreenPosition): {
        surface: Readonly<{
            position: Required<Cartographic>;
            source: "rendered-surface" | "ellipsoid" | "absolute-height";
            tile: import("..").TileId | null;
            approximation?: "polar-cap";
            screen: ScreenPosition;
            reprojected: ScreenPosition;
            errorPixels: number;
            distance: number;
            viewDepth: number;
        }> | null;
        entity: import("./EntityTypes").EntityDefinition | null;
    };
    /** CSS pixels relative to the canvas, not client coordinates or device pixels. */
    pick(screen: ScreenPosition, options?: EntityPickOptions): EntitySnapshot | null;
    getEntityResourceState(id: string): EntityResourceState | null;
    getEntityGroundState(id: string): EntityGroundState | null;
    retryEntityResources(id: string): boolean;
    /** Defaults to the displayed raster/vector surface mesh. Explicit ellipsoid/height modes remain available. */
    pickPosition(screen: ScreenPosition, options?: SurfacePickOptions): Cartographic | null;
    pickPositionDetailed(screen: ScreenPosition, options?: SurfacePickOptions): SurfacePickResult | null;
    start(): void;
    stop(): void;
    destroy(): void;
    private assertAlive;
    private prepare;
}
//# sourceMappingURL=Viewer.d.ts.map