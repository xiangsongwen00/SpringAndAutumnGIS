import * as THREE from 'three';
import type { Cartographic, Ellipsoid } from './Ellipsoid';
import type { ScreenPosition } from '../../sdk/EntityTypes';
import type { TileId } from '../tiling/GeographicTilingScheme';
export type SurfacePickOptions = {
    mode?: 'surface' | 'ellipsoid' | 'absolute-height';
    height?: number;
};
export type SurfaceRayHit = {
    world: THREE.Vector3;
    tile?: TileId;
    approximation?: 'polar-cap';
};
export type SurfacePickResult = Readonly<{
    position: Required<Cartographic>;
    source: 'rendered-surface' | 'ellipsoid' | 'absolute-height';
    tile: TileId | null;
    approximation?: 'polar-cap';
    screen: ScreenPosition;
    reprojected: ScreenPosition;
    errorPixels: number;
    distance: number;
    viewDepth: number;
}>;
/** All entry points use CSS pixels, the same camera ray and the same displayed-surface callback. */
export declare function pickSurfacePosition(camera: THREE.PerspectiveCamera, ellipsoid: Ellipsoid, width: number, height: number, screen: ScreenPosition, options?: SurfacePickOptions, surface?: (ray: THREE.Ray) => SurfaceRayHit | null): SurfacePickResult | null;
//# sourceMappingURL=SurfacePicker.d.ts.map