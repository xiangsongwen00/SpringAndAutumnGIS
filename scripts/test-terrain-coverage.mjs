import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Ellipsoid, TerrainTileLayer, WebMercatorTilingScheme, RasterTileLayer,
  UrlTemplateRasterProvider } from '../dist/spring-and-autumn-gis.es.js';

const scheme = new WebMercatorTilingScheme();
const key = id => `${id.level}/${id.x}/${id.y}`;
const selected = id => ({ id, rectangle: scheme.rectangle(id), screenPixels: 512, viewCenterDistance: 0 });
const tick = () => new Promise(resolve => setImmediate(resolve));
function data(id, value, width = 33) {
  const heights = new Float32Array(width * width).fill(value);
  const texture = new THREE.DataTexture(heights, width, width, THREE.RedFormat, THREE.FloatType);
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  return { id, heights, texture, width, height: width, minimumHeight: value, maximumHeight: value };
}
function controlled(minLevel = 2, maxLevel = 6, options = {}) {
  const requests = new Map(), raw = new Map();
  const layer = new TerrainTileLayer(Ellipsoid.WGS84, { id: 'controlled', minLevel, maxLevel,
    loadTile: (id, signal) => new Promise((resolve, reject) => {
      requests.set(key(id), { id, resolve: value => {
        const field = data(id, value); raw.set(key(id), field); resolve(field);
      }, reject });
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }) }, { regionalCoverage: true, maxCommitsPerFrame: 1, ...options });
  return { layer, requests, raw };
}
async function frames(layer, selection, count = 12) {
  for (let i = 0; i < count; i++) { layer.update(selection); await tick(); }
}
// Hold the clock-independent response gates for as long as necessary. None
// of the delay checkpoints is allowed to expose a lone high child/zero plane.
const { layer, requests, raw } = controlled();
const ids = [
  { level: 6, x: 16, y: 16 }, { level: 6, x: 17, y: 16 },
  { level: 6, x: 16, y: 17 }, { level: 6, x: 17, y: 17 }
];
const selection = ids.map(selected);
layer.update(selection);
assert.ok(requests.has('2/1/1'), 'minimum-level trustworthy coverage requested first');
requests.get('2/1/1').resolve(6000); await tick();
await frames(layer, selection);
assert.equal(layer.stats.coverageReady, true);
for (const id of ids) assert.equal(layer.sampleTileHeight(id, .5, .5), 6000);
requests.get('5/8/8').resolve(6000); await tick(); await frames(layer, selection);
const coarseTexture = layer.resolveTexture(ids[0]).texture;
requests.get(key(ids[2])).resolve(8000); await tick(); await frames(layer, selection);
for (const checkpoint of [1, 3, 6, 10, 20]) {
  await frames(layer, selection);
  for (const id of ids) {
    assert.equal(layer.resolveTexture(id).texture, coarseTexture, `no lone child at delay checkpoint ${checkpoint}`);
    assert.equal(layer.sampleTileHeight(id, .5, .5), 6000);
  }
}
requests.get(key(ids[0])).resolve(8000); requests.get(key(ids[3])).resolve(8000);
await tick(); await frames(layer, selection);
assert.equal(layer.resolveTexture(ids[0]).texture, coarseTexture, 'last missing child still holds the region');
requests.get(key(ids[1])).resolve(8000); await tick();
const beforeGeneration = layer.stats.displayGeneration;
let switched = false;
for (let i = 0; i < 40; i++) {
  // Equivalent selection arrays must not cancel cross-frame preparation.
  layer.update(selection.map(tile => ({ ...tile })));
  const levels = ids.map(id => layer.resolveTexture(id).sourceLevel);
  assert.ok(levels.every(level => level === 5) || levels.every(level => level === 6),
    'all required regional children commit together, including preparation/edge dependencies');
  if (levels[0] === 6) { switched = true; break; }
  await tick();
}
assert.ok(switched, 'preparation must progress under a one-task frame quota');
assert.ok(layer.stats.displayGeneration > beforeGeneration);
for (const id of ids) {
  assert.equal(layer.sampleTileHeight(id, .5, .5), 8000);
  assert.ok(raw.get(key(id)).heights.every(value => value === 8000), 'raw DEM stays immutable');
  assert.equal(raw.get(key(id)).texture.image.data, raw.get(key(id)).heights,
    'prepared texture must own a separate THREE.Source, not overwrite the raw GPU upload image');
  const binding = layer.resolveTexture(id);
  const field = binding.texture.image.data;
  // Actual GPU texture, not an unrelated CPU-only edge override.
  assert.equal(field[16 * 33 + 16], layer.tileHeightSampler(id).sample(.5, .5));
}
assert.equal(layer.sampleTileHeight(ids[0], 0, .5), 6000, 'unresolved outer boundary is the prepared parent');
assert.equal(layer.sampleTileHeight(ids[0], 1, .5), layer.sampleTileHeight(ids[1], 0, .5),
  'same-generation interior source seam is shared');
const border = layer.resolveTexture(ids[0]).texture.image.data;
for (let x = 1; x <= 4; x++) assert.ok(Math.abs(border[16 * 33 + x] - border[16 * 33 + x - 1]) < 1000,
  'residual spread through a source-patch band rather than one vertical boundary row');

// Moving exposes a new target, but the minimum root still supplies true height.
const newId = { level: 6, x: 20, y: 16 };
await frames(layer, [...selection, selected(newId)]);
assert.equal(layer.sampleTileHeight(newId, .5, .5), 6000, 'new coverage never falls to zero');
assert.equal(layer.stats.coverageReady, true);

