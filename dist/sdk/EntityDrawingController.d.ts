import { EntityCollection } from './EntityCollection';
import type { GlobeEngine } from '../engine/GlobeEngine';
import type { EntityDefinition, EntityPosition, EntitySnapshot, LabelSymbol, PointSymbol, LineSymbol, PolygonSymbol } from './EntityTypes';
import type { SurfacePickOptions, SurfacePickResult } from '../core/geo/SurfacePicker';
export type EntityDrawOptions = {
    type: EntityDefinition['type'];
    id?: string;
    name?: string;
    properties?: Record<string, unknown>;
    symbol?: PointSymbol | LineSymbol | PolygonSymbol;
    label?: LabelSymbol;
    pick?: SurfacePickOptions;
    heightReference?: 'absolute' | 'clamp-to-ground';
    groundOffset?: number;
    /** Default allow: left click draws; right/middle drag and wheel still navigate. */
    navigation?: 'allow' | 'lock';
    /** Point/label sessions stay active by default; false preserves one-click completion. */
    continuous?: boolean;
    /** Replace this tool's older results only after a new entity commits successfully. */
    clearPrevious?: boolean;
    /** MeasurementController uses a separate ownership group; ordinary draws default to drawing. */
    historyGroup?: 'drawing' | 'measurement';
};
export type EntityDrawState = Readonly<{
    active: boolean;
    type: EntityDefinition['type'] | null;
    vertexCount: number;
    positions: readonly EntityPosition[];
    lastEntityId: string | null;
    lastPick: SurfacePickResult | null;
    error: string | null;
    pickMs: number;
    previewMs: number;
    previewFrameMs: number;
}>;
export type EntityDrawStyle = {
    symbol?: PointSymbol | LineSymbol | PolygonSymbol;
    label?: LabelSymbol | null;
    heightReference?: 'absolute' | 'clamp-to-ground';
    groundOffset?: number;
};
/** Shared mouse expression system: preview, finish, undo, cancel, keyboard and navigation ownership. */
export declare class EntityDrawingController {
    private readonly engine;
    private readonly entities;
    private readonly layerId;
    private readonly events;
    private readonly preview;
    private readonly previewLayer;
    private readonly listeners;
    private options;
    private positions;
    private navigation;
    private pointer;
    private lastPreview;
    private lastId;
    private error;
    private serial;
    private pointIds;
    private lastPick;
    private lastClick;
    private doubleReleaseSkipped;
    private readonly history;
    private readonly unsubscribeEntities;
    private previousCursor;
    private pickMs;
    private previewMs;
    private previewFrameMs;
    private previewQueuedAt;
    private previewProbe;
    private destroyed;
    private readonly styles;
    /** Per-kind defaults, shared by toolbar and application drawing entry points. */
    getStyle(type: EntityDefinition['type']): EntityDrawStyle;
    /** Updates future draws and the active session of this kind, not committed entities. */
    setStyle(type: EntityDefinition['type'], patch: EntityDrawStyle): EntityDrawStyle;
    private validateType;
    constructor(engine: GlobeEngine, entities: EntityCollection, layerId?: string);
    get isActive(): boolean;
    get state(): EntityDrawState;
    start(options: EntityDrawOptions): EntityDrawState;
    finish(): EntitySnapshot;
    undo(): EntityDrawState;
    /** Ends interaction without requiring a vertex; committed point markers are preserved. */
    stop(): void;
    /** Clears only controller-owned objects in the selected group, never arbitrary entities. */
    clearHistory(group?: 'drawing' | 'measurement'): void;
    cancel(): void;
    onChange(listener: (state: EntityDrawState) => void): () => void;
    dispose(): void;
    private end;
    private pick;
    private definition;
    private nextId;
    private commit;
    private showPreview;
    private emit;
    private assertAlive;
}
//# sourceMappingURL=EntityDrawingController.d.ts.map