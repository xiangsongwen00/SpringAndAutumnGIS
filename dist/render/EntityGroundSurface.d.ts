import * as THREE from 'three';
import type { TileId } from '../core/tiling/GeographicTilingScheme';
import type { EntityPosition } from '../sdk/EntityTypes';
export type GroundBounds = {
    west: number;
    east: number;
    north: number;
    south: number;
};
export type GroundPatch = {
    id: TileId;
    shift: number;
    signature: string;
    vertices: Float64Array;
    uv: THREE.BufferAttribute;
    index: THREE.BufferAttribute;
};
export interface EntityGroundSurface {
    /** Actual displayed base topology/DEM/edge generation; not downloaded/requested DEM. */
    readonly revision: string;
    patches(bounds: GroundBounds): readonly GroundPatch[];
}
export declare function groundCoordinate(p: EntityPosition, reference: number): THREE.Vector2;
export declare function groundBounds(positions: readonly EntityPosition[]): GroundBounds;
//# sourceMappingURL=EntityGroundSurface.d.ts.map