// Unknown next dataset root is unavailable, not an invented sea-level patch.
const absentId = { level: 6, x: 32, y: 16 };
const expanded = [...selection, selected(absentId)];
await frames(layer, expanded);
assert.equal(layer.hasSurfaceCoverage(absentId), false);
assert.equal(layer.sampleTileHeight(absentId, .5, .5), null);
const imagery = new UrlTemplateRasterProvider({ urlTemplate: 'fixture://{z}/{x}/{y}' });
imagery.loadTexture = async () => new THREE.Texture({ width: 1, height: 1 });
const raster = new RasterTileLayer(Ellipsoid.WGS84, imagery, { terrain: layer });
raster.update(expanded); await tick(); raster.update(expanded);
assert.equal(raster.renderTiles.get(key(absentId)).mesh.visible, false, 'do not draw fake flat missing coverage');
raster.dispose(); layer.dispose();

// An error child does not block other independent regions from committing.
const fault = controlled();
const other = { level: 6, x: 24, y: 16 };
const twoRegions = [selected(ids[0]), selected(other)];
fault.layer.update(twoRegions);
fault.requests.get('2/1/1').resolve(6000); await tick(); await frames(fault.layer, twoRegions);
fault.requests.get('5/8/8').resolve(6000); await tick(); await frames(fault.layer, twoRegions);
fault.requests.get(key(ids[0])).reject(new Error('HTTP 404')); await tick();
// Both regions share a minimum root, but have different boundary bases.
fault.requests.get('5/12/8').resolve(6000); await tick(); await frames(fault.layer, twoRegions);
fault.requests.get(key(other)).resolve(7000); await tick(); await frames(fault.layer, twoRegions, 40);
assert.equal(fault.layer.resolveTexture(ids[0]).sourceLevel, 5, 'failed child retains credible parent');
assert.equal(fault.layer.resolveTexture(other).sourceLevel, 6, 'unrelated region does not wait for failed child');
fault.layer.dispose();

// A small capacity must settle on explicit coarse quality, not queued + zero
// loading forever. Then a move releases old resources and new work proceeds.
const reserved = new TerrainTileLayer(Ellipsoid.WGS84, { id: 'reservation', minLevel: 0, maxLevel: 14,
  loadTile: () => new Promise(() => {}) }, { regionalCoverage: true });
const wide = Array.from({ length: 300 }, (_, i) => selected({ level: 14, x: 1000 + i % 30, y: 1000 + Math.floor(i / 30) }));
reserved.update(wide);
const reservedBytes = [...reserved.records.values()].reduce((sum, record) =>
  sum + reserved.estimatedTileBytes * (record.id.level === 0 ? 1 : 2), 0);
assert.ok(reservedBytes <= 96 * 1024 * 1024, 'admission reserves raw AND prepared bytes for earlier queued cohorts too');
reserved.dispose();
let loads = 0;
const pressure = new TerrainTileLayer(Ellipsoid.WGS84, { id: 'pressure', minLevel: 4, maxLevel: 5,
  loadTile: async id => { loads++; return data(id, 6000, 513); } }, { regionalCoverage: true, maxResourceBytes: 16 * 1024 * 1024 });
const many = Array.from({ length: 16 }, (_, i) => selected({ level: 5, x: 8 + i % 4, y: 8 + Math.floor(i / 4) }));
await frames(pressure, many, 80);
assert.equal(pressure.stats.coverageReady, true);
assert.ok(pressure.stats.qualityLimitedRegions > 0, 'capacity shortage is explicit, not an invisible stalled queue');
assert.equal(pressure.stats.queued, 0); assert.equal(pressure.stats.loading, 0);
assert.ok(pressure.stats.resourceBytes <= 16 * 1024 * 1024);
const previousLoads = loads;
await frames(pressure, [selected({ level: 5, x: 16, y: 16 })], 80);
assert.ok(loads > previousLoads, 'request room reclaimed before admission, not only after later material updates');
assert.equal(pressure.stats.coverageReady, true);
pressure.dispose();

// A hung fetch/decode must not own a scheduler slot forever. Even a provider
// ignoring cancellation cannot publish its late result into a newer generation.
let lateResolve, lateDisposed = 0;
const timeoutId = { level: 5, x: 8, y: 8 }, independentId = { level: 5, x: 10, y: 8 };
const timed = new TerrainTileLayer(Ellipsoid.WGS84, { id: 'timeout', minLevel: 4, maxLevel: 5,
  loadTile: id => key(id) === key(timeoutId) ? new Promise(resolve => { lateResolve = resolve; }) :
    Promise.resolve(data(id, id.level === 5 ? 7000 : 6000))
}, { regionalCoverage: true, maxConcurrentRequests: 1, requestTimeoutMs: 25 });
const timeoutSelection = [selected(timeoutId), selected(independentId)];
await frames(timed, timeoutSelection, 20);
await new Promise(resolve => setTimeout(resolve, 60));
await frames(timed, timeoutSelection, 30);
assert.equal(timed.stats.timeouts, 1);
assert.equal(timed.stats.loading, 0); assert.equal(timed.stats.queued, 0);
assert.equal(timed.resolveTexture(timeoutId).sourceLevel, 4, 'timeout retains the trusted parent');
assert.equal(timed.resolveTexture(independentId).sourceLevel, 5, 'timeout frees the slot for independent coverage');
const late = data(timeoutId, 10000);
late.texture.addEventListener('dispose', () => lateDisposed++);
lateResolve(late); await tick(); await frames(timed, timeoutSelection);
assert.equal(lateDisposed, 1, 'late ignored-abort result is released');
assert.equal(timed.resolveTexture(timeoutId).sourceLevel, 4, 'late result cannot publish a stale child');
timed.dispose();
console.log('Terrain coverage checks passed (root fallback, regional atomic publication, actual texture continuity, failures, capacity progress).');
