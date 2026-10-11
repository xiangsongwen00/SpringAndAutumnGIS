import * as THREE from 'three';
import { type RasterTileLayer } from './RasterTileLayer';
export type PolarAppearanceOptions = {
    warmup?: boolean;
    maxCachedMaps?: number;
    requestTimeoutMs?: number;
};
export type PolarAppearanceState = Readonly<{
    mapId: string | null;
    north: {
        mode: 'fallback' | 'style' | 'sampled';
        coverage: number;
    };
    south: {
        mode: 'fallback' | 'style' | 'sampled';
        coverage: number;
    };
    warming: boolean;
    queued: number;
    failures: number;
    cachedMaps: number;
    textureBytes: number;
}>;
/** Per-provider polar atlases. Real map edge pixels, never vendor-name colour constants. */
export declare class PolarAppearance {
    private readonly fallbackNorth;
    private readonly fallbackSouth;
    private readonly options;
    private readonly cache;
    private active;
    private renderer;
    private readonly identities;
    private serial;
    private readonly readCache;
    private readonly processed;
    private lastSample;
    private lastWarm;
    private job;
    private sampler;
    private disposed;
    private readonly released;
    constructor(fallbackNorth: THREE.Color, fallbackSouth: THREE.Color, options?: PolarAppearanceOptions);
    setRenderer(renderer: THREE.WebGLRenderer): void;
    get state(): PolarAppearanceState;
    texture(north: boolean): THREE.Texture | null;
    update(raster: RasterTileLayer | null): void;
    dispose(): void;
    private create;
    private ingest;
    private publish;
    private read;
    private warm;
}
//# sourceMappingURL=PolarAppearance.d.ts.map