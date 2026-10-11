import type { MapStyle, SelectedVectorSource } from './VectorStyleTypes';
export type MapStyleLoaderOptions = Readonly<{
    styleUrl?: string;
    style?: MapStyle;
    sourceId?: string;
    fetcher?: typeof fetch;
}>;
export type MapStyleCapabilityIssue = Readonly<{
    layerId: string;
    severity: 'degraded' | 'unsupported';
    message: string;
}>;
export type MapStyleCapabilityReport = Readonly<{
    supportedLayers: number;
    degradedLayers: number;
    unsupportedLayers: number;
    issues: readonly MapStyleCapabilityIssue[];
}>;
/** Loads and validates the supported Mapbox Style v8 envelope. */
export declare class MapStyleLoader {
    readonly styleUrl?: string;
    readonly sourceId?: string;
    private readonly inlineStyle?;
    private readonly fetcher;
    private stylePromise;
    constructor(options: MapStyleLoaderOptions);
    load(): Promise<MapStyle>;
    selectVectorSource(style: MapStyle): SelectedVectorSource;
    sourceLayerNames(style: MapStyle, sourceId: string): ReadonlySet<string>;
    capabilities(): Promise<MapStyleCapabilityReport>;
    private fetchStyle;
}
export declare function validateMapStyle(style: MapStyle): MapStyle;
/** Reports the compatibility renderer's explicit Style v8 boundary. */
export declare function analyzeMapStyle(style: MapStyle): MapStyleCapabilityReport;
//# sourceMappingURL=MapStyleLoader.d.ts.map