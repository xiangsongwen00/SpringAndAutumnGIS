import layerCatalogJson from '../../env.config.json';
import { attachEntityPlayground } from './EntityPlayground';
import {
  DEFAULT_LEVEL_OFFSET,
  DataSourceRegistry,
  GlobeEngine,
  GeoJsonLayer,
  LayerCollection,
  MvtRasterProvider,
  GpuVectorTileProvider,
  MvtVectorLayer,
  TerrainRgbProvider,
  UrlTemplateRasterProvider,
  type DataSourceDefinition,
  type GlobeEngineStats,
  type GlobeFramePerformance,
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
// Opt-in bounded samples for the dynamic browser audit, absent in normal use.
const auditWindow = window as Window & { __terrainFrameAudit?: GlobeFramePerformance[]; __coldFrameAudit?: GlobeFramePerformance[];
  __motionSampling?: boolean; __coldSampling?: boolean };
const entitySmoke = new URLSearchParams(window.location.search).get('entitySmoke') === '1';
const localTokens = entitySmoke ? {} : await loadTokenConfig();
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
const businessLayerControl = requiredElement<HTMLButtonElement>('#business-layer-control');
const businessLayerTest = requiredElement<HTMLButtonElement>('#business-layer-test');
const geoJsonTest = requiredElement<HTMLButtonElement>('#geojson-test');
const businessLayerPanel = requiredElement<HTMLElement>('#business-layer-panel');
const businessLayerList = requiredElement<HTMLElement>('#business-layer-list');
const businessLayerSummary = requiredElement<HTMLElement>('#business-layer-summary');
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
const businessLayers = layers.values().filter((layer) => layer.role === 'overlay');
populateBaseLayerOptions(baseLayers);
populateBusinessLayerControls(businessLayers);

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
let baseProvider: RasterTileProvider;
let nativeBase: GpuVectorTileProvider | null = null;
let nativeSymbols: MvtVectorLayer | null = null;
try {
  layers.setRuntime(activeBaseLayer.id, { phase: 'loading', pending: 1 });
  baseProvider = entitySmoke ? new UrlTemplateRasterProvider({urlTemplate:'/entity-smoke-unused/{z}/{x}/{y}.png'}) : await registry.createRasterProviderAsync(
    activeBaseLayer.kind === 'vector' ? 'google-satellite' : activeBaseLayer.sourceId,
    { levelOffset: activeBaseLayer.levelOffset }
  );
  await diagnoseMvtStyle(baseProvider, `底图 ${activeBaseLayer.id}`);
  layers.setRuntime(activeBaseLayer.id, { phase: 'ready', pending: 0, ready: 1 });
} catch (error) {
  const failedLayer = activeBaseLayer;
  layers.setRuntime(failedLayer.id, {
    phase: 'error', pending: 0, failed: 1,
    lastError: error instanceof Error ? error.message : String(error)
  });
  const fallback = baseLayers.find((layer) =>
    layer.id !== failedLayer.id && registry.availability(layer.sourceId).available &&
    registry.get(layer.sourceId)?.capabilitiesUrl === undefined
  );
  if (!fallback) throw error;
  console.error(`[图层 ${failedLayer.id}] 初始加载失败，回退到 ${fallback.id}`, error);
  layers.setVisible(fallback.id, true);
  activeBaseLayer = layers.get(fallback.id)!;
  baseLayerSelect.value = activeBaseLayer.id;
  baseProvider = await registry.createRasterProviderAsync(activeBaseLayer.sourceId, {
    levelOffset: activeBaseLayer.levelOffset
  });
  await diagnoseMvtStyle(baseProvider, `回退底图 ${activeBaseLayer.id}`);
  layers.setRuntime(activeBaseLayer.id, { phase: 'ready', pending: 0, ready: 1 });
}
let annotationLayerId: string | null = null;
const businessLayerRevisions = new Map<string, number>();
const businessLayerControllers = new Map<string, AbortController>();

const terrainEnabledByConfig = import.meta.env.VITE_ENABLE_TERRAIN === 'true';
let terrainEnabled = terrainEnabledByConfig && new URLSearchParams(window.location.search).get('terrain') !== '0';
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
      ` · 高清保留 ${stats.imagery.continuityPatches} 块/${(stats.imagery.continuityBytes / 1024 / 1024).toFixed(1)} MiB` +
      (stats.imagery.lastError ? ` · ${stats.imagery.lastError}` : '')
    : '影像未启用';
  if (nativeBase) {
    const report = nativeBase.capabilityReport;
    imageryValue.textContent += ` · GPU 地表绘制 · ${nativeSymbols ? '独立点注记' : '注记待接入'}${report
      ? ` · 样式 ${report.supportedLayers}支持/${report.degradedLayers}降级/${report.unsupportedLayers}跳过` : ''}`;
    imageryValue.textContent += ` · PBF≤${nativeBase.dataMaxLevel}级/绘制≤${nativeBase.maxLevel}级`;
    const draw = nativeBase.drawStats;
    imageryValue.textContent += ` · 制图${draw.queued}排队/${draw.lastMs.toFixed(1)}ms/峰值${draw.maxMs.toFixed(1)}ms`;
    imageryValue.textContent += ` · 近1s制图${draw.recentCount}张/${draw.recentMs.toFixed(1)}ms`;
    imageryValue.textContent += ` · ${draw.worker ? 'Worker' : '兼容主线程'}构建${draw.building}队列/${draw.buildMs.toFixed(1)}ms` +
      ` · 分批${draw.recentSteps}步/上传${(draw.uploadBytes / 1024).toFixed(0)}KiB`;
  }
  const baseSymbolStats = stats.vectorLayers.get('native-base-symbols');
  if (baseSymbolStats) imageryValue.textContent += ` · 底图点注记 ${baseSymbolStats.visibleLabels}/${baseSymbolStats.allocatedLabels}（显示/缓存）· placement ${baseSymbolStats.placementMs.toFixed(1)}ms`;
  const nativeMvt = [...stats.vectorLayers.entries()].find(([id]) => id !== 'native-base-symbols')?.[1];
  if (nativeMvt) {
    imageryValue.textContent +=
      ` ｜ 业务 MVT ${nativeMvt.sourceLevel}级 · ${nativeMvt.ready} 就绪 · ` +
      `${nativeMvt.loading} 加载 · ${nativeMvt.queued} 排队 · ${nativeMvt.visible} 显示 · ` +
      `${nativeMvt.visibleLabels}/${nativeMvt.allocatedLabels} 注记 · ${nativeMvt.errors} 失败`;
  }
  terrainValue.textContent = stats.terrain
    ? `地形 ${terrainEnabled ? '开启' : '关闭'} · ${stats.terrain.coverageReady ? '覆盖完成' : '粗层覆盖中'} · ${stats.terrain.ready} 就绪 · ${stats.terrain.loading} 加载 · ${stats.terrain.queued} 排队 · ${stats.terrain.pending} 待提交 · ${stats.terrain.committed} 提交/${stats.terrain.commitMs.toFixed(1)}ms · ${(stats.terrain.resourceBytes / 1024 / 1024).toFixed(0)} MiB · 原始DEM/地表接边 · ${stats.terrain.fallbacks} 回退 · ${stats.terrain.errors} 失败`
    : '地形未配置';
  const timing = stats.performance;
  if (stats.terrain) terrainValue.textContent += ` · 显示代次 ${stats.terrain.displayGeneration}` +
    `/${stats.terrain.displayed} 高程资源 · ${stats.terrain.waitingRegions} 区域待细化` +
    `/${stats.terrain.qualityLimitedRegions} 预算限精度 · ${stats.terrain.preparingPatches} 地表准备` +
    `/${stats.terrain.prepareMs.toFixed(1)}ms · ${stats.terrain.timeouts} 地形超时`;
  terrainValue.textContent += ` · CPU ms LOD ${timing.lodMs.toFixed(1)}/地形 ${timing.terrainMs.toFixed(1)}` +
    `/地表 ${timing.surfaceMs.toFixed(1)}/要素 ${timing.featureMs.toFixed(1)}/提交 ${timing.renderSubmitMs.toFixed(1)}` +
    ` · ${timing.drawCalls} draws/${(timing.triangles / 1000).toFixed(0)}k 三角形`;
  terrainValue.textContent += ` · GPU ${timing.gpuMs === null ? '不可用' : timing.gpuMs.toFixed(1) + 'ms'}` +
    ` · LOD重选${timing.lodSelections}次`;
};

