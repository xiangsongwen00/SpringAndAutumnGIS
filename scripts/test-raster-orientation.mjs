import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/render/RasterTileLayer.ts', import.meta.url), 'utf8');
const loaderStart = source.indexOf('async function loadTextureWithFetch');
const loaderEnd = source.indexOf('\nfunction sanitizeError', loaderStart);
assert.ok(loaderStart >= 0 && loaderEnd > loaderStart, 'raster texture loader must exist');

const loader = source.slice(loaderStart, loaderEnd);
assert.match(loader, /loadHtmlImage\(/, 'raster tiles must decode through HTMLImageElement');
assert.match(loader, /texture\.flipY\s*=\s*true/, 'raster texture upload must preserve TextureLoader Y orientation');
assert.doesNotMatch(
  loader,
  /createImageBitmap\(/,
  'ImageBitmap changes WebGL flipY semantics and must not be used for raster imagery'
);
assert.match(
  source,
  /v_uv\s*=\s*vec2\(xyzUv\.x,\s*1\.0\s*-\s*xyzUv\.y\)/,
  'raster shader and texture upload orientation must remain paired'
);

console.log('Raster orientation checks passed.');
