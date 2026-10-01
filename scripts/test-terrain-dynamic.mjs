import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Ellipsoid, FrameWorkBudget, GlobeGridRenderer, GlobeLodSelector, RasterTileLayer, TerrainTileLayer,
  TerrainRgbProvider, UrlTemplateRasterProvider, WebMercatorTilingScheme, terrainSurfaceEdges } from '../dist/spring-and-autumn-gis.es.js';

const budget = new FrameWorkBudget(4);
budget.beginFrame(100); budget.spend(3);
budget.beginFrame(100); assert.equal(budget.spentMs, 3, 'same RAF from another consumer must not reset shared budget');
budget.spend(2); assert.equal(budget.canStart, false);
budget.beginFrame(116); assert.equal(budget.canStart, true);

const scheme = new WebMercatorTilingScheme();
// HTTP coverage/auth failures must not become successful zero-height DEMs.
const nativeFetch = globalThis.fetch;
try {
  for (const status of [401, 403, 404, 204]) {
    globalThis.fetch = async () => new Response(null, { status });
    const missing = new TerrainRgbProvider({ id: `missing-${status}`, urlTemplates: ['fixture://{z}/{x}/{y}'] });
    await assert.rejects(missing.loadTile({ level: 4, x: 4, y: 4 }));
  }
  globalThis.fetch = async () => new Response(null, { status: 404 });
  const explicit = new TerrainRgbProvider({ urlTemplates: ['fixture://{z}/{x}/{y}'], noDataHeight: 123 });
  const flat = await explicit.loadTile({ level: 4, x: 4, y: 4 });
  assert.ok(flat.heights.every(value => value === 123)); flat.texture.dispose();
  globalThis.fetch = async () => new Response(null, { status: 403 });
  await assert.rejects(new TerrainRgbProvider({ urlTemplates: ['fixture://{z}/{x}/{y}'], noDataHeight: 123 })
    .loadTile({ level: 4, x: 4, y: 4 }), /401\/403/);
} finally { globalThis.fetch = nativeFetch; }
const selected = (id) => ({ id, rectangle: scheme.rectangle(id), screenPixels: 128, viewCenterDistance: 0 });
let uploads = 0, disposedTextures = 0;
const terrain = new TerrainTileLayer(Ellipsoid.WGS84, { id: 'pending', minLevel: 4, maxLevel: 4,
  loadTile: async (id) => {
    const texture = new THREE.DataTexture(new Float32Array(9).fill(100), 3, 3, THREE.RedFormat, THREE.FloatType);
    texture.addEventListener('dispose', () => disposedTextures++);
    return { id, texture, heights: texture.image.data, width: 3, height: 3, minimumHeight: 100, maximumHeight: 100 };
  } }, { maxCommitsPerFrame: 2, prepareTexture: () => uploads++ });
const tiles = Array.from({ length: 6 }, (_, index) => selected({ level: 4, x: index + 4, y: 4 }));
terrain.update(tiles);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(terrain.stats.pending, 6);
assert.equal(terrain.stats.ready, 0);
assert.equal(terrain.revision, 0, 'async completion must not publish terrain between frames');
for (let frame = 1; frame <= 3; frame++) {
  terrain.update(tiles);
  assert.equal(terrain.stats.committed, 2);
  assert.equal(terrain.stats.ready, frame * 2);
  assert.equal(terrain.revision, frame, 'one batch generates only one revision');
}
assert.equal(uploads, 6);
assert.equal(terrain.stats.pending, 0);
const snapshot = terrain.tileHeightSampler({ level: 6, x: 16, y: 16 });
assert.equal(snapshot.sample(.25, .75), terrain.sampleTileHeight({ level: 6, x: 16, y: 16 }, .25, .75));
const knownBinding = terrain.resolveTexture(tiles[0].id).key;
const uncovered = selected({ level: 4, x: 12, y: 12 });
terrain.update([...tiles, uncovered]);
assert.equal(terrain.stats.coverageReady, false);
assert.equal(terrain.resolveTexture(tiles[0].id).key, knownBinding,
  'one newly exposed missing patch must not flatten the entire ready viewport');
