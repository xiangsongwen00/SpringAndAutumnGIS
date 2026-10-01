import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Ellipsoid, FrameWorkBudget, GlobeGridRenderer, GlobeLodSelector, RasterTileLayer, TerrainTileLayer,
  UrlTemplateRasterProvider, WebMercatorTilingScheme, terrainSurfaceEdges } from '../dist/spring-and-autumn-gis.es.js';

const budget = new FrameWorkBudget(4);
budget.beginFrame(100); budget.spend(3);
budget.beginFrame(100); assert.equal(budget.spentMs, 3, 'same RAF from another consumer must not reset shared budget');
budget.spend(2); assert.equal(budget.canStart, false);
budget.beginFrame(116); assert.equal(budget.canStart, true);

const scheme = new WebMercatorTilingScheme();
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
assert.deepEqual(requestedLevels, [8], 'ready coverage skips unnecessary middle DEM levels');
await new Promise(resolve => setImmediate(resolve)); direct.dispose();

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
gridSamples = 0;
grid.update([surfaceSelection[0]]);
assert.equal(gridSamples, 0, 'known coordinates survive selection changes');
revision++; grid.update(surfaceSelection);
assert.equal(gridSamples, 0, 'unrelated revision does not resample known grid heights');
gridKey = 'b'; revision++; grid.update([surfaceSelection[0]]);
assert.ok(gridSamples > 0, 'changed local height source must invalidate its coordinates');
grid.dispose();
console.log('Dynamic terrain checks passed (bounded publication, coverage continuity, local bounds, immutable edge caching).');
