import type { EntityPosition } from './EntityTypes';
import type { EntityCollection } from './EntityCollection';
import type { EntityDrawingController } from './EntityDrawingController';
import type { SurfacePickResult } from '../core/geo/SurfacePicker';
export type DistanceMeasurement = Readonly<{
    kind: 'distance';
    method: 'wgs84-geodesic';
    metres: number;
    segments: readonly number[];
}>;
export type AreaMeasurement = Readonly<{
    kind: 'area';
    method: 'wgs84-geodesic';
    squareMetres: number;
    perimeterMetres: number;
}>;
export type PointMeasurement = Readonly<{
    kind: 'point';
    position: EntityPosition;
    source: SurfacePickResult['source'] | null;
    approximation?: 'polar-cap';
}>;
export type MeasurementKind = 'point' | 'distance' | 'area';
export type MeasurementOptions = {
    clearPrevious?: boolean;
};
export type MeasurementResult = DistanceMeasurement | AreaMeasurement | PointMeasurement;
/** Horizontal ellipsoidal distance. Heights/DEM do not change this result. */
export declare function measureDistance(input: readonly EntityPosition[]): DistanceMeasurement;
/** Smaller-region ellipsoidal polygon area. Valid non-self-intersecting rings and contained holes required. */
export declare function measureArea(input: readonly EntityPosition[], holes?: readonly (readonly EntityPosition[])[]): AreaMeasurement;
export type MeasurementState = Readonly<{
    active: boolean;
    kind: MeasurementKind | null;
    vertexCount: number;
    result: MeasurementResult | null;
    entityId: string | null;
    error: string | null;
}>;
/** Shares drawing interaction and entity lifecycle; no second picking/navigation system. */
export declare class MeasurementController {
    private readonly draw;
    private readonly entities;
    private kind;
    private lastPointId;
    private entityId;
    private result;
    private error;
    private serial;
    private vertexCount;
    private readonly owned;
    private disposed;
    private readonly listeners;
    private readonly unsubscribe;
    private readonly unsubscribeEntities;
    constructor(draw: EntityDrawingController, entities: EntityCollection);
    get state(): MeasurementState;
    start(kind?: MeasurementKind, options?: MeasurementOptions): MeasurementState;
    finish(): MeasurementResult;
    undo(): void;
    stop(): void;
    cancel(): void;
    clear(): void;
    onChange(listener: (state: MeasurementState) => void): () => void;
    dispose(): void;
    private changed;
    private compute;
    private emit;
    private assertAlive;
}
//# sourceMappingURL=Measurement.d.ts.map