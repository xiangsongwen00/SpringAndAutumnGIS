import { type TerrainHeightField } from './TerrainHeightConversion';
/** Shared, bounded DEM worker. Releases its worker after 30s idle; layer/provider
 * lifetimes need not take ownership of another user's shared terrain provider.
 */
export declare class TerrainDecodeService {
    private client;
    private idleTimer;
    private active;
    private conversionMs;
    get stats(): {
        pending?: number | undefined;
        queueMs?: number | undefined;
        roundTripMs?: number | undefined;
        postMs?: number | undefined;
        worker: boolean;
        active: number;
        conversionMs: number;
    };
    dispose(): void;
    decode(blob: Blob, encoding: 'mapbox' | 'terrarium', signal?: AbortSignal): Promise<TerrainHeightField>;
}
export declare const terrainDecodeService: TerrainDecodeService;
//# sourceMappingURL=TerrainDecodeService.d.ts.map