// This project only imports the installed package, never the engine source tree.
import { Viewer, ViewerError, GeoJsonLayer, Ellipsoid, type MapStyle, type TerrainProvider } from 'spring-and-autumn-gis';
import * as THREE from 'three';

const result = document.getElementById('result')!;
result.dataset.status = 'running';
result.textContent = 'RUNNING: 正在检查安装包初始化、底图切换、Worker 与销毁，请等待 PASS / FAIL。';
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(test: () => boolean) {
  for (let i = 0; i < 200; i++) { if (test()) return; await sleep(20); }
  throw new Error('Fixture did not become ready.');
}
const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32;
const context = canvas.getContext('2d')!; context.fillStyle = '#2384aa'; context.fillRect(0, 0, 32, 32);
const tiles = { id: 'fixture', minLevel: 0, maxLevel: 4, url: () => canvas.toDataURL(),
  loadTexture: async () => new THREE.CanvasTexture(canvas) };
let demRequests = 0;
let frameCallbacks = 0;
const terrain: TerrainProvider = { id: 'terrain-fixture', minLevel: 0, maxLevel: 4,
  async loadTile(id) {
    demRequests++;
    const heights = new Float32Array(9).fill(10);
    const texture = new THREE.DataTexture(heights, 3, 3, THREE.RedFormat, THREE.FloatType); texture.needsUpdate = true;
    return { id, heights, texture, width: 3, height: 3, minimumHeight: 10, maximumHeight: 10 };
  } };
// Tiny, valid polygon MVT: layer land, one rectangle, extent=4096.
const varint = (n: number): number[] => { const bytes = []; while (n > 127) { bytes.push((n & 127) | 128); n >>>= 7; } bytes.push(n); return bytes; };
const field = (tag: number, data: number[]) => [tag, ...varint(data.length), ...data];
const geom = [9, 0, 0, 26, ...varint(8192), 0, 0, ...varint(8192), ...varint(8191), 0, 15];
const feature = [24, 3, ...field(34, geom)];
const layer = [...field(10, [...new TextEncoder().encode('land')]), ...field(18, feature), 40, ...varint(4096), 120, 2];
const pbf = new Uint8Array(field(26, layer));
const style: MapStyle = { version: 8, sources: { fixture: { type: 'vector', tiles: ['/fixture/{z}/{x}/{y}.pbf'], maxzoom: 4 } },
  layers: [{ id: 'land', type: 'fill', source: 'fixture', 'source-layer': 'land', paint: { 'fill-color': '#228866' } }] };
