import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_LEVEL_OFFSET,
  DataSourceRegistry,
  Ellipsoid,
  GeoJsonLayer,
  GeoJsonSource,
  LayerCollection,
  MvtTileSource,
  UrlTemplateRasterProvider,
  parseLayerCatalog,
  serializeLayerCatalog,
  validateLayerCatalog
} from '../dist/spring-and-autumn-gis.es.js';

assert.equal(DEFAULT_LEVEL_OFFSET, -1.7);

const provider = new UrlTemplateRasterProvider({
  id: 'test',
  urlTemplate: 'https://tiles.example/{z}/{x}/{y}.png',
  maxLevel: 20
});
assert.equal(provider.viewLevelOffset, DEFAULT_LEVEL_OFFSET);
provider.setViewLevel(10.2);
assert.equal(provider.currentSourceLevel, 8);
provider.setViewLevelOffset(-2.2);
provider.setViewLevel(10.2);
assert.equal(provider.currentSourceLevel, 8);
provider.setViewLevelOffset(-0.5);
provider.setViewLevel(10.2);
assert.equal(provider.currentSourceLevel, 9);

const tmsProvider = new UrlTemplateRasterProvider({
  id: 'tms-overlay',
  urlTemplate: '/tiles/{z}/{x}/{-y}.png',
  bounds: [107.28, 30.22, 107.32, 30.26],
  maxLevel: 18
});
assert.equal(tmsProvider.url({ level: 4, x: 12, y: 6 }), '/tiles/4/12/9.png');
assert.equal(tmsProvider.hasTile({ level: 1, x: 1, y: 0 }), true);
assert.equal(tmsProvider.hasTile({ level: 1, x: 0, y: 0 }), false);

const layers = new LayerCollection([
  {
    id: 'base-a',
    name: 'A',
    kind: 'imagery',
    role: 'base',
    sourceId: 'source-a',
    visible: true,
    exclusiveGroup: 'basemap'
  },
  {
    id: 'base-b',
    name: 'B',
    kind: 'imagery',
    role: 'base',
    sourceId: 'source-b',
    exclusiveGroup: 'basemap'
  }
]);
layers.setVisible('base-b', true);
assert.equal(layers.get('base-a').visible, false);
assert.equal(layers.get('base-b').visible, true);
layers.setLevelOffset('base-b', -2.4);
assert.equal(layers.get('base-b').levelOffset, -2.4);
let statusEvent;
const unsubscribe = layers.subscribe((event) => {
  if (event.type === 'status') statusEvent = event;
});
const runtime = layers.setRuntime('base-b', {
  phase: 'error',
  pending: 1,
  failed: 2,
  lastError: 'test error'
});
assert.equal(runtime.phase, 'error');
assert.equal(statusEvent.layerId, 'base-b');
assert.equal(statusEvent.runtime.lastError, 'test error');
assert.equal(layers.toJSON()[1].lastError, undefined);
unsubscribe();

const registry = new DataSourceRegistry([
  {
    id: 'secured',
    name: 'Secured',
    kind: 'xyz-raster',
    urlTemplate: 'https://tiles.example/{z}/{x}/{y}.png?token=${TOKEN}',
    requires: ['TOKEN']
  }
]);
assert.deepEqual(registry.availability('secured').missingVariables, ['TOKEN']);
assert.throws(() => registry.createRasterProvider('secured'), /missing variables/);

