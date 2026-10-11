import * as THREE from 'three';
import { type GroundPatch } from './EntityGroundSurface';
import type { EntityDefinition } from '../sdk/EntityTypes';
export type GroundGeometry = {
    center: THREE.Vector3;
    anchorReady: boolean;
    paths: THREE.Vector3[][];
    normals: THREE.Vector3[];
    groups: number[];
    fill: number[];
    uvs: number[];
    patches: number;
    vertices: number;
};
/** Clip business geometry into the SAME displayed terrain triangles. Yields bounded CPU slices, never requests DEM. */
export declare function buildGroundGeometry(definition: EntityDefinition, patches: readonly GroundPatch[]): Generator<void, GroundGeometry>;
//# sourceMappingURL=EntityGroundGeometry.d.ts.map