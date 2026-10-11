import * as THREE from 'three';
export type Cartographic = {
    longitude: number;
    latitude: number;
    height?: number;
};
/** WGS84 ellipsoid expressed in an Earth-centred Three.js coordinate system. */
export declare class Ellipsoid {
    static readonly WGS84: Ellipsoid;
    readonly equatorialRadius: number;
    readonly polarRadius: number;
    readonly eccentricitySquared: number;
    constructor(equatorialRadius: number, polarRadius: number);
    cartographicToCartesian(position: Cartographic, result?: THREE.Vector3): THREE.Vector3;
}
//# sourceMappingURL=Ellipsoid.d.ts.map