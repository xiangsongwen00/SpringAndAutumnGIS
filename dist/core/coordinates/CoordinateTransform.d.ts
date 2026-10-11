import * as THREE from 'three';
import { Ellipsoid, type Cartographic } from '../geo/Ellipsoid';
export type WebMercatorPosition = Readonly<{
    x: number;
    y: number;
}>;
export type TilePosition = Readonly<{
    x: number;
    y: number;
    level: number;
}>;
export declare const WEB_MERCATOR_MAX_LATITUDE = 85.0511287798066;
/**
 * Authoritative CPU coordinate conversions.
 * World axes are X=east at 90E, Y=north pole, Z=longitude 0.
 */
export declare class CoordinateTransform {
    readonly ellipsoid: Ellipsoid;
    constructor(ellipsoid?: Ellipsoid);
    geodeticToWorld(position: Cartographic, result?: THREE.Vector3): THREE.Vector3;
    worldToGeodetic(world: THREE.Vector3): Required<Cartographic>;
    geodeticToWebMercator(longitude: number, latitude: number): WebMercatorPosition;
    webMercatorToGeodetic(x: number, y: number): Pick<Cartographic, 'longitude' | 'latitude'>;
    geodeticToTile(longitude: number, latitude: number, level: number): TilePosition;
    /** Local X=east, Y=north, Z=up transform in engine world coordinates. */
    eastNorthUpFrame(origin: Cartographic, result?: THREE.Matrix4): THREE.Matrix4;
}
//# sourceMappingURL=CoordinateTransform.d.ts.map