import * as THREE from 'three';
import { Ellipsoid } from '../core/geo/Ellipsoid';
export type RasterSurfaceGeometry = {
    signature: string;
    vertices: Float64Array;
    bounds: THREE.Box3;
};
/** CPU counterpart of the existing raster vertex shader, including the DISPLAYED DEM and ECEF edge overrides. */
export declare function rasterSurfaceGeometry(mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>, ellipsoid: Ellipsoid): RasterSurfaceGeometry;
export declare function intersectRasterSurface(ray: THREE.Ray, mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>, ellipsoid: Ellipsoid, maximumDistance?: number): THREE.Vector3 | null;
//# sourceMappingURL=RasterSurfacePicker.d.ts.map