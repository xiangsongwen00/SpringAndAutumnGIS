import * as THREE from 'three';
import { Ellipsoid } from '../core/geo/Ellipsoid';
import type { RasterTileLayer } from './RasterTileLayer';
import type { SurfaceRayHit } from '../core/geo/SurfacePicker';
import { type PolarAppearanceOptions, type PolarAppearanceState } from './PolarAppearance';
export type PolarSurfaceLayerOptions = PolarAppearanceOptions & {
    northColor?: THREE.ColorRepresentation;
    southColor?: THREE.ColorRepresentation;
};
/** Display completion only, NOT an Arctic/Antarctic imagery or DEM provider. */
export declare class PolarSurfaceLayer {
    private readonly ellipsoid;
    readonly object3d: THREE.Group<THREE.Object3DEventMap>;
    private readonly coordinates;
    private readonly caps;
    private readonly edges;
    private detail;
    private source;
    private generation;
    get revision(): number;
    private readonly coverageSignatures;
    private readonly cameraHigh;
    private readonly cameraLow;
    private readonly northColor;
    private readonly southColor;
    private readonly appearance;
    get appearanceState(): PolarAppearanceState;
    setRenderer(renderer: THREE.WebGLRenderer): void;
    constructor(ellipsoid?: Ellipsoid, options?: PolarSurfaceLayerOptions);
    update(camera: THREE.PerspectiveCamera, raster: RasterTileLayer | null): void;
    /** Navigation clearance on the DISPLAYED completion, never exposed as measured DEM. */
    surfaceHeight(longitude: number, latitude: number): number | null;
    pickSurface(ray: THREE.Ray): SurfaceRayHit | null;
    dispose(): void;
    private release;
    private makeMesh;
    private capGeometry;
    private edgeGeometry;
    private geometry;
}
//# sourceMappingURL=PolarSurfaceLayer.d.ts.map