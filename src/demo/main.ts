import {
  ArcGisVectorRasterProvider,
  GlobeEngine,
  TerrainRgbProvider,
  UrlTemplateRasterProvider,
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
const terrainTest = document.querySelector<HTMLButtonElement>('#terrain-test');
const terrainValue = document.querySelector<HTMLElement>('#terrain-value');
const attribution = document.querySelector<HTMLAnchorElement>('#map-attribution');
const satelliteLevelDebug = document.querySelector<HTMLElement>('#satellite-level-debug');
const satelliteLevelOffsetInput = document.querySelector<HTMLInputElement>('#satellite-level-offset');
const satelliteLevelOffsetValue = document.querySelector<HTMLOutputElement>('#satellite-level-offset-value');
const fpsValue = document.querySelector<HTMLElement>('#fps-value');
const frameTimeValue = document.querySelector<HTMLElement>('#frame-time-value');

const MIN_LOD_LEVEL = 2;
const MAX_LOD_LEVEL = 27;
const MAX_GOOGLE_IMAGERY_LEVEL = 20;
const ESRI_LEVEL_OFFSET = -1.7;
const DEFAULT_GOOGLE_LEVEL_OFFSET = -1.7;
const initialGoogleLevelOffset = queryNumber(
  'satelliteLevelOffset',
  DEFAULT_GOOGLE_LEVEL_OFFSET,
  -4,
  1
);
let vectorMode = false;
const terrainEnabledByConfig = import.meta.env.VITE_ENABLE_TERRAIN === 'true';
let terrainEnabled = terrainEnabledByConfig;
const terrainTestLocations = [
  { name: '珠峰', longitude: 86.925, latitude: 27.988, altitude: 24_000 },
  { name: '重庆', longitude: 106.5516, latitude: 29.563, altitude: 12_000 }
] as const;
let terrainTestIndex = 0;

if (!container || !selectedValue || !visitedValue || !culledValue || !levelsValue || !imageryValue || !terrainValue || !mapToggle || !terrainToggle || !terrainTest || !attribution || !satelliteLevelDebug || !satelliteLevelOffsetInput || !satelliteLevelOffsetValue) {
  throw new Error('演示页面结构不完整。');
}

if (!fpsValue || !frameTimeValue) {
  throw new Error('实时帧率显示结构不完整。');
}

let fpsAnimationFrame = 0;
let fpsWindowStart = performance.now();
let fpsFrameCount = 0;
let smoothedFps = 0;

const updateFps = (now: number): void => {
  fpsFrameCount += 1;
  const elapsed = now - fpsWindowStart;
  if (elapsed >= 500) {
    const measuredFps = (fpsFrameCount * 1000) / elapsed;
    smoothedFps = smoothedFps === 0 ? measuredFps : smoothedFps * 0.35 + measuredFps * 0.65;
    fpsValue.textContent = `${Math.round(smoothedFps)} FPS`;
    frameTimeValue.textContent = `${(1000 / Math.max(smoothedFps, 0.1)).toFixed(1)} ms`;
    fpsFrameCount = 0;
    fpsWindowStart = now;
  }
  fpsAnimationFrame = requestAnimationFrame(updateFps);
};

fpsAnimationFrame = requestAnimationFrame(updateFps);

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
  const sourceName = vectorMode
    ? '矢量（数据层级=floor(相机-2)）'
    : `卫星（实际${imagery.currentSourceLevel}级，偏移${formatOffset(initialGoogleLevelOffsetState)}）`;
  imageryValue.textContent = stats.imagery
    ? `${sourceName} 目标${formatLevelRange(stats.imagery.desiredMinimumLevel, stats.imagery.desiredMaximumLevel)}级 / ` +
      `显示${formatLevelRange(stats.imagery.displayedMinimumLevel, stats.imagery.displayedMaximumLevel)}级 · ` +
      `纹理 ${stats.imagery.ready} 就绪 · ${stats.imagery.loading} 加载 · ${stats.imagery.queued} 排队 · ` +
      `${(stats.imagery.textureBytes / 1024 / 1024).toFixed(0)} MiB · ` +
      `${stats.imagery.fallbacks} 回退 · ${stats.imagery.errors} 失败`
    : '影像未启用';
  terrainValue.textContent = stats.terrain
    ? `地形 ${terrainEnabled ? '开启' : '关闭'} · ${stats.terrain.coverageReady ? '覆盖完成' : '粗层覆盖中'} · ${stats.terrain.ready} 就绪 · ${stats.terrain.loading} 加载 · ${(stats.terrain.resourceBytes / 1024 / 1024).toFixed(0)} MiB · ${stats.terrain.stitchedEdges} 接边 · ${stats.terrain.fallbacks} 回退 · ${stats.terrain.errors} 失败`
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
  viewLevelOffset: initialGoogleLevelOffset,
  attribution: 'Google Maps'
});