await new Promise((resolve) => setImmediate(resolve));
assert.equal(terrain.stats.pending, 1);
terrain.setEnabled(false);
assert.equal(terrain.stats.pending, 0);
assert.equal(terrain.stats.loading, 0);
assert.equal(disposedTextures, 1, 'disabling terrain releases unpublished DEM');
terrain.setEnabled(true); terrain.update([...tiles, uncovered]);
await new Promise((resolve) => setImmediate(resolve)); terrain.update([...tiles, uncovered]);
assert.equal(terrain.stats.ready, 7, 're-enable must restart cancelled targets');
terrain.dispose();

// Upload byte quota and the shared RAF quota must postpone publication without
// dropping pending tiles. The first oversized task can still make progress.
const tinyBudget = new FrameWorkBudget(4);
tinyBudget.beginFrame(1); tinyBudget.spend(4);
const bounded = new TerrainTileLayer(Ellipsoid.WGS84, { id: 'bytes', minLevel: 4, maxLevel: 4,
  loadTile: async (id) => {
    const texture = new THREE.DataTexture(new Float32Array(9), 3, 3, THREE.RedFormat, THREE.FloatType);
    return { id, texture, heights: texture.image.data, width: 3, height: 3, minimumHeight: 0, maximumHeight: 0 };
  } }, { maxCommitsPerFrame: 6, maxUploadBytesPerFrame: 40, workBudget: tinyBudget });
bounded.update(tiles); await new Promise(resolve => setImmediate(resolve));
bounded.update(tiles); assert.equal(bounded.stats.ready, 0); assert.equal(bounded.stats.pending, 6);
tinyBudget.beginFrame(2); bounded.update(tiles);
assert.equal(bounded.stats.committed, 1, 'byte budget prevents a second 36-byte upload');
assert.equal(bounded.stats.pending, 5);
bounded.dispose();

// A known ancestor covers a new target without requesting all intermediate
// levels again. This optimizes requests, not the target's DEM detail level.
const requestedLevels = [];
const direct = new TerrainTileLayer(Ellipsoid.WGS84, { id: 'direct', minLevel: 4, maxLevel: 8,
  loadTile: async (id) => {
    requestedLevels.push(id.level);
    const texture = new THREE.DataTexture(new Float32Array(9), 3, 3, THREE.RedFormat, THREE.FloatType);
    return { id, texture, heights: texture.image.data, width: 3, height: 3, minimumHeight: 0, maximumHeight: 0 };
  } });
const parent = [tiles[0]];
direct.update(parent); await new Promise(resolve => setImmediate(resolve)); direct.update(parent);
requestedLevels.length = 0;
direct.update([selected({ level: 8, x: parent[0].id.x * 16, y: parent[0].id.y * 16 })]);
assert.deepEqual(requestedLevels, [8], 'default legacy path requests target directly with an existing ancestor');
await new Promise(resolve => setImmediate(resolve)); direct.dispose();

const missingChild = new TerrainTileLayer(Ellipsoid.WGS84, { id: 'missing-child', minLevel: 4, maxLevel: 5,
  loadTile: async () => { throw new Error('DEM unavailable'); } });
const backupId = { level: 4, x: 4, y: 4 }, backupTexture = demFixture(6000);
function demFixture(value) { return new THREE.DataTexture(new Float32Array(9).fill(value), 3, 3, THREE.RedFormat, THREE.FloatType); }
missingChild.records.set('4/4/4', { id: backupId, key: '4/4/4', state: 'ready', lastUsedFrame: 0, active: false,
  data: { id: backupId, texture: backupTexture, heights: backupTexture.image.data,
    width: 3, height: 3, minimumHeight: 6000, maximumHeight: 6000 } });
