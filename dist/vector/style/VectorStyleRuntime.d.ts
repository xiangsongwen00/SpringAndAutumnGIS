import type { DecodedFeature, MapStyle, StyleLayer } from './VectorStyleTypes';
export type VectorStyleIssue = Readonly<{
    layerId: string;
    property: string;
    message: string;
}>;
export type EvaluatedBucket = Readonly<{
    layer: StyleLayer;
    features: readonly DecodedFeature[];
    order: number;
}>;
/** Renderer-independent Style v8 compilation; both base and business sources use this. */
export declare class VectorStyleRuntime {
    readonly issues: VectorStyleIssue[];
    readonly layers: readonly StyleLayer[];
    private readonly compiled;
    private readonly filters;
    constructor(style: MapStyle, types?: ReadonlySet<string>);
    evaluate(layer: StyleLayer, zoom: number, feature?: DecodedFeature): StyleLayer;
    /** Group equally evaluated features into transferable bucket plans, preserving style order. */
    buckets(decoded: ReadonlyMap<string, readonly DecodedFeature[]>, sourceId: string, zoom: number, types?: ReadonlySet<string>): EvaluatedBucket[];
}
//# sourceMappingURL=VectorStyleRuntime.d.ts.map