export type TerrainHeightField = {
    width: number;
    height: number;
    heights: Float32Array;
    minimumHeight: number;
    maximumHeight: number;
    conversionMs: number;
};
/** Identical XYZ north-to-south endpoint sampling in worker and fallback. */
export declare function convertTerrainPixels(pixels: Uint8ClampedArray, sourceWidth: number, sourceHeight: number, encoding: 'mapbox' | 'terrarium', yieldControl?: () => Promise<void>): Promise<TerrainHeightField>;
//# sourceMappingURL=TerrainHeightConversion.d.ts.map