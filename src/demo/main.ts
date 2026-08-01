import {
  GlobeEngine,
  UrlTemplateRasterProvider,
  type GlobeEngineStats
} from '../index';

const container = document.querySelector<HTMLElement>('#globe');
const selectedValue = document.querySelector<HTMLElement>('#selected-value');
const visitedValue = document.querySelector<HTMLElement>('#visited-value');
const culledValue = document.querySelector<HTMLElement>('#culled-value');
const levelsValue = document.querySelector<HTMLElement>('#levels-value');
const imageryValue = document.querySelector<HTMLElement>('#imagery-value');

const MIN_LOD_LEVEL = 2;
const MAX_LOD_LEVEL = 27;
const MAX_GOOGLE_IMAGERY_LEVEL = 20;

if (!container || !selectedValue || !visitedValue || !culledValue || !levelsValue || !imageryValue) {
  throw new Error('演示页面结构不完整。');
}

const renderStats = (stats: GlobeEngineStats): void => {
  selectedValue.textContent = String(stats.selected);
  visitedValue.textContent = String(stats.visited);
  culledValue.textContent = String(stats.horizonCulled + stats.frustumCulled);
  const activeLevels = [...stats.levels.keys()];
  const minimumLevel = activeLevels.length > 0 ? Math.min(...activeLevels) : 0;
  const maximumLevel = activeLevels.length > 0 ? Math.max(...activeLevels) : 0;
  levelsValue.textContent =
    `相机层级 ${stats.cameraLevel.toFixed(1)} / 范围 ${MIN_LOD_LEVEL}–${MAX_LOD_LEVEL}　` +
    `可见层级 ${minimumLevel}–${maximumLevel}　` +
    [...stats.levels]
      .map(([level, count]) => `${level}级：${count}`)
      .join('　');
  imageryValue.textContent = stats.imagery
    ? `纹理 ${stats.imagery.ready} 就绪 · ${stats.imagery.loading} 加载 · ${stats.imagery.fallbacks} 回退`
    : '影像未启用';
};

const imagery = new UrlTemplateRasterProvider({
  id: 'google-satellite-demo',
  urlTemplate: 'https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
  subdomains: ['0', '1', '2', '3'],
  maxLevel: MAX_GOOGLE_IMAGERY_LEVEL,
  attribution: 'Google Maps'
});

const engine = new GlobeEngine({
  container,
  lod: {
    minLevel: MIN_LOD_LEVEL,
    maxLevel: MAX_LOD_LEVEL,
    targetPixels: 128,
    collapseFactor: 0.7,
    maxTiles: 1_024
  },
  grid: {
    subdivisions: 8,
    heightOffset: 0.3
  },
  imagery,
  raster: {
    segments: 16,
    maxConcurrentRequests: 10,
    maxCachedTiles: 2_048,
    surfaceOffset: 0.1
  },
  initialView: {
    longitude: 105,
    latitude: 32,
    altitude: 8_600_000
  },
  navigation: {
    rotateSpeed: 0.38,
    minRotateSpeed: 0.000001,
    zoomSpeed: 0.42,
    minZoomSpeed: 0.00000001,
    zoomAltitudeGain: 5,
    dampingFactor: 0.1,
    minAltitude: 0.25
  },
  onStats: renderStats
});

engine.start();

window.addEventListener('pagehide', () => engine.dispose(), { once: true });
