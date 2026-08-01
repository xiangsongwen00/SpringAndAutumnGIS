import * as THREE from 'three';

export type Cartographic = {
  longitude: number;
  latitude: number;
  height?: number;
};

/** WGS84 ellipsoid expressed in an Earth-centred Three.js coordinate system. */
export class Ellipsoid {
  static readonly WGS84 = new Ellipsoid(6_378_137, 6_356_752.314245179);

  readonly equatorialRadius: number;
  readonly polarRadius: number;
  readonly eccentricitySquared: number;

  constructor(equatorialRadius: number, polarRadius: number) {
    if (equatorialRadius <= 0 || polarRadius <= 0) {
      throw new Error('Ellipsoid radii must be positive.');
    }
    this.equatorialRadius = equatorialRadius;
    this.polarRadius = polarRadius;
    this.eccentricitySquared =
      1 - (polarRadius * polarRadius) / (equatorialRadius * equatorialRadius);
  }

  cartographicToCartesian(position: Cartographic, result = new THREE.Vector3()): THREE.Vector3 {
    const longitude = THREE.MathUtils.degToRad(position.longitude);
    const latitude = THREE.MathUtils.degToRad(position.latitude);
    const height = position.height ?? 0;
    const sinLatitude = Math.sin(latitude);
    const cosLatitude = Math.cos(latitude);
    const primeVerticalRadius =
      this.equatorialRadius /
      Math.sqrt(1 - this.eccentricitySquared * sinLatitude * sinLatitude);

    // Y is north. Looking from +Z puts zero longitude at the centre of the screen.
    return result.set(
      (primeVerticalRadius + height) * cosLatitude * Math.sin(longitude),
      (primeVerticalRadius * (1 - this.eccentricitySquared) + height) * sinLatitude,
      (primeVerticalRadius + height) * cosLatitude * Math.cos(longitude)
    );
  }
}

