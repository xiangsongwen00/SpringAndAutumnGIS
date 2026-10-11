import type { DecodedVectorTile, MapStyle } from '../style/VectorStyleTypes';
export type CanvasVectorRasterizerOptions = {
    /** Re-enables Admin0 country labels when a style explicitly hides them. */
    showCountryLabels?: boolean;
    tileSize?: number;
};
/** Rasterizes decoded vector features using the current ArcGIS/Mapbox style subset. */
export declare class CanvasVectorRasterizer {
    private readonly tileSize;
    private readonly showCountryLabels;
    constructor(options?: CanvasVectorRasterizerOptions);
    rasterize(style: MapStyle, sourceId: string, tile: DecodedVectorTile, zoom: number): HTMLCanvasElement;
    private renderStyle;
}
//# sourceMappingURL=CanvasVectorRasterizer.d.ts.map