let initialGoogleLevelOffsetState = initialGoogleLevelOffset;
satelliteLevelOffsetInput.value = String(initialGoogleLevelOffsetState);
satelliteLevelOffsetValue.value = formatOffset(initialGoogleLevelOffsetState);
satelliteLevelOffsetValue.textContent = formatOffset(initialGoogleLevelOffsetState);
satelliteLevelOffsetInput.addEventListener('input', () => {
  const offset = Number(satelliteLevelOffsetInput.value);
  if (!Number.isFinite(offset)) return;
  initialGoogleLevelOffsetState = offset;
  satelliteLevelOffsetValue.value = formatOffset(offset);
  satelliteLevelOffsetValue.textContent = formatOffset(offset);
  imagery.setViewLevelOffset(offset);
  const url = new URL(window.location.href);
  url.searchParams.set('satelliteLevelOffset', offset.toFixed(1));
  window.history.replaceState(null, '', url);
});

const vectorMap = new ArcGisVectorRasterProvider({
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
    horizonDetailExponent: 0.5,
    maximumSurfaceDisplacement: terrain ? 12_000 * numericEnvironmentValue(
      import.meta.env.VITE_TERRAIN_EXAGGERATION,
      1
    ) : 0
  },
  grid: {
    subdivisions: 8,
    heightOffset: 0.3
  },
  imagery,
  terrain,
  terrainLayer: {
    segments: 64,
    maxConcurrentRequests: 4,
    maxCachedTiles: 256,
    maxResourceBytes: 96 * 1024 * 1024,
    showDebugSurface: false,
    exaggeration: numericEnvironmentValue(import.meta.env.VITE_TERRAIN_EXAGGERATION, 1)
  },
  raster: {
    segments: 16,
    maxConcurrentRequests: 10,
    maxCachedTiles: 2_048,
    maxTextureBytes: 192 * 1024 * 1024,
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
  satelliteLevelDebug.hidden = vectorMode;
});

window.addEventListener('pagehide', () => {
  cancelAnimationFrame(fpsAnimationFrame);
  engine.dispose();
}, { once: true });

if (!terrain) {
  terrainEnabled = false;
  terrainToggle.disabled = true;
  terrainToggle.textContent = '未配置地形';
  terrainToggle.setAttribute('aria-pressed', 'false');
  terrainTest.disabled = true;
  terrainTest.textContent = '未配置地形测试';
} else {
  terrainToggle.textContent = terrainEnabled ? '关闭地形' : '开启地形';
  terrainToggle.setAttribute('aria-pressed', String(terrainEnabled));
  terrainToggle.addEventListener('click', () => {
    terrainEnabled = !terrainEnabled;
    engine.setTerrainEnabled(terrainEnabled);
    terrainToggle.textContent = terrainEnabled ? '关闭地形' : '开启地形';
    terrainToggle.setAttribute('aria-pressed', String(terrainEnabled));
  });
  terrainTest.addEventListener('click', () => {
    if (!terrainEnabled) {
      terrainEnabled = true;
      engine.setTerrainEnabled(true);
      terrainToggle.textContent = '关闭地形';
      terrainToggle.setAttribute('aria-pressed', 'true');
    }
    const location = terrainTestLocations[terrainTestIndex];
    if (!location) return;
    engine.flyTo({
      longitude: location.longitude,
      latitude: location.latitude,
      altitude: location.altitude,
      heading: 25,
      pitch: -55,
      duration: 1_800
    });
    terrainTestIndex = (terrainTestIndex + 1) % terrainTestLocations.length;
    terrainTest.textContent = `定位${terrainTestLocations[terrainTestIndex]!.name}地形`;
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

function queryNumber(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = new URLSearchParams(window.location.search).get(name);
  if (raw === null || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function formatOffset(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}`;
}

function formatLevelRange(minimum: number | null, maximum: number | null): string {
  if (minimum === null || maximum === null) return '—';
  return minimum === maximum ? String(minimum) : `${minimum}–${maximum}`;
}
