import type { EntityDefinition, EntitySnapshot, EntityPatch, EntityMove, EntityPosition, EntityQuery, EntityChange } from './EntityTypes';
export declare class EntityError extends Error {
    readonly code: 'INVALID_ENTITY' | 'DUPLICATE_ID' | 'NOT_FOUND' | 'DESTROYED';
    constructor(code: 'INVALID_ENTITY' | 'DUPLICATE_ID' | 'NOT_FOUND' | 'DESTROYED', message: string);
}
/** Mutable collection with immutable detached snapshots; no source or GPU objects leak through the API. */
export declare class EntityCollection {
    private readonly records;
    private readonly listeners;
    private shown;
    private destroyed;
    private selection;
    get selectedId(): string | null;
    get selectedEntity(): EntitySnapshot | null;
    /** Selection context only; does not move camera, mutate symbol or add highlight geometry. */
    selectById(id: string | null): EntitySnapshot | null;
    get isDestroyed(): boolean;
    get length(): number;
    get visible(): boolean;
    setVisible(visible: boolean): void;
    add(definition: EntityDefinition): EntitySnapshot;
    getById(id: string): EntitySnapshot | undefined;
    has(id: string): boolean;
    get values(): readonly EntitySnapshot[];
    query(query?: EntityQuery): readonly EntitySnapshot[];
    update(id: string, patch: EntityPatch): EntitySnapshot;
    setVisibleById(id: string, visible: boolean): EntitySnapshot;
    /** Translation in geographic degrees/metres, preserving shape. It is not an ECEF rigid transform. */
    move(id: string, delta: EntityMove): EntitySnapshot;
    remove(id: string): boolean;
    clear(): void;
    /** Listener failures cannot interrupt other observers or leave the collection half-mutated. */
    onChange(listener: (change: EntityChange) => void): () => void;
    /** Owned by Viewer; after disposal all operational access fails explicitly. */
    dispose(): void;
    private require;
    private assertAlive;
    private emit;
}
export declare function entityAnchor(value: EntityDefinition): EntityPosition;
export declare function wrapLongitude(value: number): number;
export declare function validateEntity(value: EntityDefinition): void;
//# sourceMappingURL=EntityCollection.d.ts.map