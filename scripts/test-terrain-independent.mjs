import assert from 'node:assert/strict';
import * as THREE from 'three';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
import { TerrainLodSelector, TerrainTileLayer, Ellipsoid, WebMercatorTilingScheme, RasterTileLayer, UrlTemplateRasterProvider } from '../dist/spring-and-autumn-gis.es.js';

const sdk = new URL('../dist/spring-and-autumn-gis.es.js', import.meta.url).href;
const coverSource = (await readFile(new URL('../src/core/lod/SurfaceCover.ts', import.meta.url), 'utf8'))
  .replace(/import .*WebMercatorTilingScheme.*;/, `import { WebMercatorTilingScheme } from '${sdk}';`)
  .replace(/import .*tileKey.*;/, `import { tileKey } from '${sdk}';`);
const { code } = await transform(coverSource, { loader: 'ts', format: 'esm' });
const { refineSurfaceCover } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const key = t => `${t.level}/${t.x}/${t.y}`, scheme = new WebMercatorTilingScheme(), e = Ellipsoid.WGS84;
const selected = id => ({ id, rectangle: scheme.rectangle(id), screenPixels: 128, viewCenterDistance: 0 });
const idAt = (lon, lat, level) => ({ level, x: Math.floor((lon + 180) / 360 * 2 ** level),
  y: Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** level) });
const tick = () => new Promise(resolve => setImmediate(resolve));
function field(id, value = 4000, width = 257) {
  const heights = new Float32Array(width * width).fill(value);
  const texture = new THREE.DataTexture(heights, width, width, THREE.RedFormat, THREE.FloatType);
  return { id, width, height: width, heights, texture, minimumHeight: value, maximumHeight: value };
}
function pose(tilt, longitude = 103.43968, latitude = 32.04231) {
  const lon = longitude * Math.PI / 180, lat = latitude * Math.PI / 180, a = tilt * Math.PI / 180;
  const up = new THREE.Vector3(Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon));
  const north = new THREE.Vector3(-Math.sin(lat) * Math.sin(lon), Math.cos(lat), -Math.sin(lat) * Math.cos(lon));
  const camera = new THREE.PerspectiveCamera(50, 1.8, 1, 1e8);
  camera.position.copy(e.cartographicToCartesian({ longitude, latitude, height: 5000 }));
  camera.up.copy(north).multiplyScalar(Math.cos(a)).addScaledVector(up, Math.sin(a));
  camera.lookAt(camera.position.clone().add(north.clone().multiplyScalar(Math.sin(a)).addScaledVector(up, -Math.cos(a))));
  camera.updateMatrixWorld(); return camera;
}
const surface = { revision: 0, maximumHeight: () => 4002, sampleHeight: () => 4000,
  heightRange: () => ({ minimumHeight: 3998, maximumHeight: 4002 }),
  tileHeightSampler: () => ({ key: 'terrain', sample: () => 4000 }) };