missingChild.coverageReady = true; missingChild.hasInitialCoverage = true;
const childSelection = [selected({ level: 5, x: 8, y: 8 })];
missingChild.update(childSelection); await new Promise(resolve => setImmediate(resolve)); missingChild.update(childSelection);
assert.equal(missingChild.stats.errors, 1);
assert.equal(missingChild.resolveTexture(childSelection[0].id).texture, backupTexture);
assert.equal(missingChild.sampleTileHeight(childSelection[0].id, .5, .5), 6000,
  'missing/error child preserves the actual ancestor rather than publishing a flat tile');
missingChild.dispose();

// Cached bounds are validated by local height envelopes, not global revision.
const camera = new THREE.PerspectiveCamera(50, 1.6, .02, 100000000);
camera.position.copy(Ellipsoid.WGS84.cartographicToCartesian({ longitude: 106.49, latitude: 29.63, height: 12000 }));
camera.lookAt(Ellipsoid.WGS84.cartographicToCartesian({ longitude: 106.49, latitude: 29.63 }));
let changedKey;
const source = { revision: 0, heightRange: (id) => ({ minimumHeight: 0,
  maximumHeight: `${id.level}/${id.x}/${id.y}` === changedKey ? 8000 : 2000 }) };
const selector = new GlobeLodSelector({ tilingScheme: scheme, maxTiles: 350, maximumSurfaceDisplacement: 12000 });
selector.setSurfaceDisplacementSource(source);
selector.select(camera, 800);
const initial = new Map(selector.boundsCache);
source.revision++;
selector.select(camera, 800);
for (const [key, value] of initial) assert.equal(selector.boundsCache.get(key), value,
  'unrelated revision must preserve all valid world bounds');
camera.position.addScalar(.001);
selector.select(camera, 800);
for (const [key, value] of initial) assert.equal(selector.boundsCache.get(key), value,
  'camera motion must preserve unchanged terrain world bounds');
changedKey = initial.keys().next().value;
source.revision++; selector.select(camera, 800);
assert.equal(selector.boundsCache.get(changedKey).maximumHeight, 8000);
assert.notEqual(selector.boundsCache.get(changedKey), initial.get(changedKey));
for (const [key, value] of initial) if (key !== changedKey) assert.equal(selector.boundsCache.get(key), value,
  'expanded local height envelope must not invalidate other world bounds');

// Cross-frame canonical points avoid repeated height sampling. Coarse/fine
// topology still picks authority each frame; only exact immutable samples cache.
let sampled = 0;
const cache = new Map();
const surfaceTiles = [
  { id: { level: 8, x: 100, y: 100 }, segments: 16, heightKey: 'a', height: () => { sampled++; return 500; } },
  { id: { level: 8, x: 101, y: 100 }, segments: 16, heightKey: 'a', height: () => { sampled++; return 700; } }
];
const edges = terrainSurfaceEdges(surfaceTiles, .1, cache);
assert.ok(sampled > 0); sampled = 0;
terrainSurfaceEdges(surfaceTiles, .1, cache);
assert.equal(sampled, 0, 'unchanged canonical samples must reuse immutable boundary points');
surfaceTiles[1].heightKey = 'b';
terrainSurfaceEdges(surfaceTiles, .1, cache);
assert.ok(sampled > 0);
// Reuse under changed authority/topology must equal a fresh calculation.
const fine = { id: { level: 9, x: 202, y: 200 }, segments: 16, heightKey: 'fine', height: () => 900 };
const mixed = [surfaceTiles[0], fine];
const retained = terrainSurfaceEdges(mixed, .1, cache);
const fresh = terrainSurfaceEdges(mixed, .1);
for (const tile of mixed) for (const [index, point] of fresh.get(tile)) {
  assert.ok(point.distanceTo(retained.get(tile).get(index)) < 1e-8,
    'cached boundaries must honor new coarse/fine authority');
}
for (let step = 0; step <= 16; step++) assert.ok(edges.get(surfaceTiles[0]).get(step * 17 + 16)
  .distanceTo(edges.get(surfaceTiles[1]).get(step * 17)) < 1e-8);

