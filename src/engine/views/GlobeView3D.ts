import * as THREE from 'three';
import { BaseView, type ViewContext, type ViewState } from './BaseView';

export class GlobeView3D extends BaseView {
  constructor(context: ViewContext) {
    super('3d', context);
  }

  override applyViewState(state: ViewState): void {
    const { camera, cameraController, geo } = this.context;
    const target = geo.wgs84ToThree(state.centerLat, state.centerLon, 0);
    const normal = new THREE.Vector3(target.x, target.y, target.z).normalize();
    const eastSample = geo.wgs84ToThree(state.centerLat, state.centerLon + 0.01, 0);
    const northSample = geo.wgs84ToThree(state.centerLat + 0.01, state.centerLon, 0);
    const east = new THREE.Vector3(
      eastSample.x - target.x,
      eastSample.y - target.y,
      eastSample.z - target.z
    ).normalize();
    const north = new THREE.Vector3(
      northSample.x - target.x,
      northSample.y - target.y,
      northSample.z - target.z
    ).normalize();

    const headingRad = (state.heading * Math.PI) / 180;
    const pitchRad = (state.pitch * Math.PI) / 180;
    const heightWorld = Math.max(1, state.height) / geo.metersPerUnit;
    const horizontalWorld = Math.max(0, Math.cos(Math.abs(pitchRad))) * heightWorld * 0.35;
    const headingDir = east.multiplyScalar(Math.sin(headingRad)).add(north.multiplyScalar(Math.cos(headingRad)));
    const position = new THREE.Vector3(target.x, target.y, target.z)
      .addScaledVector(normal, heightWorld)
      .addScaledVector(headingDir, horizontalWorld);

    camera.position.copy(position);
    camera.lookAt(0, 0, 0);
    cameraController?.setTarget({ x: 0, y: 0, z: 0 });
  }
}
