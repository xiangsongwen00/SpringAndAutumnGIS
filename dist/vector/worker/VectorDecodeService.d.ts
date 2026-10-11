import type { DecodedVectorTile } from '../style/VectorStyleTypes';
/** PBF transport boundary; geometry/style phases can move behind the same worker protocol. */
export declare class VectorDecodeService {
    private worker;
    private nextId;
    private disposed;
    private readonly pending;
    constructor();
    decode(bytes: ArrayBuffer, layers?: ReadonlySet<string>): Promise<DecodedVectorTile>;
    dispose(): void;
}
//# sourceMappingURL=VectorDecodeService.d.ts.map