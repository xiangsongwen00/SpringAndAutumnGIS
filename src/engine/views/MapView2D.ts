import { BaseView, zoomToHeight, type ViewContext, type ViewState } from './BaseView';

export class MapView2D extends BaseView {
  constructor(context: ViewContext) {
    super('2d', context);
  }

  override applyViewState(state: ViewState): void {
    const { camera, cameraController, geo } = this.context;
    const center = geo.lonLatToWebMercator(state.centerLon, state.centerLat);
    const target = {
      x: center.x / geo.metersPerUnit,
      y: center.y / geo.metersPerUnit,
      z: 0
    };
    const heightMeters = state.height > 0 ? state.height : zoomToHeight(state.zoom);
    const heightWorld = Math.max(1, heightMeters) / geo.metersPerUnit;

    camera.up.set(0, 1, 0);
    camera.position.set(target.x, target.y, heightWorld);
    camera.lookAt(target.x, target.y, target.z);
    if (cameraController) {
      cameraController.lockTarget = false;
      cameraController.orbitRadius = 1;
      cameraController.horizontalDragOnly = true;
      cameraController.minDistance = 1;
      cameraController.setTarget(target);
    }
  }
}