const geovisTerrainUrl = environmentValue(import.meta.env.VITE_GEOVIS_TERRAIN_URL) ??
  geovisTerrainUrlFromToken(environmentValue(localTokens.geovis?.terrainToken));
const mapTilerKey = environmentValue(import.meta.env.VITE_MAPTILER_KEY) ??
  environmentValue(localTokens.maptiler?.key);
const terrain = !entitySmoke && terrainEnabledByConfig && (geovisTerrainUrl || mapTilerKey)
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
    maxTiles: 350,
    minimumHorizonDetailFactor: 0.08,
    horizonDetailExponent: 0.5,
    maximumSurfaceDisplacement: terrain ? 12_000 * numericEnvironmentValue(
      import.meta.env.VITE_TERRAIN_EXAGGERATION,
      1
    ) : 0
  },
  grid: { subdivisions: 8, heightOffset: 0.3 },
  imagery: entitySmoke ? false : baseProvider,
  terrain,
  terrainLayer: {
    regionalCoverage: new URLSearchParams(window.location.search).get('terrainCoverage') === 'regional',
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
    longitude: queryNumber('longitude', 105, -180, 180),
    latitude: queryNumber('latitude', 32, -85, 85),
    altitude: queryNumber('altitude', 8_600_000, 100, 100_000_000)
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
  onStats: renderStats,
  onFramePerformance: new URLSearchParams(window.location.search).get('performanceAudit') === '1'
    ? (timing) => {
      if (!auditWindow.__motionSampling && !auditWindow.__coldSampling) return;
      const samples = auditWindow.__motionSampling ? auditWindow.__terrainFrameAudit ??= [] : auditWindow.__coldFrameAudit ??= [];
      if (samples.length >= 1000) samples.shift();
      samples.push(timing);
    } : undefined
});

