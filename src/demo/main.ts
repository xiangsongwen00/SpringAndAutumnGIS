import { Viewer } from '../index';

const container = document.getElementById('app');
if (!container) {
  throw new Error('Missing #app container');
}

const terrainRgbUrlTemplate = import.meta.env.VITE_SAG_TERRAIN_RGB_URL_TEMPLATE;
const imageryUrlTemplate =
  import.meta.env.VITE_SAG_IMAGERY_URL_TEMPLATE || 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';

const viewer = new Viewer({
  container,
  cameraController: {
    target: { x: 0, y: 0, z: 0 },
    lockTarget: true,
    dampingFactor: 0.32,
    minDampingDelta: 0.0005,
    zoomSpeed: 0.75,
    minPolarAngle: 0.02,
    maxPolarAngle: Math.PI - 0.02
  },
  planarValidation: {
    frontLonDeg: 0,
    initialCameraHeight: 2_800_000,
    lockCameraTargetToGlobeCenter: true,
    lodGrid: false,
    terrain: {
      enabled: true,
      rgbUrlTemplate: terrainRgbUrlTemplate,
      imageryUrlTemplate,
      imageryYType: 'xyz',
      imagerySubdomains: ['a', 'b', 'c'],
      imageryOpacity: 1,
      minZoom: 0,
      maxZoom: 13,
      tileRadius: 2,
      fullCoverageMaxZoom: 4,
      maxConcurrentRequests: 12,
      maxCachedTiles: 420,
      tileSegments: 48,
      exaggeration: 1.2,
      zOffset: 0,
      decodeMode: 'auto',
      yType: 'tms'
    },
    mapTiles: false
  }
});

viewer.start();
