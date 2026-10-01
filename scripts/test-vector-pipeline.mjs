import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import {
  VectorStyleRuntime, buildFillGeometry, buildLineStrokeGeometry,
  bindVectorTerrain, vectorTerrainUniforms, MvtTileSource, analyzeVectorSurfaceStyle
} from '../dist/spring-and-autumn-gis.es.js';

const style = {
  version: 8, sources: { fixture: { type: 'vector' } }, layers: [
    { id: 'water', type: 'background', paint: { 'background-color': '#0000ff' } },
    { id: 'land', type: 'fill', source: 'fixture', 'source-layer': 'polygons',
      filter: ['==', 'class', 'land'], paint: {
        'fill-color': ['match', ['get', 'kind'], 'park', '#00ff00', '#ff0000'],
        'fill-opacity': { stops: [[0, 0], [10, 1]] }
      } },
    { id: 'roads', type: 'line', source: 'fixture', 'source-layer': 'roads', minzoom: 5,
      paint: { 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 2, 10, 6] } }
  ]
};
const feature = { id: 7, type: 3, properties: { class: 'land', kind: 'park' }, extent: 4096,
  geometry: [[{ x: 0, y: 0 }, { x: 4096, y: 0 }, { x: 4096, y: 4096 }, { x: 0, y: 4096 }, { x: 0, y: 0 }],
    [{ x: 1024, y: 1024 }, { x: 1024, y: 3072 }, { x: 3072, y: 3072 }, { x: 3072, y: 1024 }, { x: 1024, y: 1024 }]] };
const runtime = new VectorStyleRuntime(style);
assert.deepEqual(runtime.issues, []);
const data = new Map([['polygons', [feature, { ...feature, properties: { class: 'water' } }]]]);
const buckets = runtime.buckets(data, 'fixture', 5);
assert.equal(buckets.length, 2);
assert.equal(buckets[1].features.length, 1, 'legacy filters must select features before bucket construction');
assert.equal(buckets[1].layer.paint['fill-color'], 'rgba(0,255,0,1)');
assert.equal(buckets[1].layer.paint['fill-opacity'], 0.5);
assert.equal(runtime.evaluate(runtime.layers[2], 7.5).paint['line-width'], 4);
assert.equal(runtime.buckets(data, 'other', 5).length, 1, 'source selection must isolate business data');

const geometry = buildFillGeometry({ level: 2, x: 3, y: 1 }, [feature], false);
let area = 0;
for (let index = 0; index < geometry.indices.length; index += 3) {
  const point = (offset) => {
    const vertex = geometry.indices[index + offset];
    return [geometry.uvs[vertex * 2], geometry.uvs[vertex * 2 + 1]];
  };
  const [a, b, c] = [point(0), point(1), point(2)];
  area += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
  const centroid = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
  assert.ok(!(centroid[0] > 0.25 && centroid[0] < 0.75 && centroid[1] > 0.25 && centroid[1] < 0.75), 'polygon hole must stay empty');
}
assert.ok(Math.abs(area - 0.75) < 1e-9, 'closed-ring normalization must preserve polygon hole indices');
assert.ok(geometry.positions.every(Number.isFinite));

const stroke = buildLineStrokeGeometry({ level: 2, x: 3, y: 1 }, [{ ...feature, type: 2,
  geometry: [[{ x: 0, y: 2048 }, { x: 4096, y: 2048 }]] }], 8, 512);
assert.equal(stroke.indices.length, 6);
assert.ok(Math.abs(Math.abs(stroke.uvs[1] - stroke.uvs[3]) * 512 - 8) < 1e-9, 'line width is measured in tile pixels');

const material = new THREE.ShaderMaterial({ uniforms: vectorTerrainUniforms() });
const texture = new THREE.Texture();
const terrain = { enabled: true, exaggeration: 2, resolveTexture: () => ({ texture,
  scale: 0.5, offsetX: 0.5, offsetY: 0, width: 257, height: 257 }) };
bindVectorTerrain(material, { level: 3, x: 5, y: 3 }, terrain);
assert.equal(material.uniforms.terrainTexture.value, texture);
assert.equal(material.uniforms.hasTerrain.value, true);
assert.deepEqual(material.uniforms.terrainUvScale.value.toArray(), [0.5, 0.5]);
terrain.enabled = false;
bindVectorTerrain(material, { level: 3, x: 5, y: 3 }, terrain);
assert.equal(material.uniforms.hasTerrain.value, false);
assert.equal(material.uniforms.terrainTexture.value, null);
material.dispose(); texture.dispose();

const esri = new VectorStyleRuntime(JSON.parse(await readFile(new URL('../public/En.json', import.meta.url), 'utf8')));
assert.equal(esri.layers.length, 913);
assert.deepEqual(esri.issues, [], 'En.json expressions and legacy stops must compile using MapLibre');
console.log('Vector pipeline checks passed (filters, expressions, holes, stroke width, DEM toggle, En.json).');

const tile = { level: 3, x: 2, y: 1 };
for (const scheme of ['xyz', 'tms']) {
  const source = new MvtTileSource({ id: scheme, source: { type: 'vector', scheme,
    tiles: ['https://fixture/{z}/{x}/{y}/{-y}'] } });
  assert.equal(source.url(tile), `https://fixture/3/2/${scheme === 'xyz' ? 1 : 6}/6`);
  for (const level of [0, 1, 3, 20]) {
    for (const y of [0, 2 ** level - 1]) {
      const inverse = 2 ** level - 1 - y;
      assert.equal(source.url({ level, x: 0, y }),
        `https://fixture/${level}/0/${scheme === 'xyz' ? y : inverse}/${inverse}`);
    }
  }
}
assert.throws(() => new MvtTileSource({ id: 'invalid', source: { type: 'vector',
  scheme: 'guess', tiles: ['https://fixture/{z}/{x}/{y}'] } }), /scheme/);
for (const explicitScheme of [undefined, 'xyz', 'tms']) {
  const urls = [];
  const source = new MvtTileSource({ id: 'metadata', source: { type: 'vector',
    url: 'https://fixture/tiles.json', ...(explicitScheme ? { scheme: explicitScheme } : {}) },
    fetcher: async (url) => {
      urls.push(url);
      return url.endsWith('.json') ? new Response(JSON.stringify({ scheme: 'tms', tiles: ['./{z}/{x}/{y}/{-y}'] }))
        : new Response(new Uint8Array());
    } });
  await source.load(tile);
  assert.equal(urls[1], `https://fixture/3/2/${explicitScheme === 'xyz' ? 1 : 6}/6`);
}
console.log('MVT XYZ/TMS and TileJSON scheme precedence checks passed.');
const capabilities = analyzeVectorSurfaceStyle({ version: 8, sources: {}, layers: [
  { id: 'pattern', type: 'fill', paint: { 'fill-pattern': 'lake' } },
  { id: 'symbol', type: 'symbol' },
  { id: 'offset', type: 'line', paint: { 'line-offset': 3 } },
  { id: 'basic', type: 'fill', paint: { 'fill-color': '#ff0000' } }
] });
assert.equal(capabilities.unsupportedLayers, 2);
assert.equal(capabilities.degradedLayers, 1);
assert.equal(capabilities.supportedLayers, 1);
console.log('GPU surface capability checks passed (no black pattern fallback).');