applyActiveLayerUi();
if (!entitySmoke && activeBaseLayer.kind === 'vector') {
  try {
    nativeBase = await createNativeBase(activeBaseLayer);
    nativeSymbols = await createNativeSymbols(activeBaseLayer, nativeBase);
    baseProvider = nativeBase;
    engine.setImageryProvider(nativeBase);
    if (nativeSymbols) engine.addVectorLayer('native-base-symbols', nativeSymbols);
  } catch (error) {
    const failedLayer = activeBaseLayer;
    nativeSymbols?.dispose(); nativeSymbols = null;
    nativeBase?.dispose(); nativeBase = null;
    layers.setRuntime(failedLayer.id, { phase: 'error', pending: 0, failed: 1,
      lastError: error instanceof Error ? error.message : String(error) });
    const fallback = baseLayers.find((layer) => layer.sourceId === 'google-satellite');
    if (!fallback) throw error;
    layers.setVisible(fallback.id, true);
    activeBaseLayer = layers.get(fallback.id)!;
    layers.setRuntime(activeBaseLayer.id, { phase: 'ready', pending: 0, ready: 1 });
    applyActiveLayerUi();
    console.error(`[图层 ${failedLayer.id}] 初始加载失败，保留影像底图`, error);
  }
}
engine.setTerrainEnabled(terrainEnabled);
engine.start();
const disposeEntityPlayground = attachEntityPlayground(engine);
if (new URLSearchParams(window.location.search).has('pitch')) {
  engine.flyTo({ longitude: queryNumber('longitude', 105, -180, 180),
    latitude: queryNumber('latitude', 32, -85, 85),
    altitude: queryNumber('altitude', 8_600_000, 100, 100_000_000),
    heading: queryNumber('heading', 0, 0, 360), pitch: queryNumber('pitch', -90, -90, -0.1), duration: 0 });
}
if (!entitySmoke) void enableQueryBusinessLayers();