const tileFetch: typeof fetch = async () => new Response(pbf.slice().buffer);
let slowResolve: ((response: Response) => void) | undefined;
const slowFetch: typeof fetch = () => new Promise(resolve => { slowResolve = resolve; });
const failFetch: typeof fetch = async () => { throw new Error('secret URL must not enter public error'); };
async function run() {
let viewer: Viewer | undefined;
try {
  for (const options of [{ basemaps: [{ id: 'a', type: 'provider' as const, provider: tiles }], baseMap: 'missing' },
    { basemaps: [{ id: 'a', type: 'provider' as const, provider: tiles }, { id: 'a', type: 'provider' as const, provider: tiles }] }]) {
    const error = await Viewer.create('map', options).then(() => null, error => error);
    check(error instanceof ViewerError && error.code === 'INVALID_OPTIONS', 'invalid configuration must fail before allocating a canvas');
  }
  check(document.querySelectorAll('#map canvas').length === 0, 'invalid options leaked canvas');
  viewer = await Viewer.create('map', { baseMap: null, terrain: { provider: terrain, enabled: false },
    showLodGrid: false, pixelRatio: 1, onFramePerformance: () => frameCallbacks++,
    lod: { minLevel: 0, maxLevel: 4, maxTiles: 32 }, basemaps: [
      { id: 'raster', type: 'provider', provider: tiles },
      { id: 'tms', type: 'xyz', url: '/fixture/{z}/{x}/{y}.png', scheme: 'tms' },
      { id: 'negative-y', type: 'xyz', url: '/fixture/{z}/{x}/{-y}.png', scheme: 'tms' },
      { id: 'vector', type: 'vector-style', style, fetcher: tileFetch },
      { id: 'slow', type: 'vector-style', style: '/fixture/slow.json', fetcher: slowFetch },
      { id: 'failed', type: 'vector-style', style: '/fixture/failed.json', fetcher: failFetch }
    ] });
  const v = viewer;
  let gridUpdates = 0;
  const originalGridUpdate = v.engine.grid.update.bind(v.engine.grid);
  v.engine.grid.update = (...args) => { gridUpdates++; return originalGridUpdate(...args); };
  await sleep(100);
  check(!v.terrainEnabled && demRequests === 0, 'disabled initial terrain requested DEM');
  check(!v.lodGridVisible && gridUpdates === 0, 'hidden grid still performed work');
  const business = new GeoJsonLayer(Ellipsoid.WGS84, { type: 'FeatureCollection', features: [] });
  v.engine.addFeatureLayer('business', business);
  v.stop();
  await v.setBaseMap('tms');
  check(v.engine.imagery!.provider.url({ level: 2, x: 1, y: 0 }) === '/fixture/2/1/3.png', 'TMS row mapping failed');
  await v.setBaseMap('negative-y');
  check(v.engine.imagery!.provider.url({ level: 2, x: 1, y: 0 }) === '/fixture/2/1/3.png', 'explicit -y was inverted twice');
  await v.setBaseMap('raster'); v.start();
  await until(() => (v.engine.imagery?.stats.ready ?? 0) > 0);
  const failure = await v.setBaseMap('failed').then(() => null, error => error);
  check(failure instanceof ViewerError && failure.code === 'BASEMAP_LOAD_FAILED' && !failure.message.includes('secret'), 'safe public error required');
  check(v.baseMap.id === 'raster', 'configuration failure replaced current map');
  const slow = v.setBaseMap('slow').then(() => null, error => error);
  await sleep(10); await v.setBaseMap('raster');
  check((await slow)?.code === 'ABORTED', 'superseded switch must reject');
  slowResolve?.(new Response(JSON.stringify(style)));
  await sleep(30); check(v.baseMap.id === 'raster', 'late switch replaced latest map');
  await v.setBaseMap('vector');
  await until(() => (v.engine.imagery?.stats.ready ?? 0) > 0);
  const vector = v.engine.imagery!.provider as { drawStats?: { worker: boolean } };
  check(vector.drawStats?.worker, 'installed production package must use real vector Worker');
  check(v.baseMap.capabilities?.supportedLayers === 1, 'vector capability diagnostics missing');
  check(v.engine.getFeatureLayer('business') === business, 'base switch removed business layer');
  v.setTerrainEnabled(true); await until(() => demRequests > 0);
  v.setTerrainEnabled(false); v.setLodGridVisible(true); await until(() => gridUpdates > 0);
  v.setLodGridVisible(false); const count = gridUpdates; await sleep(50); check(count === gridUpdates, 'hidden grid kept updating');
  await v.setBaseMap(null); check(v.engine.imagery === null, 'clear base map failed');
  v.destroy(); v.destroy(); check(v.isDestroyed && document.querySelectorAll('#map canvas').length === 0, 'destroy leaked canvas');
  const callbacks = frameCallbacks; await sleep(50); check(callbacks === frameCallbacks, 'destroy left render RAF callbacks alive');
  check(await v.setBaseMap('raster').then(() => false, error => error.code === 'DESTROYED'), 'destroyed mutation accepted');
  const bare = await Viewer.create('map', { autoStart: false });
  let rejected = false; try { bare.setTerrainEnabled(true); } catch (error) { rejected = error instanceof ViewerError && error.code === 'TERRAIN_UNAVAILABLE'; }
  check(rejected, 'missing terrain provider silently enabled'); bare.destroy();
  const cancelledCreation = new AbortController();
  const creating = Viewer.create('map', { signal: cancelledCreation.signal,
    basemaps: [{ id: 'slow-init', type: 'vector-style', style: '/fixture/slow.json', fetcher: slowFetch }] })
    .then(() => null, error => error);
  await sleep(10); cancelledCreation.abort();
  check((await creating)?.code === 'ABORTED' && document.querySelectorAll('#map canvas').length === 0,
    'cancelled creation leaked resources');
  slowResolve?.(new Response(JSON.stringify(style)));
  const initialRaster = await Viewer.create('map', { autoStart: false,
    basemaps: [{ id: 'initial-raster', type: 'provider', provider: tiles }] });
  check(initialRaster.baseMap.id === 'initial-raster', 'omitted initial id must select first map'); initialRaster.destroy();
  result.textContent = 'PASS: installed ESM SDK initialization, switches, latest-wins/failure, XYZ/TMS, real Worker, terrain/grid and lifecycle';
  result.dataset.status = 'passed';
} catch (error) { result.textContent = `FAIL: ${error instanceof Error ? error.stack : error}`; result.dataset.status = 'failed'; }
finally {
  viewer?.destroy();

}
}
void run();
