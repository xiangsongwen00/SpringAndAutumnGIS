import { execFileSync } from 'node:child_process';
import { transformSync } from 'esbuild';
import * as THREE from 'three';
import { Ellipsoid, terrainSurfaceEdges } from '../dist/spring-and-autumn-gis.es.js';

// Diagnostic only: no network/GPU and no timing assertions. Build dist first.
// HEAD is the pre-edit baseline until these changes are committed; use
// TERRAIN_BASELINE_REF afterwards to compare against the same original commit.
const ref = process.env.TERRAIN_BASELINE_REF ?? 'HEAD';
const previousSource = execFileSync('git', ['show', `${ref}:src/core/terrain/TerrainSurfaceEdges.ts`], { encoding: 'utf8' });
const source = previousSource.replace(/^import .*;\r?\n/gm, '');
const javascript = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
const baselineModule = { exports: {} };
new Function('THREE', 'Ellipsoid', 'module', javascript)(THREE, Ellipsoid, baselineModule);
const baseline = baselineModule.exports.terrainSurfaceEdges;
for (const count of [180, 350]) for (const [name, reconcile] of [['baseline', baseline], ['indexed', terrainSurfaceEdges]]) {
  const cache = new Map(), times = [];
  for (let frame = 0; frame < 35; frame++) {
    const tiles = Array.from({ length: count }, (_, index) => ({
      id: { level: 16, x: 50000 + index % 25 + frame % 5, y: 25000 + Math.floor(index / 25) },
      segments: 16, heightKey: 'immutable', height: (u, v) => 4000 + 100 * Math.sin(u + v)
    }));
    const started = performance.now(); reconcile(tiles, .1, cache);
    if (frame >= 10) times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  console.log(JSON.stringify({ count, name, medianMs: times[12], p95Ms: times[23] }));
}