let layerSwitchRevision = 0;
baseLayerSelect.addEventListener('change', async () => {
  const revision = ++layerSwitchRevision;
  const next = layers.get(baseLayerSelect.value);
  if (!next || next.role !== 'base') return;
  const availability = registry.availability(next.sourceId);
  if (!availability.available) {
    baseLayerSelect.value = activeBaseLayer.id;
    return;
  }
  const previous = activeBaseLayer;
  layers.setRuntime(next.id, { phase: 'loading', pending: 1, failed: 0, lastError: null });
  let provider: RasterTileProvider = baseProvider;
  let nextNative: GpuVectorTileProvider | null = null;
  let nextSymbols: MvtVectorLayer | null = null;
  try {
    if (next.kind === 'vector') {
      nextNative = await createNativeBase(next);
      provider = nextNative;
      nextSymbols = await createNativeSymbols(next, nextNative);
    } else {
      provider = await registry.createRasterProviderAsync(next.sourceId, {
        levelOffset: next.levelOffset
      });
      await diagnoseMvtStyle(provider, `底图 ${next.id}`);
    }
  } catch (error) {
    nextSymbols?.dispose(); nextNative?.dispose();
    if (revision !== layerSwitchRevision) return;
    layers.setRuntime(next.id, {
      phase: 'error', pending: 0, failed: 1,
      lastError: error instanceof Error ? error.message : String(error)
    });
    baseLayerSelect.value = previous.id;
    console.error(`[图层 ${next.id}] 加载失败`, error);
    return;
  }
  if (revision !== layerSwitchRevision) { nextSymbols?.dispose(); nextNative?.dispose(); return; }
  engine.removeVectorLayer('native-base-symbols');
  nativeSymbols = nextSymbols;
  if (nativeSymbols) engine.addVectorLayer('native-base-symbols', nativeSymbols);
  const previousNative = nativeBase;
  nativeBase = nextNative;
  layers.setVisible(next.id, true);
  activeBaseLayer = layers.get(next.id)!;
  baseProvider = provider;
  engine.setImageryProvider(baseProvider);
  previousNative?.dispose();
  layers.setRuntime(next.id, { phase: 'ready', pending: 0, ready: 1, failed: 0 });
  annotationToggle.checked = false;
  removeAnnotationLayer();
  applyActiveLayerUi();
  updateQueryState();
});

levelOffsetInput.addEventListener('input', () => {
  const offset = Number(levelOffsetInput.value);
  if (!Number.isFinite(offset)) return;
  activeBaseLayer = layers.setLevelOffset(activeBaseLayer.id, offset);
  nativeBase?.setViewLevelOffset(offset);
  nativeSymbols?.setViewLevelOffset(offset);
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
    // System basemap labels are always composed above business overlays.
    order: 10_000,
    surfaceOffset: 0.1,
    maxCachedTiles: 1_024,
    maxTextureBytes: 96 * 1024 * 1024
  });
  annotationLayerId = candidate.id;
  layers.setVisible(candidate.id, true);
});

businessLayerControl.addEventListener('click', () => {
  const open = businessLayerPanel.hidden;
  businessLayerPanel.hidden = !open;
  businessLayerControl.setAttribute('aria-expanded', String(open));
});

businessLayerTest.addEventListener('click', async () => {
  const layer = layers.get('business-yongyuan-static');
  if (!layer) return;
  const checkbox = businessLayerList.querySelector<HTMLInputElement>(
    `[data-layer-toggle="${layer.id}"]`
  );
  if (checkbox && !checkbox.checked) {
    checkbox.checked = true;
    try {
      await setBusinessLayerEnabled(layer.id, true);
    } catch {
      checkbox.checked = false;
      return;
    }
  }
  businessLayerPanel.hidden = false;
  businessLayerControl.setAttribute('aria-expanded', 'true');
  engine.flyTo({
    longitude: 107.295381,
    latitude: 30.240534,
    altitude: 1_800,
    heading: 0,
    pitch: -90,
    duration: 1_500
  });
});

