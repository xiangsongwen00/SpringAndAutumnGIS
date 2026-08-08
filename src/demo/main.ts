import layerCatalogJson from '../../env.config.json';
import {
  DEFAULT_LEVEL_OFFSET,
  DataSourceRegistry,
  GlobeEngine,
  LayerCollection,
  TerrainRgbProvider,
  type DataSourceDefinition,
  type GlobeEngineStats,
  type LayerDefinition,
  type LayerState,
  type RasterTileProvider
} from '../index';

type LayerCatalogConfig = Readonly<{
  version: 1;
  defaultBaseLayerId: string;
  defaults: Readonly<{ levelOffset: number }>;
  sources: readonly DataSourceDefinition[];
  layers: readonly LayerDefinition[];
}>;

type LocalTokenConfig = Readonly<{
  tianditu?: Readonly<{ token?: string }>;
  maptiler?: Readonly<{ key?: string }>;
  mapbox?: Readonly<{ publicToken?: string }>;
  geovis?: Readonly<{ terrainToken?: string }>;
  osm?: Readonly<{ vectorVersion?: string }>;
}>;

const layerCatalog = layerCatalogJson as unknown as LayerCatalogConfig;
const localTokens = await loadTokenConfig();
const container = requiredElement<HTMLElement>('#globe');
const selectedValue = requiredElement<HTMLElement>('#selected-value');
const visitedValue = requiredElement<HTMLElement>('#visited-value');
const culledValue = requiredElement<HTMLElement>('#culled-value');
const levelsValue = requiredElement<HTMLElement>('#levels-value');
const imageryValue = requiredElement<HTMLElement>('#imagery-value');
const terrainValue = requiredElement<HTMLElement>('#terrain-value');
const baseLayerSelect = requiredElement<HTMLSelectElement>('#base-layer-select');
const annotationControl = requiredElement<HTMLElement>('#annotation-control');
const annotationToggle = requiredElement<HTMLInputElement>('#annotation-toggle');
const terrainToggle = requiredElement<HTMLButtonElement>('#terrain-toggle');
const terrainTest = requiredElement<HTMLButtonElement>('#terrain-test');
const attribution = requiredElement<HTMLAnchorElement>('#map-attribution');
const levelOffsetInput = requiredElement<HTMLInputElement>('#level-offset');
const levelOffsetValue = requiredElement<HTMLOutputElement>('#level-offset-value');
const fpsValue = requiredElement<HTMLElement>('#fps-value');
const frameTimeValue = requiredElement<HTMLElement>('#frame-time-value');

const MIN_LOD_LEVEL = 2;
const MAX_LOD_LEVEL = 27;
const DEFAULT_LEVEL_OFFSET_VALUE = normalizeLevelOffset(
  layerCatalog.defaults.levelOffset ?? DEFAULT_LEVEL_OFFSET
);
const registry = new DataSourceRegistry(layerCatalog.sources, {
  defaultLevelOffset: DEFAULT_LEVEL_OFFSET_VALUE,
  variables: {
    TIANDITU_TOKEN:
      environmentValue(import.meta.env.VITE_TIANDITU_TOKEN) ??
      environmentValue(localTokens.tianditu?.token),
    MAPTILER_KEY:
      environmentValue(import.meta.env.VITE_MAPTILER_KEY) ??
      environmentValue(localTokens.maptiler?.key),
    OSM_VECTOR_VERSION:
      environmentValue(import.meta.env.VITE_OSM_VECTOR_VERSION) ??
      environmentValue(localTokens.osm?.vectorVersion)
  }
});
const layers = new LayerCollection(
  layerCatalog.layers.map((layer) => ({
    ...layer,
    levelOffset: layer.levelOffset ?? DEFAULT_LEVEL_OFFSET_VALUE
  }))
);
const baseLayers = layers.values().filter((layer) => layer.role === 'base');
populateBaseLayerOptions(baseLayers);

let activeBaseLayer = chooseInitialBaseLayer(baseLayers);
const initialLevelOffset = queryNumber(
  'levelOffset',
  activeBaseLayer.levelOffset,
  -4,
  1
);
activeBaseLayer = layers.setLevelOffset(activeBaseLayer.id, initialLevelOffset);
layers.setVisible(activeBaseLayer.id, true);
baseLayerSelect.value = activeBaseLayer.id;
let baseProvider: RasterTileProvider = registry.createRasterProvider(
  activeBaseLayer.sourceId,
  { levelOffset: activeBaseLayer.levelOffset }
);
let annotationLayerId: string | null = null;

