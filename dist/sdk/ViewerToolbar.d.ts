import type { GlobeEngine } from '../engine/GlobeEngine';
import type { EntityDrawingController } from './EntityDrawingController';
import type { MeasurementController } from './Measurement';
import type { EntitySnapshot, EntityDefinition, ScreenPosition } from './EntityTypes';
import type { EntityCollection } from './EntityCollection';
import type { SurfacePickResult } from '../core/geo/SurfacePicker';
/** Also accepts a source-demo adapter, so no second engine/canvas is created. */
export interface ToolbarTarget {
    readonly engine: GlobeEngine;
    readonly draw: EntityDrawingController;
    readonly measure: MeasurementController;
    readonly entities: EntityCollection;
    readonly terrainEnabled: boolean;
    readonly tileLevelOffset: number | null;
    getBaseMaps(): readonly {
        id: string;
    }[];
    readonly baseMap: {
        id: string | null;
    };
    setBaseMap(id: string | null): Promise<unknown>;
    setTerrainEnabled(enabled: boolean): void;
    setTileLevelOffset(value: number): void;
    orientNorthUp(): void;
    resetView(): void;
    inspectAt(screen: ScreenPosition): {
        surface: SurfacePickResult | null;
        entity: EntitySnapshot | null;
    };
}
export type ViewerToolbarOptions = {
    container?: HTMLElement;
    onEntities?: () => void;
    onLayers?: () => void;
    /** CSS pixels above the container bottom; default 48 plus safe-area inset. */
    bottomOffset?: number;
    /** Existing drawing/style/management form mounted inside the drawing popup. */
    drawContent?: HTMLElement;
    /** Optional existing source-demo form controls are moved, not cloned. */
    basemapContent?: HTMLElement;
    offsetContent?: HTMLElement;
    onDraw?: (type: EntityDefinition['type'], options: {
        clearPrevious: boolean;
    }) => void;
    onPanelOpen?: () => void;
    baseMapNames?: Readonly<Record<string, string>>;
};
/** Optional library toolbar: one owner, one active drawing/measurement interaction. */
export declare class ViewerToolbar {
    private readonly target;
    private readonly options;
    readonly element: HTMLElement;
    readonly panel: HTMLElement;
    private readonly style;
    private readonly events;
    private readonly cleanup;
    private readonly buttons;
    private content;
    private title;
    private status;
    private mode;
    private inspecting;
    private pointer;
    private destroyed;
    private managerUnsubscribe;
    private clearDrawingHistory;
    private clearMeasurementHistory;
    private previousPosition;
    private readonly host;
    private readonly moved;
    constructor(target: ToolbarTarget, options?: ViewerToolbarOptions);
    close(): void;
    destroy(): void;
    private beginInteraction;
    private open;
    private mount;
    private baseMaps;
    private offset;
    /** Programmatic end is equivalent to the point-mode Finish button; popup stays open. */
    endInteraction(): void;
    private expressionButtons;
    private selector;
    private drawModule;
    private measureModule;
    private startButton;
    private historyCheckbox;
    private terrainState;
    private entityManager;
    private styleEditor;
    private styleEditorRefresh;
}
//# sourceMappingURL=ViewerToolbar.d.ts.map