// With a stable binding an unrelated terrain revision must not upload edges.
const imagery = new UrlTemplateRasterProvider({ id: 'edges', urlTemplate: 'fixture://{z}/{x}/{y}' });
imagery.loadTexture = async () => new THREE.Texture({ width: 1, height: 1 });
let revision = 1;
const fakeTerrain = { get revision() { return revision; }, enabled: true, exaggeration: 1,
  resolveTexture: () => undefined, sampleHeight: () => 0,
  tileHeightSampler: () => ({ key: 'stable', sample: () => 0 }) };
const surface = new RasterTileLayer(Ellipsoid.WGS84, imagery, { terrain: fakeTerrain });
const surfaceSelection = surfaceTiles.map(({ id }) => selected(id));
surface.update(surfaceSelection);
const mask = surface.object3d.children[0].geometry.getAttribute('terrainEdgeMask');
const version = mask.version;
revision++; surface.update(surfaceSelection);
assert.equal(mask.version, version);
surface.dispose();

// Reloading a DEM under the same coordinate key must replace the GPU binding
// as well as the CPU perimeter. Otherwise high new edges surround an old flat
// interior, producing a persistent blade/cliff despite a fully loaded queue.
const demTexture = height => new THREE.DataTexture(new Float32Array(9).fill(height), 3, 3, THREE.RedFormat, THREE.FloatType);
let currentDem = demTexture(0), parentDem = demTexture(0), height = 0;
const reloadTerrain = { get revision() { return revision; }, enabled: true, exaggeration: 1,
  resolveTexture: () => ({ key: '8/100/100', texture: currentDem, sourceLevel: 8,
    scale: 1, offsetX: 0, offsetY: 0, width: 3, height: 3,
    parentKey: '7/50/50', parentTexture: parentDem, parentScale: .5, parentOffsetX: 0, parentOffsetY: 0 }),
  tileHeightSampler: () => ({ key: currentDem.uuid, sample: () => height }), sampleHeight: () => height };
const reloadSurface = new RasterTileLayer(Ellipsoid.WGS84, imagery, { terrain: reloadTerrain });
reloadSurface.update(surfaceSelection.slice(0, 1));
const reloadMesh = reloadSurface.object3d.children[0], originalDem = currentDem;
currentDem = demTexture(8000); height = 8000; revision++;
originalDem.dispose(); reloadSurface.update(surfaceSelection.slice(0, 1));
assert.equal(reloadMesh.material.uniforms.terrainTexture.value, currentDem,
  'same coordinate/new DEM texture must update the GPU interior');
const oldParent = parentDem; parentDem = demTexture(7000); oldParent.dispose(); revision++;
reloadSurface.update(surfaceSelection.slice(0, 1));
assert.equal(reloadMesh.material.uniforms.terrainParentTexture.value, parentDem,
  'same coordinate/new parent texture must update too');
const u = reloadMesh.geometry.getAttribute('terrainEdgeHigh'), l = reloadMesh.geometry.getAttribute('terrainEdgeLow');
const world = new THREE.Vector3(u.getX(0) + l.getX(0), u.getY(0) + l.getY(0), u.getZ(0) + l.getZ(0));
const reloadRectangle = surfaceSelection[0].rectangle;
const expectedWorld = Ellipsoid.WGS84.cartographicToCartesian({ longitude: reloadRectangle.west,
  latitude: reloadRectangle.north, height: 8000.1 });
assert.ok(world.distanceTo(expectedWorld) < .01, 'CPU perimeter uses the same new 8000m DEM as the GPU interior');
reloadSurface.dispose(); currentDem.dispose(); parentDem.dispose();