const terrainEnabledByConfig = import.meta.env.VITE_ENABLE_TERRAIN === 'true';
let terrainEnabled = terrainEnabledByConfig;
const terrainTestLocations = [
  { name: '珠峰', longitude: 86.925, latitude: 27.988, altitude: 24_000 },
  { name: '重庆', longitude: 106.5516, latitude: 29.563, altitude: 12_000 }
] as const;
let terrainTestIndex = 0;

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
    [...stats.levels].map(([level, count]) => `${level}级：${count}`).join('　');
  const currentSourceLevel = Number.isFinite(baseProvider.currentSourceLevel)
    ? String(baseProvider.currentSourceLevel)
    : '—';
  const sourceName =
    `${activeBaseLayer.name}（实际${currentSourceLevel}级，偏移` +
    `${formatOffset(activeBaseLayer.levelOffset)}）`;
  imageryValue.textContent = stats.imagery
    ? `${sourceName} 目标${formatLevelRange(stats.imagery.desiredMinimumLevel, stats.imagery.desiredMaximumLevel)}级 / ` +
      `显示${formatLevelRange(stats.imagery.displayedMinimumLevel, stats.imagery.displayedMaximumLevel)}级 · ` +
      `纹理 ${stats.imagery.ready} 就绪 · ${stats.imagery.loading} 加载 · ${stats.imagery.queued} 排队 · ` +
      `${(stats.imagery.textureBytes / 1024 / 1024).toFixed(0)} MiB · ` +
      `${stats.imagery.fallbacks} 回退 · ${stats.imagery.errors} 失败` +
      (stats.imagery.lastError ? ` · ${stats.imagery.lastError}` : '')
    : '影像未启用';
  terrainValue.textContent = stats.terrain
    ? `地形 ${terrainEnabled ? '开启' : '关闭'} · ${stats.terrain.coverageReady ? '覆盖完成' : '粗层覆盖中'} · ${stats.terrain.ready} 就绪 · ${stats.terrain.loading} 加载 · ${(stats.terrain.resourceBytes / 1024 / 1024).toFixed(0)} MiB · ${stats.terrain.stitchedEdges} 接边 · ${stats.terrain.fallbacks} 回退 · ${stats.terrain.errors} 失败`
    : '地形未配置';
};

const geovisTerrainUrl = environmentValue(import.meta.env.VITE_GEOVIS_TERRAIN_URL) ??
  geovisTerrainUrlFromToken(environmentValue(localTokens.geovis?.terrainToken));
const mapTilerKey = environmentValue(import.meta.env.VITE_MAPTILER_KEY) ??
  environmentValue(localTokens.maptiler?.key);
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
  grid: { subdivisions: 8, heightOffset: 0.3 },
  imagery: baseProvider,
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
  initialView: { longitude: 105, latitude: 32, altitude: 8_600_000 },
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

applyActiveLayerUi();
engine.start();

baseLayerSelect.addEventListener('change', () => {
  const next = layers.get(baseLayerSelect.value);
  if (!next || next.role !== 'base') return;
  const availability = registry.availability(next.sourceId);
  if (!availability.available) {
    baseLayerSelect.value = activeBaseLayer.id;
    return;
  }
  layers.setVisible(next.id, true);
  activeBaseLayer = layers.get(next.id)!;
  baseProvider = registry.createRasterProvider(activeBaseLayer.sourceId, {
    levelOffset: activeBaseLayer.levelOffset
  });
  engine.setImageryProvider(baseProvider);
  annotationToggle.checked = false;
  removeAnnotationLayer();
  applyActiveLayerUi();
  updateQueryState();
});

levelOffsetInput.addEventListener('input', () => {
  const offset = Number(levelOffsetInput.value);
  if (!Number.isFinite(offset)) return;
  activeBaseLayer = layers.setLevelOffset(activeBaseLayer.id, offset);
  baseProvider.setViewLevelOffset?.(offset);
  if (annotationLayerId) {
    const annotationLayer = engine.getImageryLayer('annotation');
    annotationLayer?.provider.setViewLevelOffset?.(offset);
  }
  setLevelOffsetUi(offset);
  updateQueryState();
});