const geoJsonSource = new GeoJsonSource({
  id: 'geojson-test',
  url: 'https://data.example/test.geojson',
  maxFeatures: 2
});
const originalGeoJsonFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    properties: { name: 'test' },
    geometry: { type: 'LineString', coordinates: [[100, 30], [101, 31]] }
  }]
}), { status: 200, headers: { 'content-type': 'application/geo+json' } });
try {
  const collection = await geoJsonSource.load();
  assert.equal(collection.features.length, 1);
  const featureLayer = new GeoJsonLayer(Ellipsoid.WGS84, collection);
  assert.equal(featureLayer.featureCount, 1);
  assert.equal(featureLayer.object3d.children.length, 1);
  assert.ok(featureLayer.coordinateCount > 2, 'long globe chords should be densified');
  const lineObject = featureLayer.object3d.children[0];
  assert.equal(lineObject.material.depthTest, true);
  assert.equal(lineObject.material.depthWrite, false);
  assert.ok(lineObject.geometry.getAttribute('terrainHeight'));
  featureLayer.dispose();

  const terrain = {
    revision: 1,
    exaggeration: 1,
    enabled: true,
    resolveTexture: () => undefined,
    sampleHeight: () => 42,
    maximumHeight: () => 42,
    heightRange: () => ({ minimumHeight: 42, maximumHeight: 42 })
  };
  const drapedLayer = new GeoJsonLayer(Ellipsoid.WGS84, collection, {
    terrain,
    terrainRefreshDelayMs: 0,
    maximumSegmentDegrees: 10
  });
  assert.equal(drapedLayer.update(undefined, 0), true);
  const drapedHeights = drapedLayer.object3d.children[0].geometry
    .getAttribute('terrainHeight').array;
  assert.deepEqual([...drapedHeights], [42, 42]);
  terrain.enabled = false;
  terrain.revision += 1;
  assert.equal(drapedLayer.update(undefined, 1), true);
  assert.deepEqual([...drapedHeights], [0, 0]);
  drapedLayer.dispose();
} finally {
  globalThis.fetch = originalGeoJsonFetch;
}

const originalFetch = globalThis.fetch;
const requestedUrls = [];
globalThis.fetch = async (input) => {
  const url = String(input);
  requestedUrls.push(url);
  if (url.endsWith('/tiles.json')) {
    return new Response(JSON.stringify({
      tiles: ['https://tiles.example/{z}/{x}/{y}.pbf']
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
};
try {
  const mvtSource = new MvtTileSource({
    id: 'tilejson-source',
    source: { type: 'vector', url: 'https://tiles.example/tiles.json' }
  });
  const bytes = await mvtSource.load({ level: 4, x: 9, y: 6 });
  assert.equal(bytes.byteLength, 3);
  assert.deepEqual(requestedUrls, [
    'https://tiles.example/tiles.json',
    'https://tiles.example/4/9/6.pbf'
  ]);
} finally {
  globalThis.fetch = originalFetch;
}

const catalog = JSON.parse(
  await readFile(new URL('../env.config.json', import.meta.url), 'utf8')
);
const parsedCatalog = parseLayerCatalog(catalog);
assert.equal(validateLayerCatalog(catalog).valid, true);
assert.deepEqual(JSON.parse(serializeLayerCatalog(parsedCatalog)), catalog);
const invalidCatalog = structuredClone(catalog);
invalidCatalog.layers[0].sourceId = 'missing-source';
const invalidResult = validateLayerCatalog(invalidCatalog);
assert.equal(invalidResult.valid, false);
assert.ok(invalidResult.issues.some((entry) => entry.path.endsWith('.sourceId')));
assert.equal(catalog.version, 1);
assert.equal(catalog.defaults.levelOffset, DEFAULT_LEVEL_OFFSET);
assert.ok(catalog.sources.length >= 10);
assert.ok(catalog.layers.some((layer) => layer.id === catalog.defaultBaseLayerId));
const sourceIds = new Set(catalog.sources.map((source) => source.id));
for (const layer of catalog.layers) {
  assert.ok(sourceIds.has(layer.sourceId), `Missing source for layer ${layer.id}`);
}
for (const id of [
  'business-yongyuan-static',
  'local-geoserver-usa-wmts',
  'local-geoserver-adminxian-wmts',
  'local-china-admin-mvt'
]) {
  const layer = catalog.layers.find((candidate) => candidate.id === id);
  assert.equal(layer.role, 'overlay', `${id} must remain a business overlay`);
  assert.equal(layer.exclusiveGroup, undefined, `${id} must not join the basemap group`);
}

console.log('Layer management checks passed.');
