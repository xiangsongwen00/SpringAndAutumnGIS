import { type VectorStyleIssue } from '../style/VectorStyleRuntime';
import type { MapStyle } from '../style/VectorStyleTypes';
import { type SurfacePlan, type SurfaceBuildInput } from './VectorSurfaceBuild';
export declare class VectorSurfaceService {
    private readonly client;
    private readonly known;
    private fallback;
    private disposed;
    get stats(): {
        pending: number;
        queueMs: number;
        roundTripMs: number;
        postMs: number;
        worker: boolean;
    };
    initialize(style: MapStyle): Promise<VectorStyleIssue[]>;
    build(input: SurfaceBuildInput, key: string, signal?: AbortSignal): Promise<SurfacePlan>;
    dispose(): void;
}
//# sourceMappingURL=VectorSurfaceService.d.ts.map