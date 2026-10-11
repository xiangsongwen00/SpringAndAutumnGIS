import * as THREE from 'three';
import { Ellipsoid } from '../core/geo/Ellipsoid';
import type { SelectedTile } from '../core/lod/GlobeLodSelector';
import type { TerrainHeightSource } from './TerrainTileLayer';
export type GlobeGridRendererOptions = {
    visible?: boolean;
    subdivisions?: number;
    heightOffset?: number;
    terrain?: TerrainHeightSource;
};
/** Converts an LOD leaf set into one draw call of coloured latitude/longitude lines. */
export declare class GlobeGridRenderer {
    readonly object3d: THREE.LineSegments;
    private readonly ellipsoid;
    private readonly subdivisions;
    private readonly heightOffset;
    private readonly terrain?;
    private readonly geometry;
    private readonly material;
    private readonly cameraHigh;
    private readonly cameraLow;
    private readonly tileOrigin;
    private readonly vertexWorld;
    private signature;
    private tileSignature;
    private observedTerrainRevision;
    private renderedTerrainRevision;
    private terrainRefreshAt;
    private vertexCapacity;
    private tilesReference;
    private readonly heightProbes;
    private readonly heightPoints;
    private readonly tileChunks;
    private chunkBytes;
    private activeProbes;
    constructor(ellipsoid: Ellipsoid, options?: GlobeGridRendererOptions);
    update(tiles: readonly SelectedTile[], cameraPosition?: THREE.Vector3): boolean;
    handleContextRestored(): void;
    dispose(): void;
    private updateAttributes;
    private appendTile;
    private appendEdge;
    private appendVertex;
}
//# sourceMappingURL=GlobeGridRenderer.d.ts.map