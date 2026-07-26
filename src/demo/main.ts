import { Viewer } from '../index';

const container = document.getElementById('app');
if (!container) {
  throw new Error('Missing #app container');
}

const terrainRgbUrlTemplate = import.meta.env.VITE_SAG_TERRAIN_RGB_URL_TEMPLATE;
const imageryUrlTemplate =
  import.meta.env.VITE_SAG_IMAGERY_URL_TEMPLATE || 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const demoCenter = { lon: 105.7184, lat: 28.0564, height: 0 };

const viewer = new Viewer({
  container,
  viewMode: '3d',
  viewState: {
    centerLon: demoCenter.lon,
    centerLat: demoCenter.lat,
    height: 2_800_000,
    zoom: 4,
    heading: 0,
    pitch: -45
  },
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
    mapTiles: {
      enabled: false,
      originLon: 0,
      originLat: 0,
      urlTemplate: imageryUrlTemplate,
      yType: 'xyz',
      subdomains: ['a', 'b', 'c'],
      minZoom: 0,
      maxZoom: 22,
      tileRadius: 2,
      maxDynamicTileRadius: 12,
      maxConcurrentRequests: 16,
      maxCachedTiles: 1200,
      debugOverlay: false
    }
  }
});

const requireElement = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing #${id}`);
  }
  return element as T;
};

const view2dButton = requireElement<HTMLButtonElement>('view-2d');
const view3dButton = requireElement<HTMLButtonElement>('view-3d');
const description = requireElement<HTMLElement>('view-description');

const setMode = (mode: '2d' | '3d'): void => {
  viewer.setViewMode(mode);
  view2dButton.classList.toggle('is-active', mode === '2d');
  view3dButton.classList.toggle('is-active', mode === '3d');
  description.textContent =
    mode === '2d'
      ? 'MapView2D · Web Mercator / 独立平面渲染'
      : 'GlobeView3D · WGS84 / ECEF / 地形表面';
};

view2dButton.addEventListener('click', () => setMode('2d'));
view3dButton.addEventListener('click', () => setMode('3d'));

const ecef = viewer.geo.wgs84ToEcef(demoCenter.lat, demoCenter.lon, demoCenter.height);
const mercator = viewer.geo.lonLatToWebMercator(demoCenter.lon, demoCenter.lat);
const tile = viewer.geo.lonLatToTile(demoCenter.lon, demoCenter.lat, 12);

requireElement<HTMLElement>('coord-ecef').textContent =
  `${ecef.x.toFixed(0)}, ${ecef.y.toFixed(0)}, ${ecef.z.toFixed(0)}`;
requireElement<HTMLElement>('coord-mercator').textContent =
  `${mercator.x.toFixed(0)}, ${mercator.y.toFixed(0)}`;
requireElement<HTMLElement>('coord-tile').textContent = `12/${tile.x}/${tile.y}`;

viewer.start();
