export type GeoJsonPosition = readonly [number, number, ...number[]];
export type GeoJsonGeometry = Readonly<{
    type: 'Point' | 'MultiPoint' | 'LineString' | 'MultiLineString' | 'Polygon' | 'MultiPolygon';
    coordinates: unknown;
}>;
export type GeoJsonFeature = Readonly<{
    type: 'Feature';
    id?: string | number;
    properties?: Readonly<Record<string, unknown>> | null;
    geometry: GeoJsonGeometry | null;
}>;
export type GeoJsonFeatureCollection = Readonly<{
    type: 'FeatureCollection';
    features: readonly GeoJsonFeature[];
    crs?: unknown;
}>;
export type GeoJsonSourceOptions = Readonly<{
    id: string;
    url: string;
    maxFeatures?: number;
    crs?: string;
}>;
/** Validated URL-backed GeoJSON source. Rendering remains owned by GeoJsonLayer. */
export declare class GeoJsonSource {
    readonly id: string;
    readonly url: string;
    readonly maxFeatures: number;
    readonly crs: string;
    constructor(options: GeoJsonSourceOptions);
    load(signal?: AbortSignal): Promise<GeoJsonFeatureCollection>;
}
//# sourceMappingURL=GeoJsonSource.d.ts.map