annotationToggle.addEventListener('change', () => {
  if (!annotationToggle.checked) {
    removeAnnotationLayer();
    return;
  }
  const candidateId = activeBaseLayer.annotationLayerIds?.[0];
  const candidate = candidateId ? layers.get(candidateId) : undefined;
  if (!candidate || !registry.availability(candidate.sourceId).available) {
    annotationToggle.checked = false;
    return;
  }
  removeAnnotationLayer();
  const provider = registry.createRasterProvider(candidate.sourceId, {
    levelOffset: activeBaseLayer.levelOffset
  });
  engine.addImageryLayer('annotation', provider, {
    overlay: true,
    order: 2,
    surfaceOffset: 0.45,
    maxCachedTiles: 1_024,
    maxTextureBytes: 96 * 1024 * 1024
  });
  annotationLayerId = candidate.id;
  layers.setVisible(candidate.id, true);
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

function populateBaseLayerOptions(candidates: readonly LayerState[]): void {
  for (const layer of candidates) {
    const source = registry.get(layer.sourceId);
    if (!source) continue;
    const availability = registry.availability(source.id);
    const option = document.createElement('option');
    option.value = layer.id;
    option.disabled = !availability.available;
    const suffix = !availability.supported
      ? '（等待原生矢量渲染）'
      : availability.missingVariables.length > 0
        ? `（缺少 ${availability.missingVariables.join('、')}）`
        : source.coordinateReference === 'gcj02-webmercator-in-china'
          ? '（中国区 GCJ-02 偏移）'
        : source.status === 'experimental'
          ? '（试验）'
          : '';
    option.textContent = `${layer.name}${suffix}`;
    baseLayerSelect.appendChild(option);
  }
}

function chooseInitialBaseLayer(candidates: readonly LayerState[]): LayerState {
  const requestedId =
    new URLSearchParams(window.location.search).get('baseLayer') ??
    layerCatalog.defaultBaseLayerId;
  const requested = candidates.find((layer) => layer.id === requestedId);
  if (requested && registry.availability(requested.sourceId).available) return requested;
  const fallback = candidates.find((layer) => registry.availability(layer.sourceId).available);
  if (!fallback) throw new Error('图层目录中没有当前可用的底图。');
  return fallback;
}

function applyActiveLayerUi(): void {
  baseLayerSelect.value = activeBaseLayer.id;
  setLevelOffsetUi(activeBaseLayer.levelOffset);
  const annotationId = activeBaseLayer.annotationLayerIds?.[0];
  const annotation = annotationId ? layers.get(annotationId) : undefined;
  annotationControl.hidden = !annotation;
  annotationToggle.disabled = !annotation || !registry.availability(annotation.sourceId).available;
  const source = registry.get(activeBaseLayer.sourceId);
  attribution.textContent = source?.attribution ?? activeBaseLayer.name;
  attribution.href = source?.termsUrl ?? '#';
}

function removeAnnotationLayer(): void {
  engine.removeImageryLayer('annotation');
  if (annotationLayerId) layers.setVisible(annotationLayerId, false);
  annotationLayerId = null;
}

function setLevelOffsetUi(offset: number): void {
  levelOffsetInput.value = String(offset);
  levelOffsetValue.value = formatOffset(offset);
  levelOffsetValue.textContent = formatOffset(offset);
}

function updateQueryState(): void {
  const url = new URL(window.location.href);
  url.searchParams.set('baseLayer', activeBaseLayer.id);
  url.searchParams.set('levelOffset', activeBaseLayer.levelOffset.toFixed(1));
  window.history.replaceState(null, '', url);
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`演示页面缺少元素：${selector}`);
  return element;
}

async function loadTokenConfig(): Promise<LocalTokenConfig> {
  try {
    const response = await fetch('/token.json', { cache: 'no-store' });
    if (!response.ok) return {};
    return await response.json() as LocalTokenConfig;
  } catch {
    return {};
  }
}

function geovisTerrainUrlFromToken(token: string | undefined): string | undefined {
  return token
    ? `https://tiles1.geovisearth.com/base/v1/terrain-rgb/{z}/{x}/{y}?format=png&tmsIds=w&token=${encodeURIComponent(token)}`
    : undefined;
}

function environmentValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return !trimmed || trimmed.includes('YOUR_') ? undefined : trimmed;
}

function numericEnvironmentValue(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function queryNumber(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = new URLSearchParams(window.location.search).get(name);
  if (raw === null || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function normalizeLevelOffset(value: number): number {
  return Number.isFinite(value) ? Math.max(-8, Math.min(2, value)) : DEFAULT_LEVEL_OFFSET;
}

function formatOffset(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}`;
}

function formatLevelRange(minimum: number | null, maximum: number | null): string {
  if (minimum === null || maximum === null) return '—';
  return minimum === maximum ? String(minimum) : `${minimum}–${maximum}`;
}
