import assert from 'node:assert/strict';
import * as THREE from 'three';
import { RasterTileLayer, Ellipsoid, WebMercatorTilingScheme } from '../dist/spring-and-autumn-gis.es.js';

const scheme = new WebMercatorTilingScheme();
const parent = { level: 4, x: 8, y: 8 }, children = scheme.children(parent);
const selected = id => ({ id, rectangle: scheme.rectangle(id), screenPixels: 128, viewCenterDistance: 0 });
const key = id => `${id.level}/${id.x}/${id.y}`;
function fixture(options = {}, terrain) {
  const layer = new RasterTileLayer(Ellipsoid.WGS84, { id: 'continuity', minLevel: 0, maxLevel: 20,
    loadTexture: () => new Promise(() => {}) }, { maxTextureBytes: 16 * 1024 * 1024, terrain, ...options });
  layer.suspended = true;
  for (const id of [parent, ...children]) {
    layer.queueTexture(id, 0);
    Object.assign(layer.textures.get(key(id)), { state: 'ready', texture: new THREE.Texture(), byteSize: 1024 * 1024 });
  }
  layer.update(children.map(selected));
  return layer;
}
for (const terrain of [undefined, { enabled: true, revision: 1, exaggeration: 1, resolveTexture: () => undefined,
  sampleTileHeight: () => 6000, sampleHeight: () => 6000 }]) {
  const layer = fixture({}, terrain);
  const meshCount = layer.renderTiles.size;
  layer.update([selected(parent)]);
  const tile = layer.renderTiles.get(key(parent)), uniforms = tile.mesh.material.uniforms;
  assert.equal(layer.renderTiles.size, 1, 'retain content on the existing parent mesh, not duplicate ground');
  assert.equal(uniforms.coverageCount.value, 4);
  assert.equal(layer.stats.continuityPatches, 4);
  for (let i = 0; i < 4; i++) {
    assert.equal(uniforms[`coverageTexture${i}`].value, layer.textures.get(key(children[i])).texture);
    const rect = uniforms[`coverageRect${i}`].value, uv = uniforms[`coverageUv${i}`].value;
    const center = new THREE.Vector2(rect.x + rect.z / 2, rect.y + rect.w / 2);
    assert.equal(center.x * uv.x + uv.y, .5);
    assert.equal(center.y * uv.x + uv.z, .5, 'XYZ local coordinates; shader flips V only after mapping');
  }
  // A new equivalent selection must not refresh the retention deadline.
  const deadlines = [...layer.continuity.values()].map(p => p.expires);
  layer.update([selected(parent)]);
  assert.deepEqual([...layer.continuity.values()].map(p => p.expires), deadlines);
  const staleId = { level: 4, x: 1, y: 1 };
  layer.queueTexture(staleId, 0);
  Object.assign(layer.textures.get(key(staleId)), { state: 'ready', texture: new THREE.Texture(), byteSize: 12 * 1024 * 1024 });
  layer.suspended = false;
  layer.evictTextures(1024 * 1024);
  assert.equal(layer.textures.has(key(staleId)), false);
  assert.ok(children.every(id => layer.textures.has(key(id))), 'display coverage references survive admission pressure');
  layer.update(children.map(selected));
  assert.equal(layer.renderTiles.size, meshCount);
  assert.equal(layer.stats.continuityPatches, 0, 'new fine bindings release continuity ownership in the same update');
  assert.ok(children.every(id => layer.renderTiles.get(key(id)).textureKey === key(id)));
  layer.update([selected(parent)]);
  for (const patch of layer.continuity.values()) patch.expires = 0;
  layer.nextContinuityExpiry = 0;
  layer.update(layer.lastSelection);
  assert.equal(layer.stats.continuityPatches, 0, 'real zoom-out settles without camera movement');
  assert.equal(layer.renderTiles.get(key(parent)).mesh.material.uniforms.coverageCount.value, 0);
  layer.dispose();
}
const bounded = fixture({ maxContinuityBytes: 2 * 1024 * 1024, maxContinuityPatches: 2 });
bounded.update([selected(parent)]);
assert.equal(bounded.stats.continuityPatches, 2);
assert.ok(bounded.stats.continuityBytes <= 2 * 1024 * 1024);
bounded.update([]);
assert.equal(bounded.stats.continuityPatches, 0, 'offscreen coverage releases immediately');
for (const spare of bounded.spareTiles.values()) {
  assert.equal(spare.tile.mesh.material.uniforms.coverageCount.value, 0);
  for (let i = 0; i < 4; i++) assert.equal(spare.tile.mesh.material.uniforms[`coverageTexture${i}`].value, null);
}
bounded.dispose();
const holes = fixture({ overlay: true });
holes.update([selected(parent)]);
assert.equal(holes.stats.continuityPatches, 0, 'transparent business/WMTS overlays do not acquire neighbouring coverage');
holes.dispose();
const changed = fixture();
changed.update([selected(parent)]);
changed.provider.revision = 1;
changed.update(changed.lastSelection);
assert.equal(changed.stats.continuityPatches, 4, 'ordinary source zoom revisions preserve the display handoff');
changed.provider.levelOffset = -1; changed.provider.revision++;
changed.update(changed.lastSelection);
assert.equal(changed.stats.continuityPatches, 0, 'explicit offset changes invalidate held coverage');
changed.dispose();

const zoom = fixture();
let sourceCap = 5;
zoom.provider.maximumSourceLevel = renderLevel => Math.min(renderLevel, sourceCap);
sourceCap = 4; zoom.provider.revision = 1;
zoom.update(zoom.lastSelection);
assert.equal(zoom.stats.continuityPatches, 4, 'same leaf/source cap change also preserves previous detail');
for (const child of children) assert.equal(zoom.renderTiles.get(key(child)).mesh.material.uniforms.coverageCount.value, 1);
sourceCap = 5; zoom.provider.revision++;
zoom.update(zoom.lastSelection);
assert.equal(zoom.stats.continuityPatches, 0);
zoom.dispose();

const fair = fixture({ maxConcurrentRequests: 1 });
fair.textures.clear();
for (let i = 0; i < 9; i++) {
  const id = { level: 8, x: i, y: 0 };
  fair.queueTexture(id, i < 6 ? i : 100 + i, i < 6 ? 'coverage' : 'detail');
}
const starts = [];
fair.load = record => { starts.push(record.requestClass); record.state = 'loading'; fair.activeRequests++; };
fair.suspended = false;
for (let i = 0; i < 9; i++) { fair.activeRequests = 0; fair.pumpQueue(); }
assert.deepEqual(starts.slice(0, 3), ['coverage', 'coverage', 'detail']);
assert.equal(starts[5], 'detail');
assert.equal(starts[8], 'detail', 'foreground detail gets one of every three starts despite bridge backlog');
fair.renderTiles.clear(); fair.dispose();
console.log('Raster continuity passed (same mesh/UV, LRU ownership, expiry, bounds, overlays, revision, fair scheduling).');
