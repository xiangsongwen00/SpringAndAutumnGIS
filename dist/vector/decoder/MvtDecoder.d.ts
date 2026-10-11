import type { DecodedVectorTile } from '../style/VectorStyleTypes';
/** Converts PBF bytes into renderer-independent feature geometry. */
export declare class MvtDecoder {
    decode(bytes: ArrayBuffer, requestedLayers?: ReadonlySet<string>): DecodedVectorTile;
}
//# sourceMappingURL=MvtDecoder.d.ts.map