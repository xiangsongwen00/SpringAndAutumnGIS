import * as THREE from 'three';
import { Viewer } from '../index';

const container = document.getElementById('app');
if (!container) {
  throw new Error('Missing #app container');
}

const viewer = new Viewer({ container });
const geo = viewer.geo;

geo.setFrontLonDeg(0);
viewer.setRenderOrigin({ x: 0, y: 0, z: 0 }, false);
viewer.camera.position.set(0, 0, 12000);
viewer.camera.lookAt(0, 0, 0);
viewer.cameraController?.setTarget({ x: 0, y: 0, z: 0 });

const axes = new THREE.AxesHelper(10000);
viewer.addWorldObject(axes);

const xian = geo.wgs84ToThree(34.34, 108, 0);
const marker = new THREE.Mesh(
  new THREE.SphereGeometry(120, 16, 16),
  new THREE.MeshBasicMaterial({ color: 0xf97316 })
);
marker.position.set(xian.x, xian.y, xian.z);
viewer.addWorldObject(marker);

const hud = document.querySelector('.hud') as HTMLElement | null;
viewer.addUpdateHandler(() => {
  if (!hud) return;
  const camWorld = viewer.getCameraWorldPosition();
  const camGeo = geo.threeToWgs84(camWorld);

  hud.textContent = [
    'Core coordinate refactor mode',
    `camera lon=${camGeo.lon.toFixed(5)} lat=${camGeo.lat.toFixed(5)} h=${camGeo.height.toFixed(1)}m`,
    'axes length=10000',
    'LMB rotate | RMB/MMB pan | wheel zoom | T top-view'
  ].join(' | ');
});

window.addEventListener('keydown', (event) => {
  if (event.key.toLowerCase() !== 't') return;
  const target = viewer.cameraController?.target ?? { x: 0, y: 0, z: 0 };
  viewer.camera.position.set(target.x, target.y, target.z + 12000);
  viewer.camera.lookAt(target.x, target.y, target.z);
  viewer.cameraController?.setTarget(target);
});

viewer.start();
