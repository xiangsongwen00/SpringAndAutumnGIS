import { VectorStyleRuntime, type EvaluatedBucket } from '../style/VectorStyleRuntime';
import type { TileId } from '../../core/tiling/GeographicTilingScheme';
import type { DecodedVectorTile } from '../style/VectorStyleTypes';
export type NativeGeometry = {
    positions: Float32Array;
    uvs: Float32Array;
    indices: Uint32Array;
};
export type NativeBucket = EvaluatedBucket & {
    geometry?: NativeGeometry;
    outline?: NativeGeometry;
};
export declare function buildNativeBuckets(runtime: VectorStyleRuntime, decoded: DecodedVectorTile, id: TileId, sourceId: string, types: ReadonlySet<string>): NativeBucket[];
//# sourceMappingURL=VectorNativeBuild.d.ts.map