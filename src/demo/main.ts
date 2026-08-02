import {
  GlobeEngine,
  TerrainRgbProvider,
  UrlTemplateRasterProvider,
  VectorStyleTileProvider,
  type GlobeEngineStats
} from '../index';

const container = document.querySelector<HTMLElement>('#globe');
const selectedValue = document.querySelector<HTMLElement>('#selected-value');
const visitedValue = document.querySelector<HTMLElement>('#visited-value');
const culledValue = document.querySelector<HTMLElement>('#culled-value');
const levelsValue = document.querySelector<HTMLElement>('#levels-value');
const imageryValue = document.querySelector<HTMLElement>('#imagery-value');
const mapToggle = document.querySelector<HTMLButtonElement>('#map-toggle');
const terrainToggle = document.querySelector<HTMLButtonElement>('#terrain-toggle');
const terrainValue = document.querySelector<HTMLElement>('#terrain-value');
const attribution = document.querySelector<HTMLAnchorElement>('#map-attribution');

const MIN_LOD_LEVEL = 2;
const MAX_LOD_LEVEL = 27;
const MAX_GOOGLE_IMAGERY_LEVEL = 20;
const ESRI_LEVEL_OFFSET = -1.7;
let vectorMode = false;
const terrainEnabledByConfig = import.meta.env.VITE_ENABLE_TERRAIN === 'true';
let terrainEnabled = terrainEnabledByConfig;

if (!container || !selectedValue || !visitedValue || !culledValue || !levelsValue || !imageryValue || !terrainValue || !mapToggle || !terrainToggle || !attribution) {
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
  const sourceName = vectorMode ? '矢量（数据层级=floor(相机-2)）' : '卫星';
  imageryValue.textContent = stats.imagery
    ? `${sourceName}纹理 ${stats.imagery.ready} 就绪 · ${stats.imagery.loading} 加载 · ${stats.imagery.fallbacks} 回退 · ${stats.imagery.errors} 失败`
    : '影像未启用';
  terrainValue.textContent = stats.terrain
    ? `地形 ${terrainEnabled ? '开启' : '关闭'} · ${stats.terrain.ready} 就绪 · ${stats.terrain.loading} 加载 · ${stats.terrain.fallbacks} 回退 · ${stats.terrain.errors} 失败`
    : '地形未配置';
};

const geovisTerrainUrl = environmentValue(import.meta.env.VITE_GEOVIS_TERRAIN_URL);
const mapTilerKey = environmentValue(import.meta.env.VITE_MAPTILER_KEY);
const terrain = terrainEnabledByConfig && (geovisTerrainUrl || mapTilerKey)
  ? new TerrainRgbProvider({
      id: 'terrain-rgb-demo',
      urlTemplates: geovisTerrainUrl ? [geovisTerrainUrl] : undefined,
      tileJsonUrl: mapTilerKey
        ? `https://api.maptiler.com/tiles/terrain-rgb-v2/tiles.json?key=${encodeURIComponent(mapTilerKey)}`
        : undefined,
      scheme: import.meta.env.VITE_GEOVIS_TERRAIN_SCHEME ?? 'xyz',
      encoding: 'mapbox',
      maxLevel: 14,
      attribution: 'GeoVIS / MapTiler'
    })
  : undefined;

const imagery = new UrlTemplateRasterProvider({
  id: 'google-satellite-demo',
  urlTemplate: 'https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
  subdomains: ['0', '1', '2', '3'],
  maxLevel: MAX_GOOGLE_IMAGERY_LEVEL,
  attribution: 'Google Maps'
});

const vectorMap = new VectorStyleTileProvider({
  id: 'esri-vector-style-demo',
  styleUrl: '/En.json',
  sourceId: 'esri',
  maxLevel: 20,
  levelOffset: ESRI_LEVEL_OFFSET,
  minimumLodLevelOffset: -1,
  showCountryLabels: true,
  tileSize: 512,
  attribution: 'Esri'
});

const engine = new GlobeEngine({
  container,
  lod: {
    minLevel: MIN_LOD_LEVEL,
    maxLevel: MAX_LOD_LEVEL,
    targetPixels: 128,
    collapseFactor: 0.7,
    maxTiles: 480,
    minimumHorizonDetailFactor: 0.08,
    horizonDetailExponent: 0.5
  },
  grid: {
    subdivisions: 8,
    heightOffset: 0.3
  },
  imagery,
  terrain,
  terrainLayer: {
    segments: 64,
    maxConcurrentRequests: 6,
    maxCachedTiles: 384,
    exaggeration: numericEnvironmentValue(import.meta.env.VITE_TERRAIN_EXAGGERATION, 1)
  },
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
    lookSpeed: 1,
    tiltSpeed: 1,
    dampingFactor: 0.1,
    minAltitude: 0.25
  },
  onStats: renderStats
});

engine.start();

mapToggle.addEventListener('click', () => {
  vectorMode = !vectorMode;
  engine.setImageryProvider(vectorMode ? vectorMap : imagery);
  mapToggle.textContent = vectorMode ? '切换到卫星影像' : '切换到矢量地图';
  mapToggle.classList.toggle('is-vector', vectorMode);
  mapToggle.setAttribute('aria-pressed', String(vectorMode));
  attribution.textContent = vectorMode ? 'Esri · Vector Basemap' : 'Google Maps · Satellite';
  attribution.href = vectorMode ? 'https://www.esri.com/' : 'https://maps.google.com/';
});

window.addEventListener('pagehide', () => engine.dispose(), { once: true });

if (!terrain) {
  terrainEnabled = false;
  terrainToggle.disabled = true;
  terrainToggle.textContent = '未配置地形';
  terrainToggle.setAttribute('aria-pressed', 'false');
} else {
  terrainToggle.addEventListener('click', () => {
    terrainEnabled = !terrainEnabled;
    engine.setTerrainEnabled(terrainEnabled);
    terrainToggle.textContent = terrainEnabled ? '关闭地形' : '开启地形';
    terrainToggle.setAttribute('aria-pressed', String(terrainEnabled));
  });
}

function environmentValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return !trimmed || trimmed.includes('YOUR_') ? undefined : trimmed;
}

function numericEnvironmentValue(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