const provider = { id: 'synthetic-independent', minLevel: 0, maxLevel: 14, loadTile: async id => field(id) };
const lod = new TerrainLodSelector(provider, surface);
let selectionTime = 100000;
for (const angle of [0, 45, 80, 87, 0]) {
  selectionTime += 1000;
  const camera = pose(angle), result = lod.select(camera, 926, selectionTime);
  assert.ok(result.tiles.length <= 96 && result.tiles.length > 0);
  const nearest = [...result.tiles].sort((a, b) => {
    const d = t => { const r = t.rectangle, lon = Math.max(r.west, Math.min(r.east, 103.43968)), lat = Math.max(r.south, Math.min(r.north, 32.04231));
      return camera.position.distanceTo(e.cartographicToCartesian({ longitude: lon, latitude: lat, height: 4000 })); };
    return d(a) - d(b);
  });
  assert.ok(nearest[0].id.level >= 12, `Foreground too coarse at ${angle}: ${nearest[0].id.level}`);
  assert.equal(lod.select(camera, 926, selectionTime + 200).tiles, result.tiles, 'Stationary terrain target IDs preserve queue identity');
  console.log(`Independent terrain tilt ${angle}: ${result.tiles.length} targets; nearest z${nearest[0].id.level}`);
}
// Delayed 257x257 DEM + repeated frames: the old per-pump preemption could
// restart requests; static view must drain with each target requested once.
const nativePerformance = globalThis.performance;
let now = 0, aborted = 0, completed = 0;
const requests = [], calls = [];
globalThis.performance = { now: () => now };
try {
  const delayed = new TerrainTileLayer(e, { ...provider, loadTile: (id, signal) => new Promise(resolve => {
    calls.push(key(id)); signal.addEventListener('abort', () => aborted++);
    requests.push({ id, signal, resolve, due: now + 1600, finished: false });
  }) }, { independentSelection: true, maxConcurrentRequests: 4, maxCommitsPerFrame: 2 });
  const near = idAt(103.43968, 32.04231, 14), far = idAt(108, 32.04, 8);
  const tiles = [selected(far), ...Array.from({ length: 18 }, (_, i) => selected({ ...near, x: near.x + i % 6, y: near.y + Math.floor(i / 6) }))];
  const camera = pose(80).position;
  for (let frame = 0; frame < 900; frame++) {
    now += 20;
    for (const request of requests) if (!request.finished && request.due <= now) {
      request.finished = true; if (!request.signal.aborted) { request.resolve(field(request.id)); completed++; }
    }
    await tick(); delayed.update(tiles, camera);
    if (delayed.stats.readyTargets === tiles.length && !delayed.stats.loading && !delayed.stats.queued) break;
  }
  assert.equal(delayed.stats.readyTargets, tiles.length, 'Near and far converge, not root-only 60 FPS');
  assert.equal(delayed.stats.queued, 0); assert.equal(delayed.stats.loading, 0);
  assert.equal(aborted, 0); assert.equal(delayed.stats.preemptedRequests, 0);
  assert.equal(new Set(calls).size, calls.length, 'Static targets do not restart');
  assert.equal(delayed.resolveTexture(near).sourceLevel, 14);
  assert.equal(calls[0], '0/0/0'); assert.equal(calls[1], key(near));
  console.log(`Slow DEM convergence: ${completed} completed, ${aborted} aborts, ${now}ms simulated, empty queue`);
  delayed.dispose();

  // Opt-in preemption must be bounded by movement, not time alone.
  let farSignal;
  const bounded = new TerrainTileLayer(e, { ...provider, loadTile: (id, signal) => {
    if (key(id) === key(far)) farSignal = signal;
    return new Promise(() => {});
  } }, { maxConcurrentRequests: 1, preemptFarDetail: true });
  const root = field({ level: 0, x: 0, y: 0 });
  bounded.records.set('0/0/0', { id: root.id, key: '0/0/0', data: root, state: 'ready', priority: 0, lastUsedFrame: 0, active: false, controller: null });
  bounded.hasInitialCoverage = bounded.coverageReady = true;
  const two = [selected(far), selected(near)];
  bounded.update(two, pose(80, 108).position); bounded.update(two, camera);
  assert.equal(farSignal.aborted, true); assert.equal(bounded.stats.preemptedRequests, 1);
  for (let i = 0; i < 30; i++) { now += 800; bounded.update(two, camera); }
  assert.equal(bounded.stats.preemptedRequests, 1, 'Static view cannot re-arm cancellation'); bounded.dispose();
} finally { globalThis.performance = nativePerformance; }

const missingCalls = [], missingRoot = new TerrainTileLayer(e, { ...provider, loadTile: async id => {
  missingCalls.push(id.level); if (id.level === 0 || id.level === 12) throw new Error('HTTP 404'); return field(id);
} }, { independentSelection: true, maxConcurrentRequests: 1 });
const local = [selected(idAt(103.43968, 32.04231, 14))];
for (let i = 0; i < 14; i++) { missingRoot.update(local, pose(0).position); await tick(); }
assert.deepEqual(missingCalls, [0, 12, 13, 14], 'Absent root is not repeatedly deleted and retried');
assert.equal(missingRoot.stats.readyTargets, 1); missingRoot.dispose();

