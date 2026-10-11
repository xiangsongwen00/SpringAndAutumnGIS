import type { MapStyle } from '../vector/style/VectorStyleTypes';
export type PolarStylePalette = Readonly<{
    north: string;
    south: string;
    key: string;
}>;
/** Opaque configuration fingerprint for cache isolation; never exposes URLs/keys. */
export declare function polarConfigurationKey(value: string): string;
/** Style-specific fallback before pixels are available. No vendor-name colour table. */
export declare function polarPaletteFromStyle(style: MapStyle): PolarStylePalette | null;
//# sourceMappingURL=PolarStyle.d.ts.map