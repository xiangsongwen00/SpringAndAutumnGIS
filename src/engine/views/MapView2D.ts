import * as THREE from 'three';
import { BaseView, zoomToHeight, type ViewContext, type ViewState } from './BaseView';

export class MapView2D extends BaseView {
  constructor(context: ViewContext) {
    super('2d', context);
  }

  override applyViewState(state: ViewState): void {
    const { camera, cameraController, geo } = this.context;
    const target = geo.wgs84ToThree(state.centerLat, state.centerLon, 0);
    const normal = new THREE.Vector3(target.x, target.y, target.z).normalize();
    const heightMeters = state.height > 0 ? state.height : zoomToHeight(state.zoom);
    const position = new THREE.Vector3(target.x, target.y, target.z).addScaledVector(
      normal,
      Math.max(1, heightMeters) / geo.metersPerUnit
    );

    camera.position.copy(position);
    camera.lookAt(target.x, target.y, target.z);
    cameraController?.setTarget(target);
  }
}
