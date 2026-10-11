import { type VectorStyleIssue } from '../style/VectorStyleRuntime';
import { type NativeBucket } from './VectorNativeBuild';
import type { MapStyle, DecodedVectorTile } from '../style/VectorStyleTypes';
import type { TileId } from '../../core/tiling/GeographicTilingScheme';
export declare class VectorNativeService {
    private readonly client;
    private runtime;
    private types;
    private disposed;
    initialize(style: MapStyle, types: ReadonlySet<string>): Promise<VectorStyleIssue[]>;
    build(decoded: DecodedVectorTile, tileId: TileId, sourceId: string, signal?: AbortSignal): Promise<NativeBucket[]>;
    dispose(): void;
}
//# sourceMappingURL=VectorNativeService.d.ts.map