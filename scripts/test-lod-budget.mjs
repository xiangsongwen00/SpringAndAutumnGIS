import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Ellipsoid, GlobeLodSelector, WebMercatorTilingScheme } from '../dist/spring-and-autumn-gis.es.js';

const ellipsoid = Ellipsoid.WGS84;
const options = { minLevel: 2, maxLevel: 27, targetPixels: 128, collapseFactor: .7,
  maxTiles: 350, maximumSurfaceDisplacement: 0, tilingScheme: new WebMercatorTilingScheme() };
for (const [width, height] of [[1280, 800], [1920, 1080]]) {
  for (const altitude of [500, 12000, 100000, 1000000, 8600000]) {
    const camera = new THREE.PerspectiveCamera(50, width / height, 1, 100000000);
    const selector = new GlobeLodSelector(options);
    const reference = new GlobeLodSelector(options);
    // Previous revision: projected error without a peripheral density gradient.
    reference.detailImportance = () => 1;
    let peak = 0, referencePeak = 0;
    for (let step = 0; step < 24; step++) {
      const position = { longitude: 106.55, latitude: 29.56, height: altitude * (1 + .002 * step) };
      const target = ellipsoid.cartographicToCartesian({ ...position, height: 0 });
      camera.position.copy(ellipsoid.cartographicToCartesian(position));
      camera.up.set(0, 1, 0);
      camera.lookAt(target); camera.updateProjectionMatrix();
      const result = selector.select(camera, height);
      peak = Math.max(peak, result.tiles.length);
      referencePeak = Math.max(referencePeak, reference.select(camera, height).tiles.length);
      assert.ok(result.tiles.length < 315, 'flat top-down zoom must retain budget headroom');
      const repeated = selector.select(camera, height);
      assert.deepEqual(repeated.tiles.map((tile) => tile.id), result.tiles.map((tile) => tile.id),
        'stationary selection must not keep refining itself');
    }
    console.log(`Flat top-down ${width}x${height}, ${altitude}m zoom sweep: previous peak ${referencePeak}, gradient peak ${peak}`);
    assert.ok(peak < referencePeak, 'gradient must reduce work compared with uniform pixel density');
  }
}
console.log('LOD budget checks passed (flat top-down zoom, hysteresis stability, 1280/1920 viewport).');
