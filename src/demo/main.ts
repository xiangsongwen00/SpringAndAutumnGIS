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
  cameraNear: 0.01,
  cameraController: {
    target: { x: 0, y: 0, z: 0 },
    lockTarget: true,
    dampingFactor: 0.35,
    minDampingDelta: 0.0008,
    rotateSpeed: 0.72,
    horizontalDragOnly: false,
    minRotateScale: 0.025,
    rotateAltitudeReference: 1_200_000,
    panSpeed: 1,
    panMercatorScale: 0.08,
    maxPanMetersPerPixel: 8_000,
    zoomSpeed: 0.55,
    minWheelZoomFactor: 0.92,
    maxWheelZoomFactor: 1.08,
    minPolarAngle: 0.02,
    maxPolarAngle: Math.PI - 0.02
  },
  planarValidation: {
    frontLonDeg: 0,
    initialCameraHeight: 2_800_000,
    minCameraAltitudeMeters: 0.1,
    lockCameraTargetToGlobeCenter: true,
    lodGrid: false,
    terrain: {
      enabled: true,
      rgbUrlTemplate: terrainRgbUrlTemplate,
      imageryUrlTemplate: '',
      imageryYType: 'xyz',
      imagerySubdomains: ['a', 'b', 'c'],
      imageryOpacity: 1,
      minZoom: 0,
      maxZoom: 13,
      tileRadius: 2,
      fullCoverageMaxZoom: 4,
      coverageScale: 4.2,
      maxDynamicTileRadius: 24,
      maxConcurrentRequests: 24,
      maxCachedTiles: 2800,
      tileSegments: 48,
      exaggeration: 1.2,
      zOffset: 0,
      decodeMode: 'auto',
      yType: 'tms'
    },
    globeImagery: {
      enabled: true,
      urlTemplate: imageryUrlTemplate,
      yType: 'xyz',
      subdomains: ['a', 'b', 'c'],
      opacity: 1,
      minZoom: 0,
      maxZoom: 22,
      tileRadius: 2,
      fullCoverageMaxZoom: 4,
      coverageScale: 4.2,
      maxDynamicTileRadius: 24,
      maxConcurrentRequests: 24,
      maxCachedTiles: 2800,
      tileSegments: 16,
      surfaceOffsetMeters: 80
    },
    mapTiles: false
  }
});

viewer.start();
