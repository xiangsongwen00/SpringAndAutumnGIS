import type { TileId } from '../../core/tiling/GeographicTilingScheme';
import type { VectorSource } from '../style/VectorStyleTypes';
export type MvtTileSourceOptions = {
    id: string;
    source: VectorSource;
    fetcher?: typeof fetch;
};
/** Fetches raw MVT bytes. Decoding and rendering deliberately live elsewhere. */
export declare class MvtTileSource {
    readonly id: string;
    readonly minLevel: number;
    private resolvedMaxLevel;
    private templates;
    private readonly tileJsonUrl?;
    private scheme;
    private readonly explicitScheme?;
    private readonly subdomains;
    private readonly fetcher;
    private metadataPromise;
    constructor(options: MvtTileSourceOptions);
    get maxLevel(): number;
    initialize(signal?: AbortSignal): Promise<void>;
    url(tile: TileId): string;
    load(tile: TileId, signal?: AbortSignal): Promise<ArrayBuffer>;
    private resolveTemplates;
    private loadTileJson;
}
//# sourceMappingURL=MvtTileSource.d.ts.map