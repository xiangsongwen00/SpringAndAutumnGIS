import { type RasterTileProvider } from '../tiles/RasterTileProvider';
import { GeoJsonSource } from '../../feature/GeoJsonSource';
import { Ellipsoid } from '../geo/Ellipsoid';
import { MvtVectorLayer } from '../../render/MvtVectorLayer';
import type { TerrainHeightSource } from '../../render/TerrainTileLayer';
export type DataSourceKind = 'xyz-raster' | 'wmts-raster' | 'rasterized-vector-style' | 'mvt' | 'geojson';
export type DataSourceStatus = 'stable' | 'experimental' | 'planned';
export type DataCoordinateReference = 'wgs84-webmercator' | 'gcj02-webmercator-in-china';
export type DataSourceDefinition = Readonly<{
    id: string;
    name: string;
    kind: DataSourceKind;
    urlTemplate?: string;
    capabilitiesUrl?: string;
    layer?: string;
    style?: string;
    format?: string;
    tileMatrixSet?: string;
    requestEncoding?: 'auto' | 'rest' | 'kvp';
    endpointBaseUrl?: string;
    url?: string;
    crs?: string;
    maxFeatures?: number;
    styleUrl?: string;
    sourceId?: string;
    scheme?: 'xyz' | 'tms';
    subdomains?: readonly string[];
    minLevel?: number;
    maxLevel?: number;
    tileSize?: number;
    bounds?: readonly [number, number, number, number];
    levelOffset?: number;
    minimumLodLevelOffset?: number;
    showCountryLabels?: boolean;
    attribution?: string;
    termsUrl?: string;
    requires?: readonly string[];
    status?: DataSourceStatus;
    note?: string;
    coordinateReference?: DataCoordinateReference;
}>;
export type DataSourceRegistryOptions = Readonly<{
    variables?: Readonly<Record<string, string | undefined>>;
    defaultLevelOffset?: number;
    fetcher?: typeof fetch;
}>;
export type RasterProviderOverrides = Readonly<{
    levelOffset?: number;
}>;
export type MvtVectorLayerOverrides = Readonly<{
    levelOffset?: number;
    opacity?: number;
    order?: number;
    terrain?: TerrainHeightSource;
    maxLabelsPerTile?: number;
    maxVisibleLabels?: number;
    role?: 'base' | 'overlay';
    symbols?: boolean;
}>;
export type DataSourceAvailability = Readonly<{
    available: boolean;
    missingVariables: readonly string[];
    supported: boolean;
}>;
/** Registry of serializable source definitions and runtime Provider factories. */
export declare class DataSourceRegistry {
    private readonly sources;
    private readonly variables;
    readonly defaultLevelOffset: number;
    private readonly fetcher;
    constructor(initialSources?: readonly DataSourceDefinition[], options?: DataSourceRegistryOptions);
    register(source: DataSourceDefinition): void;
    replace(source: DataSourceDefinition): void;
    remove(id: string): boolean;
    get(id: string): DataSourceDefinition | undefined;
    values(): readonly DataSourceDefinition[];
    toJSON(): readonly DataSourceDefinition[];
    availability(id: string): DataSourceAvailability;
    createRasterProvider(id: string, overrides?: RasterProviderOverrides): RasterTileProvider;
    createRasterProviderAsync(id: string, overrides?: RasterProviderOverrides): Promise<RasterTileProvider>;
    createGeoJsonSource(id: string): GeoJsonSource;
    createMvtVectorLayer(id: string, ellipsoid: Ellipsoid, overrides?: MvtVectorLayerOverrides): MvtVectorLayer;
    private require;
}
//# sourceMappingURL=DataSourceRegistry.d.ts.map