import * as THREE from 'three';
import { Ellipsoid } from '../core/geo/Ellipsoid';
import { EntityCollection } from '../sdk/EntityCollection';
import type { EntityDefinition, EntityPickOptions, ScreenPosition, EntityResourceState, EntityGroundState } from '../sdk/EntityTypes';
import { type EntityGroundSurface } from './EntityGroundSurface';
import type { GlobeSceneLayer } from '../engine/GlobeEngine';
/** SDK objects are independent scene overlays. No imagery/DEM request or LOD selection is changed. */
export declare class EntityLayer implements GlobeSceneLayer {
    private readonly ellipsoid;
    private readonly entities;
    private readonly groundSource?;
    readonly object3d: THREE.Group<THREE.Object3DEventMap>;
    private readonly rendered;
    private readonly dirty;
    private readonly groundJobs;
    private readonly groundStates;
    private observedGroundRevision;
    private ordered;
    private orderDirty;
    private readonly imageCache;
    private readonly materialPool;
    private readonly imageQueue;
    private activeImages;
    /** Shared estimated RGBA upload budget, including labels; excludes transient decode buffers. */
    private textureBytes;
    private readonly animationStart;
    private readonly previousMatrix;
    private cameraVersion;
    private lastWidth;
    private lastHeight;
    private readonly eyeHigh;
    private readonly eyeLow;
    private readonly viewport;
    private readonly frustum;
    private readonly matrix;
    private readonly unsubscribe;
    private readonly ellipsoidRay;
    private disposed;
    constructor(ellipsoid: Ellipsoid, entities: EntityCollection, groundSource?: EntityGroundSurface | undefined);
    update(camera: THREE.PerspectiveCamera, width: number, height: number): void;
    /** Screen-space object selection; excludes hidden, behind-globe and label-collision-suppressed objects. */
    pick(screen: ScreenPosition, camera: THREE.PerspectiveCamera, options?: EntityPickOptions, surfaceDepth?: number | null): EntityDefinition | null;
    dispose(): void;
    getGroundState(id: string): EntityGroundState | null;
    getResourceState(id: string): EntityResourceState | null;
    retryResources(id: string): boolean;
    private release;
    private project;
    private labelBox;
    private occluded;
    private geometryOverlay;
    private labelOverlay;
    private nearHemisphere;
    private build;
    private world;
    private material;
    private mesh;
    private point;
    private lines;
    private fill;
    private northAngle;
    private updateStroke;
    private acquireImage;
    private pumpImages;
    private loadImage;
    private label;
}
//# sourceMappingURL=EntityLayer.d.ts.map