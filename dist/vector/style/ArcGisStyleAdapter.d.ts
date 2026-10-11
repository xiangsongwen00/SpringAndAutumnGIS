import type { MapStyle, SelectedVectorSource } from './VectorStyleTypes';
export type ArcGisStyleAdapterOptions = {
    styleUrl: string;
    sourceId?: string;
};
/** Loads ArcGIS VectorTileServer styles expressed through the Mapbox Style v8 schema. */
export declare class ArcGisStyleAdapter {
    readonly styleUrl: string;
    readonly sourceId?: string;
    private stylePromise;
    constructor(options: ArcGisStyleAdapterOptions);
    load(): Promise<MapStyle>;
    selectVectorSource(style: MapStyle): SelectedVectorSource;
    sourceLayerNames(style: MapStyle, sourceId: string): ReadonlySet<string>;
    private fetchStyle;
}
//# sourceMappingURL=ArcGisStyleAdapter.d.ts.map