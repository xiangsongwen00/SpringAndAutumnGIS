export type TileContentKind = 'imagery' | 'rasterized-vector' | 'terrain' | 'vector' | 'model';
export type TileContentState = 'unloaded' | 'queued' | 'loading' | 'decoding' | 'uploading' | 'ready' | 'failed' | 'expired' | 'cancelled';
export type TileContentKey = Readonly<{
    sourceId: string;
    kind: TileContentKind;
    level: number;
    x: number;
    y: number;
    variant?: string;
}>;
export type TileRecord = Readonly<{
    key: TileContentKey;
    id: string;
    state: TileContentState;
    priority: number;
    attempts: number;
    error: string | null;
    byteSize: number;
    references: number;
    lastAccessFrame: number;
    updatedAt: number;
}>;
export type TileRecordPatch = Readonly<Partial<Pick<TileRecord, 'priority' | 'attempts' | 'error' | 'byteSize' | 'lastAccessFrame'>>>;
export type TileStateChange = Readonly<{
    id: string;
    previous: TileContentState | null;
    record: TileRecord;
}>;
export type TileStateListener = (change: TileStateChange) => void;
/**
 * Lifecycle registry for one source/content/tile/variant tuple.
 *
 * It deliberately owns no network or GPU object. Consumers can therefore share
 * lifecycle and coverage decisions without coupling the GIS core to Three.js.
 */
export declare class TileStateMachine {
    private readonly records;
    private readonly listeners;
    get size(): number;
    values(): readonly TileRecord[];
    get(key: TileContentKey): TileRecord | undefined;
    ensure(key: TileContentKey, patch?: TileRecordPatch): TileRecord;
    transition(key: TileContentKey, state: TileContentState, patch?: TileRecordPatch): TileRecord;
    retain(key: TileContentKey): TileRecord;
    release(key: TileContentKey): TileRecord | undefined;
    touch(key: TileContentKey, frame: number): TileRecord;
    remove(key: TileContentKey, force?: boolean): boolean;
    resolveReadyAncestor(key: TileContentKey, minimumLevel?: number): TileRecord | undefined;
    /** A parent may retire only when all four direct children are ready. */
    canReplaceWithChildren(parent: TileContentKey): boolean;
    subscribe(listener: TileStateListener): () => void;
    private patchRecord;
    private replace;
    private emit;
}
export declare function tileContentId(key: TileContentKey): string;
//# sourceMappingURL=TileStateMachine.d.ts.map