geoJsonTest.addEventListener('click', async () => {
  const layer = layers.get('geojson-china-provinces');
  if (!layer) return;
  const checkbox = businessLayerList.querySelector<HTMLInputElement>(
    `[data-layer-toggle="${layer.id}"]`
  );
  if (checkbox && !checkbox.checked) {
    checkbox.checked = true;
    try {
      await setBusinessLayerEnabled(layer.id, true);
    } catch {
      checkbox.checked = false;
      return;
    }
  }
  businessLayerPanel.hidden = false;
  businessLayerControl.setAttribute('aria-expanded', 'true');
  engine.flyTo({
    longitude: 104,
    latitude: 35,
    altitude: 5_500_000,
    heading: 0,
    pitch: -90,
    duration: 1_500
  });
});

window.addEventListener('pagehide', () => {
  cancelAnimationFrame(fpsAnimationFrame);
  disposeEntityPlayground();
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
      ? source.kind === 'mvt' ? '（缺少 MVT 样式）' : '（当前不支持）'
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

async function enableQueryBusinessLayers(): Promise<void> {
  const requested = new URLSearchParams(window.location.search).getAll('businessLayer');
  for (const layerId of requested) {
    const layer = layers.get(layerId);
    if (!layer || layer.role !== 'overlay') continue;
    const checkbox = businessLayerList.querySelector<HTMLInputElement>(
      `[data-layer-toggle="${layerId}"]`
    );
    try {
      await setBusinessLayerEnabled(layerId, true);
      if (checkbox) checkbox.checked = true;
    } catch {
      if (checkbox) checkbox.checked = false;
    }
  }
}

function populateBusinessLayerControls(candidates: readonly LayerState[]): void {
  businessLayerList.replaceChildren();
  for (const layer of candidates) {
    const source = registry.get(layer.sourceId);
    if (!source) continue;
    const availability = registry.availability(source.id);
    const renderSupported = layer.kind === 'imagery' || layer.kind === 'rasterized-vector' ||
      layer.kind === 'vector' ||
      (layer.kind === 'feature' && source.kind === 'geojson');
    const enabled = availability.available && renderSupported;
    const row = document.createElement('label');
    row.className = `business-layer-row${enabled ? '' : ' is-disabled'}`;
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = layer.visible;
    checkbox.disabled = !enabled;
    checkbox.dataset.layerToggle = layer.id;
    const identity = document.createElement('span');
    const name = document.createElement('span');
    name.className = 'business-layer-row__name';
    name.textContent = layer.name;
    const status = document.createElement('small');
    status.className = 'business-layer-row__state';
    status.dataset.layerStatus = layer.id;
    status.textContent = enabled ? '未加载' : availability.supported
      ? '当前渲染器不支持'
      : source.kind === 'mvt'
        ? '缺少 MVT 样式'
        : '当前数据源不支持';
    identity.append(name, status);
    const opacity = document.createElement('input');
    opacity.type = 'range';
    opacity.min = '0';
    opacity.max = '1';
    opacity.step = '0.05';
    opacity.value = String(layer.opacity);
    opacity.disabled = !enabled;
    opacity.setAttribute('aria-label', `${layer.name}透明度`);
    checkbox.addEventListener('change', () => {
      void setBusinessLayerEnabled(layer.id, checkbox.checked).catch(() => {
        checkbox.checked = false;
      });
    });
    opacity.addEventListener('input', () => {
      const value = Number(opacity.value);
      layers.setOpacity(layer.id, value);
      engine.getImageryLayer(businessEngineLayerId(layer.id))?.setOpacity(value);
      engine.getFeatureLayer(businessEngineLayerId(layer.id))?.setOpacity(value);
      engine.getVectorLayer(businessEngineLayerId(layer.id))?.setOpacity(value);
    });
    row.append(checkbox, identity, opacity);
    businessLayerList.appendChild(row);
  }
  updateBusinessLayerSummary();
}

async function setBusinessLayerEnabled(layerId: string, enabled: boolean): Promise<void> {
  const layer = layers.get(layerId);
  if (!layer || layer.role !== 'overlay') return;
  const revision = (businessLayerRevisions.get(layerId) ?? 0) + 1;
  businessLayerRevisions.set(layerId, revision);
  businessLayerControllers.get(layerId)?.abort();
  businessLayerControllers.delete(layerId);
  const engineLayerId = businessEngineLayerId(layer.id);
  if (!enabled) {
    engine.removeImageryLayer(engineLayerId);
    engine.removeFeatureLayer(engineLayerId);
    engine.removeVectorLayer(engineLayerId);
    layers.setVisible(layer.id, false);
    layers.setRuntime(layer.id, { phase: 'idle', pending: 0, ready: 0, failed: 0, lastError: null });
    updateBusinessLayerStatus(layer.id, 'idle', '未加载');
    updateBusinessLayerSummary();
    return;
  }
  if (
    engine.getImageryLayer(engineLayerId) ||
    engine.getFeatureLayer(engineLayerId) ||
    engine.getVectorLayer(engineLayerId)
  ) return;
  layers.setRuntime(layer.id, { phase: 'loading', pending: 1, failed: 0, lastError: null });
  updateBusinessLayerStatus(layer.id, 'loading', '加载配置…');
  try {
    const controller = new AbortController();
    businessLayerControllers.set(layerId, controller);
    const sourceDefinition = registry.get(layer.sourceId);
    if (layer.kind === 'vector' && sourceDefinition?.kind === 'mvt') {
      updateBusinessLayerStatus(layer.id, 'loading', '解析 MVT 样式…');
      const vectorLayer = registry.createMvtVectorLayer(layer.sourceId, engine.ellipsoid, {
        levelOffset: layer.levelOffset,
        opacity: layer.opacity,
        order: 300 + layer.order,
        terrain: engine.terrain ?? undefined,
        maxLabelsPerTile: 8,
        maxVisibleLabels: 32
      });
      await vectorLayer.initialize();
      if (businessLayerRevisions.get(layerId) !== revision) {
        vectorLayer.dispose();
        return;
      }
      engine.addVectorLayer(engineLayerId, vectorLayer);
      updateBusinessLayerStatus(layer.id, 'ready', '原生 MVT · GPU 点线面/三维标注');
    } else if (layer.kind === 'feature' && sourceDefinition?.kind === 'geojson') {
      updateBusinessLayerStatus(layer.id, 'loading', '解析 GeoJSON…');
      const collection = await registry.createGeoJsonSource(layer.sourceId).load(controller.signal);
      if (businessLayerRevisions.get(layerId) !== revision) return;
      const featureLayer = new GeoJsonLayer(engine.ellipsoid, collection, {
        color: geoJsonLayerColor(layer.id),
        opacity: layer.opacity,
        heightOffset: 3,
        terrain: engine.terrain ?? undefined,
        terrainSampleBudget: 4096,
        order: 200 + layer.order
      });
      engine.addFeatureLayer(engineLayerId, featureLayer);
      updateBusinessLayerStatus(layer.id, 'ready', `${collection.features.length} 个要素`);
    } else {
      const provider = await registry.createRasterProviderAsync(layer.sourceId, {
        levelOffset: layer.levelOffset
      });
      const capability = provider instanceof MvtRasterProvider
        ? await diagnoseMvtStyle(provider, `业务图层 ${layer.id}`)
        : null;
      if (businessLayerRevisions.get(layerId) !== revision) return;
      engine.addImageryLayer(engineLayerId, provider, {
        overlay: true,
        opacity: layer.opacity,
        order: 100 + layer.order,
        // All surface rasters share the base mesh/depth and differ only by
        // render order; physical metre offsets cause terrain-shaped holes.
        surfaceOffset: 0.1,
        contentKind: layer.kind === 'rasterized-vector' || layer.kind === 'vector'
          ? 'rasterized-vector'
          : 'imagery',
        maxCachedTiles: 1_024,
        maxTextureBytes: 128 * 1024 * 1024
      });
      if (capability) {
        const suffix = capability.unsupportedLayers > 0 || capability.degradedLayers > 0
          ? ` · ${capability.degradedLayers} 降级/${capability.unsupportedLayers} 不支持`
          : ' · 样式完整支持';
        updateBusinessLayerStatus(layer.id, 'ready', `MVT 已叠加${suffix}`);
      } else {
        updateBusinessLayerStatus(layer.id, 'ready', '已叠加');
      }
    }
    if (businessLayerRevisions.get(layerId) !== revision) return;
    layers.setVisible(layer.id, true);
    layers.setRuntime(layer.id, { phase: 'ready', pending: 0, ready: 1, failed: 0 });
  } catch (error) {
    if (businessLayerRevisions.get(layerId) !== revision) return;
    const message = error instanceof Error ? error.message : String(error);
    layers.setVisible(layer.id, false);
    layers.setRuntime(layer.id, { phase: 'error', pending: 0, failed: 1, lastError: message });
    updateBusinessLayerStatus(layer.id, 'error', message);
    console.error(`[业务图层 ${layer.id}] 加载失败`, error);
    throw error;
  } finally {
    if (businessLayerControllers.get(layerId)?.signal.aborted === false) {
      businessLayerControllers.delete(layerId);
    }
    updateBusinessLayerSummary();
  }
}

function updateBusinessLayerStatus(
  layerId: string,
  phase: 'idle' | 'loading' | 'ready' | 'error',
  message: string
): void {
  const element = businessLayerList.querySelector<HTMLElement>(`[data-layer-status="${layerId}"]`);
  if (!element) return;
  element.dataset.phase = phase;
  element.textContent = message;
}

function updateBusinessLayerSummary(): void {
  const enabled = businessLayers.filter((layer) => layers.get(layer.id)?.visible).length;
  businessLayerSummary.textContent = `${enabled} 个已启用`;
}

function businessEngineLayerId(layerId: string): string {
  return `business:${layerId}`;
}

function geoJsonLayerColor(layerId: string): number {
  if (layerId.includes('provinces')) return 0x32e6a1;
  if (layerId.includes('cities')) return 0x64d8ff;
  return 0xffc857;
}

async function diagnoseMvtStyle(provider: RasterTileProvider, label: string) {
  if (!(provider instanceof MvtRasterProvider)) return null;
  const capability = await provider.styleCapabilities();
  if (capability.issues.length > 0) {
    console.warn(`[${label}] MVT 样式能力诊断`, capability);
  }
  return capability;
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

async function createNativeBase(layer: LayerState): Promise<GpuVectorTileProvider> {
  const source = registry.get(layer.sourceId)!;
  const vector = new GpuVectorTileProvider({
    id: source.id,
    styleUrl: source.styleUrl,
    sourceId: source.sourceId,
    levelOffset: layer.levelOffset,
    renderer: engine.renderer,
    workBudget: engine.backgroundWorkBudget,
    minLevel: source.minLevel,
    maxLevel: source.maxLevel,
    source: {
      ...(source.urlTemplate ? { tiles: [source.urlTemplate] } : {}),
      ...(source.scheme ? { scheme: source.scheme } : {})
    }
  });
  try { await vector.initialize(); return vector; }
  catch (error) { vector.dispose(); throw error; }
}

async function createNativeSymbols(layer: LayerState, provider: GpuVectorTileProvider): Promise<MvtVectorLayer | null> {
  if (layer.sourceId !== 'esri-native-labels') return null;
  const source = registry.get(layer.sourceId)!;
  const symbols = new MvtVectorLayer(engine.ellipsoid, {
    id: 'native-base-symbols', styleUrl: source.styleUrl, sourceId: source.sourceId,
    role: 'base', symbols: true, symbolsOnly: true, maxLevel: provider.maxLevel,
    levelOffset: layer.levelOffset, terrain: engine.terrain ?? undefined, order: 10000,
    maxConcurrentRequests: 1, maxCachedTiles: 64, maxLabelsPerTile: 8, maxVisibleLabels: 64, maxAllocatedLabels: 256,
    decodedTileLoader: (id, signal) => provider.loadVectorTile(id, signal)
  });
  try { await symbols.initialize(); return symbols; }
  catch (error) { symbols.dispose(); throw error; }
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
