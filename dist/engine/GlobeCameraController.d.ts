import * as THREE from 'three';
import { Ellipsoid } from '../core/geo/Ellipsoid';
import type { TerrainHeightSource } from '../render/TerrainTileLayer';
export type GlobeFlyToOptions = {
    longitude: number;
    latitude: number;
    /** Camera height above the terrain/ellipsoid at the destination, in metres. */
    altitude: number;
    /** Clockwise from north, in degrees. */
    heading?: number;
    /** Cesium-style pitch: -90 is nadir, 0 is horizontal. */
    pitch?: number;
    duration?: number;
};
export type GlobeCameraViewState = Readonly<{
    cameraLongitude: number;
    cameraLatitude: number;
    cameraAltitude: number;
    focusLongitude: number | null;
    focusLatitude: number | null;
    heading: number | null;
    pitch: number | null;
}>;
/** Cesium-style globe navigation with focus orbit, surface tilt and fly-to animation. */
export declare class GlobeCameraController {
    readonly target: THREE.Vector3;
    enabled: boolean;
    enableDamping: boolean;
    dampingFactor: number;
    orbitSpeed: number;
    lookSpeed: number;
    tiltSpeed: number;
    zoomSpeed: number;
    minDistance: number;
    maxDistance: number;
    minimumTiltDegrees: number;
    maximumTiltDegrees: number;
    private readonly camera;
    private readonly element;
    private readonly ellipsoid;
    private readonly coordinates;
    private readonly terrain?;
    private readonly pointer;
    private readonly orbitVelocity;
    private readonly lookVelocity;
    private tiltVelocity;
    private zoomVelocity;
    private pointerId;
    private dragMode;
    private animation;
    private terrainRevision;
    private disposed;
    private readonly initialPose;
    private readonly onPointerDown;
    private readonly onPointerMove;
    private readonly onPointerUp;
    private readonly onWheel;
    private readonly onContextMenu;
    constructor(camera: THREE.PerspectiveCamera, element: HTMLElement, ellipsoid?: Ellipsoid, terrain?: Pick<TerrainHeightSource, 'revision' | 'sampleHeight'>);
    update(now?: number): boolean;
    getViewState(): GlobeCameraViewState;
    flyTo(options: GlobeFlyToOptions): void;
    cancelAnimation(): void;
    /** North-up nadir at the current camera position. Does not fly, change height or projection. */
    orientNorthUp(): void;
    resetView(): void;
    dispose(): void;
    private orbitAroundGlobe;
    private tiltAroundSurface;
    private orbitAroundSurface;
    private tiltDegrees;
    private zoomAlongView;
    private updateAnimation;
    private destinationCamera;
    private updateTargetFromView;
    private surfaceFocus;
    private surfacePivot;
    private validTarget;
    private enforceDistance;
    private stabilizeHorizon;
    private altitudeAboveSurface;
    private surfaceNormal;
    private localFrame;
    private decayVelocities;
    private inputGain;
    private globeOrbitRadiansPerPixel;
    private resetVelocities;
}
//# sourceMappingURL=GlobeCameraController.d.ts.map