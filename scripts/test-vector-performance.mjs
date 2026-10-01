import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Ellipsoid, GlobeCameraController, GlobeLodSelector, GpuVectorTileProvider,
  RasterTileLayer, UrlTemplateRasterProvider, WebMercatorTilingScheme } from '../dist/spring-and-autumn-gis.es.js';

const ellipsoid = Ellipsoid.WGS84;
const element = { style: {}, addEventListener() {}, removeEventListener() {}, clientHeight: 800 };
const camera = new THREE.PerspectiveCamera(50, 1.6, .02, 100000000);
const controller = new GlobeCameraController(camera, element);
controller.flyTo({ longitude: 106.49, latitude: 29.63, altitude: 100, pitch: -3, duration: 0 });
// Force a clamp discrepancy smaller than one micron. It must not alter pose.
controller.minDistance = camera.position.length() + 1e-8;
const initialPosition = camera.position.clone(), initialRotation = camera.quaternion.clone();
for (let tick = 0; tick < 1000; tick++) assert.equal(controller.update(), false);
assert.ok(camera.position.equals(initialPosition) && camera.quaternion.equals(initialRotation),
  'numeric radial clamp noise must not change a stationary camera pose');

const selector = new GlobeLodSelector({ minLevel: 2, maxLevel: 27, maxTiles: 350,
  targetPixels: 128, maximumSurfaceDisplacement: 0, tilingScheme: new WebMercatorTilingScheme() });
const baseline = selector.select(camera, 800);
assert.ok(baseline.tiles.length < 280, 'grazing flat view must retain budget headroom');
const nearest = [...selector.viewSurfaceSamples].sort((a, b) =>
  a.point.distanceTo(camera.position) - b.point.distanceTo(camera.position)).slice(0, 5);
for (const sample of nearest) {
  const leaf = baseline.tiles.find(({ rectangle: r }) => sample.longitude >= r.west && sample.longitude <= r.east &&
    sample.latitude >= r.south && sample.latitude <= r.north);
  assert.ok(leaf?.id.level >= 19, 'foreground must retain high-detail mesh LOD, not sacrifice it to horizon');
}
const cacheSize = selector.boundsCache.size;
camera.position.addScalar(.01);
selector.select(camera, 800);
assert.ok(selector.boundsCache.size >= cacheSize, 'flat world bounds must survive camera motion');
console.log(`Grazing foreground checks passed: ${baseline.tiles.length} leaves, near ground >= z19.`);
controller.dispose();

const vector = new GpuVectorTileProvider({ id: 'budget', renderer: {},
  style: { version: 8, sources: {}, layers: [] } });
assert.equal(vector.estimatedTextureBytes, Math.ceil(256 * 256 * 4 * 4 / 3));
assert.ok(vector.estimatedTextureBytes * 350 < 192 * 1024 * 1024,
  'default vector targets must fit the maximum visible leaf working set');
vector.dispose();

// Exercise an entire 350-leaf target queue without a GPU or external service.
const provider = new UrlTemplateRasterProvider({ id: 'targets', tileSize: 256,
  urlTemplate: 'fixture://{z}/{x}/{y}', viewLevelOffset: null, maxLevel: 8 });
provider.loadTexture = async () => new THREE.Texture({ width: 256, height: 256 });
const layer = new RasterTileLayer(ellipsoid, provider);
const scheme = new WebMercatorTilingScheme();
const selection = Array.from({ length: 350 }, (_, index) => {
  const id = { level: 8, x: 100 + index % 25, y: 100 + Math.floor(index / 25) };
  return { id, rectangle: scheme.rectangle(id), screenPixels: 128, viewCenterDistance: 0 };
});
layer.update(selection);
for (let tick = 0; tick < 100; tick++) {
  await new Promise((resolve) => setImmediate(resolve));
  layer.update(selection);
  if (!layer.stats.loading && !layer.stats.queued) break;
}
assert.ok(layer.stats.ready >= 350); // Coarse bridge coverage can remain cached.
assert.ok(selection.every(({ id }) => layer.textures.get(`${id.level}/${id.x}/${id.y}`)?.state === 'ready'),
  'every visible detail target must finish, not merely its coarse bridge');
assert.equal(layer.stats.queued, 0);
assert.equal(layer.stats.loading, 0);
assert.equal(layer.stats.fallbacks, 0, 'all requested target zooms must replace their ancestors');
assert.ok(layer.stats.textureBytes < 192 * 1024 * 1024);
const mesh = layer.object3d.children[0];
const edgeVersion = mesh.geometry.getAttribute('terrainEdgeMask').version;
layer.update(selection.map((tile) => ({ ...tile, screenPixels: 130 })));
assert.equal(mesh.geometry.getAttribute('terrainEdgeMask').version, edgeVersion,
  'same topology with a fresh selection array must not rebuild/upload boundaries');
layer.dispose();
console.log('Vector surface performance regressions passed (350-target cache, stable edge uploads, camera clamp).');
