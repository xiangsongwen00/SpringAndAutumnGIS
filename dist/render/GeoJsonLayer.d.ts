import * as THREE from 'three';
import { Ellipsoid } from '../core/geo/Ellipsoid';
import type { GeoJsonFeatureCollection } from '../feature/GeoJsonSource';
import type { TerrainHeightSource } from './TerrainTileLayer';
export type GeoJsonLayerOptions = Readonly<{
    color?: THREE.ColorRepresentation;
    pointColor?: THREE.ColorRepresentation;
    opacity?: number;
    /** Metres above the ellipsoid or sampled terrain. Defaults to 3 metres. */
    heightOffset?: number;
    pointSize?: number;
    order?: number;
    /** Optional terrain source used for progressive ground clamping. */
    terrain?: TerrainHeightSource;
    /** Maximum unique coordinates sampled per frame. Defaults to 4096. */
    terrainSampleBudget?: number;
    /** Wait for a terrain loading burst to settle before starting a new pass. */
    terrainRefreshDelayMs?: number;
    /** Densifies long chords so they do not pass below the globe. Defaults to 0.1 degree. */
    maximumSegmentDegrees?: number;
}>;
/** Camera-relative GeoJSON points and boundaries with incremental terrain draping. */
export declare class GeoJsonLayer {
    readonly object3d: THREE.Group<THREE.Object3DEventMap>;
    readonly featureCount: number;
    readonly coordinateCount: number;
    private readonly materials;
    private readonly geometries;
    private readonly drapeGeometries;
    private readonly terrain?;
    private readonly terrainSampleBudget;
    private readonly terrainRefreshDelayMs;
    private readonly cameraHigh;
    private readonly cameraLow;
    private observedTerrainRevision;
    private sampledTerrainRevision;
    private samplingTerrainRevision;
    private terrainRefreshAt;
    private drapeGeometryCursor;
    constructor(ellipsoid: Ellipsoid, collection: GeoJsonFeatureCollection, options?: GeoJsonLayerOptions);
    /** Advances a bounded terrain-clamping pass without blocking the frame. */
    update(cameraPosition?: THREE.Vector3, now?: number): boolean;
    setOpacity(opacity: number): void;
    dispose(): void;
    private createMaterial;
    private configureObject;
    private registerGeometry;
    private startTerrainPass;
}
//# sourceMappingURL=GeoJsonLayer.d.ts.map