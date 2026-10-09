import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Viewer, UrlTemplateRasterProvider } from '../dist/spring-and-autumn-gis.es.js';

// Lightweight library-output check only. Interactive consumer belongs to
// E:/0-SpringGISNet, not a temporary project launched by the engine repository.
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(root + 'package.json', 'utf8'));
assert.equal(manifest.exports['.'].import, './dist/spring-and-autumn-gis.es.js');
assert.equal(manifest.exports['.'].require, './dist/spring-and-autumn-gis.umd.cjs');
assert.deepEqual(manifest.files, ['dist', 'SDK使用说明.md']);
for (const file of ['dist/index.d.ts', 'dist/sdk/Viewer.d.ts', 'dist/spring-and-autumn-gis.umd.cjs']) await access(root + file);
assert.equal(typeof Viewer.create, 'function');
assert.equal(typeof createRequire(root + 'package.json')(root + 'dist/spring-and-autumn-gis.umd.cjs').Viewer.create, 'function');
const provider = new UrlTemplateRasterProvider({ urlTemplate: '/tiles/{z}/{x}/{-y}.png' });
assert.equal(provider.url({ level: 2, x: 1, y: 0 }), '/tiles/2/1/3.png');
console.log('SDK dist ES/CJS/types/XYZ-TMS output checks passed. No install, temporary consumer or server launched.');