const remapped = new TerrainTileLayer(e, { ...provider, loadTile: async id => field({ level: id.level - 2,
  x: Math.floor(id.x / 4), y: Math.floor(id.y / 4) }) }, { maxConcurrentRequests: 1 });
remapped.hasInitialCoverage = remapped.coverageReady = true;
const target = local[0].id;
remapped.queueTile(target, 0); remapped.pumpQueue(); await tick(); remapped.commitPending();
assert.equal(remapped.records.has(key(target)), false, 'Ancestor response must not inherit child coordinate key');
assert.equal(remapped.resolveTexture(target).sourceLevel, 12); assert.equal(remapped.resolveTexture(target).scale, .25);
remapped.dispose();

const constrained = new TerrainLodSelector(provider, surface);
assert.ok(constrained.select(pose(80), 926, 0, 12).tiles.length <= 12, 'Target admission respects resident DEM capacity');
assert.ok(constrained.select(pose(80), 926, 200, 4).tiles.length <= 4, 'Small memory capacity must not be clamped back up to eight targets');

// Fine ready DEM refines a coarse imagery mesh without increasing fetch zoom.
const coarse = idAt(103.43968, 32.04231, 8), fine = idAt(103.43968, 32.04231, 12);
const imageTargets = [selected(coarse)], terrainTargets = [selected(fine)];
const cover = refineSurfaceCover(imageTargets, terrainTargets, 64);
assert.ok(cover.some(t => key(t.id) === key(fine)));
assert.equal(cover.length, 13); // Four levels, three extra siblings at each split.
const area = cover.reduce((sum, t) => sum + 4 ** (coarse.level - t.id.level), 0);
assert.equal(area, 1, 'Nonoverlapping complete parent footprint');
assert.ok(refineSurfaceCover(imageTargets, terrainTargets, 8).length <= 8);
const loads = [], imageProvider = new UrlTemplateRasterProvider({ urlTemplate: 'fixture://{z}/{x}/{y}', maxLevel: 20, levelOffset: 0 });
imageProvider.loadTexture = async id => { loads.push(id.level); return new THREE.Texture({ width: 2, height: 2 }); };
const fineTerrain = new TerrainTileLayer(e, provider, { independentSelection: true });
for (const data of [field({ level: 0, x: 0, y: 0 }), field(fine, 6000)])
  fineTerrain.records.set(key(data.id), { id: data.id, key: key(data.id), data, state: 'ready', priority: 0,
    lastUsedFrame: 0, active: false, controller: null });
fineTerrain.update(terrainTargets, pose(0).position);
const raster = new RasterTileLayer(e, imageProvider, { terrain: fineTerrain });
for (let i = 0; i < 5; i++) { raster.update(imageTargets, undefined, cover); await tick(); }
assert.ok(loads.every(z => z <= 8), `Mesh-only refinement leaked image zoom: ${loads}`);
assert.equal(raster.renderTiles.size, 13); assert.equal(raster.stats.displayedMaximumLevel, 8);
const fineMesh = raster.renderTiles.get(key(fine));
assert.equal(fineMesh.mesh.material.uniforms.uvScale.value.x, 1 / 16);
assert.equal(fineMesh.mesh.material.uniforms.terrainUvScale.value.x, 1);
assert.equal(fineMesh.mesh.material.uniforms.terrainTexture.value, fineTerrain.resolveTexture(fine).texture);
assert.equal(fineTerrain.sampleTileHeight(fine, .5, .5), 6000, 'Fine mesh consumes fine DEM, not root coverage');
raster.dispose(); fineTerrain.dispose();
console.log('Independent geometric LOD, slow queue convergence, bounded motion-only cancellation and image/surface separation passed.');
