import type { LayerCollectionListener, LayerDefinition, LayerRuntimePatch, LayerRuntimeState, LayerState, LayerStatePatch } from './LayerTypes';
/** Ordered, observable user-facing layer state. Renderers consume it but do not own it. */
export declare class LayerCollection implements Iterable<LayerState> {
    private layers;
    private readonly listeners;
    private readonly runtimeStates;
    private _revision;
    constructor(initialLayers?: readonly LayerDefinition[]);
    get revision(): number;
    get length(): number;
    [Symbol.iterator](): Iterator<LayerState>;
    values(): readonly LayerState[];
    get(id: string): LayerState | undefined;
    add(definition: LayerDefinition, notify?: boolean): LayerState;
    remove(id: string): boolean;
    update(id: string, patch: LayerStatePatch): LayerState;
    setVisible(id: string, visible: boolean): LayerState;
    setOpacity(id: string, opacity: number): LayerState;
    setLevelOffset(id: string, levelOffset: number): LayerState;
    move(id: string, order: number): LayerState;
    replace(definitions: readonly LayerDefinition[]): void;
    subscribe(listener: LayerCollectionListener): () => void;
    toJSON(): readonly LayerState[];
    runtime(id: string): LayerRuntimeState | undefined;
    setRuntime(id: string, patch: LayerRuntimePatch): LayerRuntimeState;
    private hideExclusivePeers;
    private sortLayers;
    private normalizeOrder;
    private emit;
}
//# sourceMappingURL=LayerCollection.d.ts.map