// Debug grid must reuse height/world points across topology changes and only
// resample coordinates whose immutable terrain source changed.
let gridSamples = 0, gridKey = 'a';
const gridTerrain = { ...fakeTerrain, get revision() { return revision; },
  heightVersionAt: () => gridKey, sampleHeight: () => { gridSamples++; return 100; } };
const grid = new GlobeGridRenderer(Ellipsoid.WGS84, { terrain: gridTerrain });
grid.update([surfaceSelection[0]]);
assert.ok(gridSamples > 0);
gridSamples = 0;
grid.update(surfaceSelection);
assert.ok(gridSamples > 0, 'new coordinates need initial samples');
const initialChunks = new Map(grid.tileChunks);
const expectedGrid = new GlobeGridRenderer(Ellipsoid.WGS84, { terrain: gridTerrain });
expectedGrid.update(surfaceSelection);
for (const name of ['position', 'color', 'sag_originHigh', 'sag_originLow']) {
  const count = grid.object3d.geometry.drawRange.count * 3;
  assert.deepEqual(grid.object3d.geometry.getAttribute(name).array.slice(0, count),
    expectedGrid.object3d.geometry.getAttribute(name).array.slice(0, count), 'cached grid equals fresh geometry');
}
expectedGrid.dispose();
gridSamples = 0;
grid.update([surfaceSelection[0]]);
assert.equal(gridSamples, 0, 'known coordinates survive selection changes');
revision++; grid.update(surfaceSelection);
assert.equal(gridSamples, 0, 'unrelated revision does not resample known grid heights');
for (const [key, chunk] of initialChunks) assert.equal(grid.tileChunks.get(key), chunk,
  'unchanged tile chunks survive selection and unrelated DEM updates');
gridKey = 'b'; revision++; grid.update([surfaceSelection[0]]);
assert.ok(gridSamples > 0, 'changed local height source must invalidate its coordinates');
grid.dispose();
assert.equal(grid.tileChunks.size, 0); assert.equal(grid.chunkBytes, 0);

// Indexed inclusive endpoints, mixed subdivisions, order independence and the
// antimeridian must retain the canonical coarse ECEF chord.
const indexedTiles = [
  { id: { level: 2, x: 3, y: 1 }, segments: 8, height: () => 100 },
  { id: { level: 3, x: 0, y: 2 }, segments: 16, height: () => 400 },
  { id: { level: 3, x: 0, y: 3 }, segments: 8, height: () => 800 },
  { id: { level: 4, x: 1, y: 4 }, segments: 16, height: () => 1200 }
];
const indexed = terrainSurfaceEdges(indexedTiles);
for (const ordering of [indexedTiles.toReversed(), [indexedTiles[2], indexedTiles[0], indexedTiles[3], indexedTiles[1]]]) {
  const reordered = terrainSurfaceEdges(ordering);
  for (const tile of indexedTiles) for (const [index, point] of indexed.get(tile))
    assert.ok(point.distanceTo(reordered.get(tile).get(index)) < 1e-8);
}
for (const tile of indexedTiles.slice(1, 3)) for (let step = 0; step <= tile.segments; step++) {
  const coarse = indexedTiles[0], y = (tile.id.y + step / tile.segments) / 2 ** tile.id.level;
  const sample = (y * 2 ** coarse.id.level - coarse.id.y) * coarse.segments;
  const lower = Math.min(coarse.segments, Math.floor(sample));
  const a = indexed.get(coarse).get(lower * (coarse.segments + 1) + coarse.segments);
  const b = indexed.get(coarse).get(Math.min(coarse.segments, lower + 1) * (coarse.segments + 1) + coarse.segments);
  assert.ok(indexed.get(tile).get(step * (tile.segments + 1)).distanceTo(a.clone().lerp(b, sample - lower)) < 1e-7,
    'indexed fine edge follows the canonical coarse chord across the dateline');
}
console.log('Dynamic terrain checks passed (bounded publication, coverage continuity, local bounds, immutable edge caching).');
