import * as THREE from 'three';
import { Ellipsoid } from '../geo/Ellipsoid';
import { type Rectangle, type TileId, type TilingScheme } from '../tiling/GeographicTilingScheme';
export type SelectedTile = Readonly<{
    id: TileId;
    rectangle: Rectangle;
    screenPixels: number;
    /** Approximate distance from the viewport centre in normalized device coordinates. */
    viewCenterDistance: number;
}>;
/** Higher means more urgent: error dominates, centre preference is bounded. */
export declare function tileRequestUrgency(tile: SelectedTile): number;
export type GlobeLodStats = Readonly<{
    selected: number;
    visited: number;
    horizonCulled: number;
    frustumCulled: number;
    levels: ReadonlyMap<number, number>;
}>;
export type GlobeLodSelectorOptions = {
    minLevel?: number;
    maxLevel?: number;
    targetPixels?: number;
    collapseFactor?: number;
    maxTiles?: number;
    horizonPaddingDegrees?: number;
    /** Lowest screen-error multiplier for tiles at a grazing/horizon angle. */
    minimumHorizonDetailFactor?: number;
    /** @deprecated Projection now accounts for grazing angles per axis; ignored. */
    horizonDetailExponent?: number;
    /** Conservative positive GPU surface displacement used by culling, in metres. */
    maximumSurfaceDisplacement?: number;
    tilingScheme?: TilingScheme;
    /** Optional geometric error in metres; absent preserves imagery pixel LOD. */
    geometricError?: (id: TileId, rectangle: Rectangle) => number;
};
export interface SurfaceDisplacementBoundsSource {
    readonly revision: number;
    maximumHeight(id: TileId): number | null;
    /** Exact loaded height interval when available. */
    heightRange?(id: TileId): SurfaceDisplacementRange | null;
    /** Loaded local height for the detail sampling shell, not an occlusion test. */
    sampleHeight?(longitude: number, latitude: number): number | null;
    /** Resolved DEM/ancestor snapshot; avoids repeated pyramid searches per point. */
    tileHeightSampler?(id: TileId): {
        key: string;
        sample: (u: number, v: number) => number;
    };
}
export type SurfaceDisplacementRange = Readonly<{
    minimumHeight: number;
    maximumHeight: number;
}>;
/** Camera-dependent selection only. It intentionally knows nothing about meshes or imagery. */
export declare class GlobeLodSelector {
    readonly tilingScheme: TilingScheme;
    readonly ellipsoid: Ellipsoid;
    readonly minLevel: number;
    readonly maxLevel: number;
    readonly targetPixels: number;
    readonly collapseFactor: number;
    readonly maxTiles: number;
    maximumSurfaceDisplacement: number;
    private readonly horizonPaddingRadians;
    private readonly minimumHorizonDetailFactor;
    private readonly geometricError?;
    private readonly previousSplits;
    private readonly boundsCache;
    private readonly boundsDelta;
    private readonly cameraDirection;
    private readonly cameraPosition;
    private readonly tileDirection;
    private readonly sampleDirection;
    private readonly displacedSample;
    private readonly boundsNormal;
    private readonly surfacePoint;
    private readonly surfaceToCamera;
    private readonly cameraRight;
    private readonly cameraUp;
    private readonly cameraForward;
    private readonly tangentEast;
    private readonly tangentNorth;
    private readonly projectionView;
    private readonly projectedCenter;
    private readonly detailPoint;
    private readonly detailProjected;
    private readonly frustum;
    private readonly tileBounds;
    private readonly viewSurfaceSamples;
    private readonly coordinates;
    private readonly viewBoundsMatrix;
    private readonly viewHeightRanges;
    private readonly viewDetailRanges;
    private readonly viewDetailHeights;
    private surfaceDisplacementSource?;
    private surfaceDisplacementRevision;
    private cameraDistance;
    private scaledCameraDistance;
    private cameraLongitude;
    private cameraLatitude;
    private focalPixels;
    private nearestVisibleDistance;
    private viewSampleHeight;
    private visited;
    private horizonCulled;
    private frustumCulled;
    constructor(options?: GlobeLodSelectorOptions);
    setMaximumSurfaceDisplacement(displacement: number): void;
    setSurfaceDisplacementSource(source?: SurfaceDisplacementBoundsSource): void;
    select(camera: THREE.PerspectiveCamera, viewportHeight: number, minimumLevelOverride?: number): {
        tiles: SelectedTile[];
        stats: GlobeLodStats;
    };
    private evaluate;
    private detailImportance;
    private projectedDetailPixels;
    private updateViewSurfaceSamples;
    private surfaceDisplacementForTile;
    private querySurfaceDisplacementForTile;
    private isAboveHorizon;
    private surfaceRadiusInDirection;
    private maximumFacingInRectangle;
    private isInsideFrustum;
    private boxInsideFrustum;
}
//# sourceMappingURL=GlobeLodSelector.d.ts.map