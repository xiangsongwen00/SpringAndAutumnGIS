import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_LEVEL_OFFSET,
  DataSourceRegistry,
  LayerCollection,
  MvtTileSource,
  UrlTemplateRasterProvider
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
assert.equal(catalog.version, 1);
assert.equal(catalog.defaults.levelOffset, DEFAULT_LEVEL_OFFSET);
assert.ok(catalog.sources.length >= 10);
assert.ok(catalog.layers.some((layer) => layer.id === catalog.defaultBaseLayerId));
const sourceIds = new Set(catalog.sources.map((source) => source.id));
for (const layer of catalog.layers) {
  assert.ok(sourceIds.has(layer.sourceId), `Missing source for layer ${layer.id}`);
}

console.log('Layer management checks passed.');
