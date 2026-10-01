import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Ellipsoid, GlobeLodSelector, WebMercatorTilingScheme } from '../dist/spring-and-autumn-gis.es.js';

// Loaded elevated terrain, not the old h=0 coverage test. Camera clearance is
// held constant while pitch changes: a mountain foreground must not lose detail.
const ellipsoid = Ellipsoid.WGS84, longitude = 103.43968, latitude = 32.04231;
const height = 4000, clearance = 1000;
function pose(tilt, roll = 0) {
  const lon = longitude * Math.PI / 180, lat = latitude * Math.PI / 180, a = tilt * Math.PI / 180;
  const up = new THREE.Vector3(Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon));
  const north = new THREE.Vector3(-Math.sin(lat) * Math.sin(lon), Math.cos(lat), -Math.sin(lat) * Math.cos(lon));
  const camera = new THREE.PerspectiveCamera(50, 1.8, 1, 1e8);
  camera.position.copy(ellipsoid.cartographicToCartesian({ longitude, latitude, height: height + clearance }));
  camera.up.copy(north).multiplyScalar(Math.cos(a)).addScaledVector(up, Math.sin(a));
  camera.lookAt(camera.position.clone().add(north.clone().multiplyScalar(Math.sin(a)).addScaledVector(up, -Math.cos(a))));
  camera.rotateZ(roll * Math.PI / 180); camera.updateMatrixWorld();
  return camera;
}
function samples(camera) {
  const axes = new THREE.Vector3(1 / (ellipsoid.equatorialRadius + height),
    1 / (ellipsoid.polarRadius + height), 1 / (ellipsoid.equatorialRadius + height));
  const hits = [];
  for (let y = -.96; y <= .96; y += .12) for (let x = -.96; x <= .96; x += .12) {
    const direction = new THREE.Vector3(x, y, .5).unproject(camera).sub(camera.position).normalize();
    const o = camera.position.clone().multiply(axes), d = direction.clone().multiply(axes);
    const a = d.dot(d), b = 2 * o.dot(d), c = o.dot(o) - 1, disc = b * b - 4 * a * c;
    if (disc < 0) continue;
    const t = (-b - Math.sqrt(disc)) / (2 * a); if (t < 0) continue;
    const p = camera.position.clone().addScaledVector(direction, t);
    hits.push({ distance: t, longitude: Math.atan2(p.x, p.z) * 180 / Math.PI,
      latitude: Math.atan2(p.y * (ellipsoid.equatorialRadius + height) ** 2,
        Math.hypot(p.x, p.z) * (ellipsoid.polarRadius + height) ** 2) * 180 / Math.PI });
  }
  return hits.sort((a, b) => a.distance - b.distance);
}
const selector = new GlobeLodSelector({ tilingScheme: new WebMercatorTilingScheme(),
  minLevel: 2, maxLevel: 27, targetPixels: 128, maxTiles: 350, maximumSurfaceDisplacement: 12000 });
let localHeight = height, revision = 1, snapshotSamples = 0;
selector.setSurfaceDisplacementSource({ get revision() { return revision; }, maximumHeight: () => height + 2,
  sampleHeight: () => localHeight,
  tileHeightSampler: () => ({ key: 'loaded', sample: (u, v) => {
    assert.ok(Number.isFinite(u) && Number.isFinite(v) && u >= -1e-7 && u <= 1 + 1e-7 && v >= -1e-7 && v <= 1 + 1e-7,
      'detail snapshot uses valid local XYZ UVs');
    snapshotSamples++; return height;
  } }),
  heightRange: () => ({ minimumHeight: height - 2, maximumHeight: height + 2 }) });
for (const [tilt, roll] of [[0, 0], [45, 0], [70, 0], [80, 0], [87, 0], [87, 180], [80, 90], [45, 0], [0, 0]]) {
  const camera = pose(tilt, roll), result = selector.select(camera, 926), hits = samples(camera);
  assert.ok(result.tiles.length <= 350 && hits.length > 0);
  const levels = hits.map(hit => {
    const leaf = result.tiles.find(({ rectangle: r }) => hit.longitude >= r.west && hit.longitude <= r.east &&
      hit.latitude >= r.south && hit.latitude <= r.north);
    assert.ok(leaf, `elevated visible coverage hole at pitch ${tilt}`);
    return leaf.id.level;
  });
  const nearest = levels.slice(0, Math.max(1, Math.floor(levels.length / 4))).sort((a, b) => a - b);
  const median = nearest[Math.floor(nearest.length / 2)];
  console.log(`Mountain tilt ${tilt}/roll ${roll}: ${result.tiles.length} leaves, closest-quarter median z${median}, minimum z${nearest[0]}`);
  assert.ok(median >= 17 && nearest[0] >= 16, `mountain foreground incorrectly coarsened at pitch ${tilt}: z${median}/${nearest[0]}`);
  if (tilt === 0) assert.ok(result.tiles.length < 315, 'elevated nadir must retain budget headroom');
  const repeated = selector.select(camera, 926);
  assert.deepEqual(repeated.tiles.map(tile => tile.id), result.tiles.map(tile => tile.id), 'stationary mountain selection must not self-refine');
}
assert.ok(snapshotSamples > 0, 'detail must use resolved DEM snapshots instead of repeating pyramid lookups');
const stableCamera = pose(87), stable = selector.select(stableCamera, 926).tiles.map(tile => tile.id);
for (const value of [null, 1000, null, height]) {
  localHeight = value; revision++;
  assert.deepEqual(selector.select(stableCamera, 926).tiles.map(tile => tile.id), stable,
    'stationary loaded-height refinement/eviction must not oscillate the detail shell');
}
// A broad ancestor range must not turn every point into its tallest mountain.
const broad = new GlobeLodSelector({ tilingScheme: new WebMercatorTilingScheme(), maxTiles: 350,
  targetPixels: 128, maximumSurfaceDisplacement: 12000 });
broad.setSurfaceDisplacementSource({ revision: 1, maximumHeight: () => 12000, sampleHeight: () => height,
  heightRange: () => ({ minimumHeight: 0, maximumHeight: 12000 }) });
const broadResult = broad.select(pose(80), 926);
assert.ok(broadResult.tiles.length < 315, 'actual loaded height must beat fictitious ancestor extrema for detail');
console.log(`Broad range/local height: ${broadResult.tiles.length} leaves.`);
console.log('Mountain elevated foreground detail checks passed.');
