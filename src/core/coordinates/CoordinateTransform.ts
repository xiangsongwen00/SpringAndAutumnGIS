import * as THREE from 'three';
import { Ellipsoid, type Cartographic } from '../geo/Ellipsoid';

export type WebMercatorPosition = Readonly<{ x: number; y: number }>;
export type TilePosition = Readonly<{ x: number; y: number; level: number }>;

export const WEB_MERCATOR_MAX_LATITUDE = 85.0511287798066;

/**
 * Authoritative CPU coordinate conversions.
 * World axes are X=east at 90E, Y=north pole, Z=longitude 0.
 */
export class CoordinateTransform {
  readonly ellipsoid: Ellipsoid;

  constructor(ellipsoid = Ellipsoid.WGS84) {
    this.ellipsoid = ellipsoid;
  }

  geodeticToWorld(position: Cartographic, result = new THREE.Vector3()): THREE.Vector3 {
    return this.ellipsoid.cartographicToCartesian(position, result);
  }

  worldToGeodetic(world: THREE.Vector3): Required<Cartographic> {
    // Convert engine axes to conventional ECEF axes before applying Bowring's formula.
    const x = world.z;
    const y = world.x;
    const z = world.y;
    const a = this.ellipsoid.equatorialRadius;
    const b = this.ellipsoid.polarRadius;
    const e2 = this.ellipsoid.eccentricitySquared;
    const ep2 = (a * a - b * b) / (b * b);
    const p = Math.hypot(x, y);
    if (p < 1e-9) {
      return {
        longitude: 0,
        latitude: z >= 0 ? 90 : -90,
        height: Math.abs(z) - b
      };
    }
    const theta = Math.atan2(z * a, p * b);
    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);
    const latitude = Math.atan2(
      z + ep2 * b * sinTheta ** 3,
      p - e2 * a * cosTheta ** 3
    );
    const longitude = Math.atan2(y, x);
    const sinLatitude = Math.sin(latitude);
    const n = a / Math.sqrt(1 - e2 * sinLatitude * sinLatitude);
    const height = p / Math.cos(latitude) - n;
    return {
      longitude: THREE.MathUtils.radToDeg(longitude),
      latitude: THREE.MathUtils.radToDeg(latitude),
      height
    };
  }

  geodeticToWebMercator(longitude: number, latitude: number): WebMercatorPosition {
    const clampedLatitude = THREE.MathUtils.clamp(
      latitude,
      -WEB_MERCATOR_MAX_LATITUDE,
      WEB_MERCATOR_MAX_LATITUDE
    );
    return {
      x: this.ellipsoid.equatorialRadius * THREE.MathUtils.degToRad(longitude),
      y:
        this.ellipsoid.equatorialRadius *
        Math.asinh(Math.tan(THREE.MathUtils.degToRad(clampedLatitude)))
    };
  }

  webMercatorToGeodetic(x: number, y: number): Pick<Cartographic, 'longitude' | 'latitude'> {
    const radius = this.ellipsoid.equatorialRadius;
    return {
      longitude: THREE.MathUtils.radToDeg(x / radius),
      latitude: THREE.MathUtils.radToDeg(Math.atan(Math.sinh(y / radius)))
    };
  }

  geodeticToTile(longitude: number, latitude: number, level: number): TilePosition {
    const size = 2 ** Math.max(0, Math.round(level));
    const clampedLatitude = THREE.MathUtils.clamp(
      latitude,
      -WEB_MERCATOR_MAX_LATITUDE,
      WEB_MERCATOR_MAX_LATITUDE
    );
    return {
      x: ((longitude + 180) / 360) * size,
      y:
        (1 - Math.asinh(Math.tan(THREE.MathUtils.degToRad(clampedLatitude))) / Math.PI) *
        0.5 *
        size,
      level: Math.max(0, Math.round(level))
    };
  }

  /** Local X=east, Y=north, Z=up transform in engine world coordinates. */
  eastNorthUpFrame(origin: Cartographic, result = new THREE.Matrix4()): THREE.Matrix4 {
    const longitude = THREE.MathUtils.degToRad(origin.longitude);
    const latitude = THREE.MathUtils.degToRad(origin.latitude);
    const sinLongitude = Math.sin(longitude);
    const cosLongitude = Math.cos(longitude);
    const sinLatitude = Math.sin(latitude);
    const cosLatitude = Math.cos(latitude);
    const east = new THREE.Vector3(cosLongitude, 0, -sinLongitude);
    const north = new THREE.Vector3(
      -sinLatitude * sinLongitude,
      cosLatitude,
      -sinLatitude * cosLongitude
    );
    const up = new THREE.Vector3(
      cosLatitude * sinLongitude,
      sinLatitude,
      cosLatitude * cosLongitude
    );
    result.makeBasis(east, north, up);
    result.setPosition(this.geodeticToWorld(origin));
    return result;
  }
}

