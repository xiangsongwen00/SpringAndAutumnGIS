import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Ellipsoid, GlobeLodSelector, WebMercatorTilingScheme, tileRequestUrgency } from '../dist/spring-and-autumn-gis.es.js';

const ellipsoid = Ellipsoid.WGS84;
const axisScale = new THREE.Vector3(1 / ellipsoid.equatorialRadius, 1 / ellipsoid.polarRadius, 1 / ellipsoid.equatorialRadius);
function groundHit(origin, direction) {
  const o = origin.clone().multiply(axisScale), d = direction.clone().multiply(axisScale);
  const a = d.dot(d), b = 2 * o.dot(d), c = o.dot(o) - 1;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return null;
  const t = (-b - Math.sqrt(discriminant)) / (2 * a);
  return t < 0 ? null : origin.clone().addScaledVector(direction, t);
}
for (const [longitude, latitude, altitude, tilt, roll = 0, fov = 50, aspect = 1.6] of [
  [106.55, 29.56, 12000, 0], [106.55, 29.56, 12000, 60], [106.55, 29.56, 12000, 85],
  [106.55, 29.56, 500, 80], [179.5, 65, 20000, 70], [-45, 75, 10000, 80],
  [105, 32, 8600000, 0], [106.55, 29.56, 12000, 89],
  [106.55, 29.56, 12000, 85, 180], [106.55, 29.56, 12000, 80, 90, 75, .75]
]) {
  const camera = new THREE.PerspectiveCamera(fov, aspect, 1, 100000000);
  camera.position.copy(ellipsoid.cartographicToCartesian({ longitude, latitude, height: altitude }));
  const lon = longitude * Math.PI / 180, lat = latitude * Math.PI / 180, angle = tilt * Math.PI / 180;
  const up = new THREE.Vector3(Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon));
  const east = new THREE.Vector3(Math.cos(lon), 0, -Math.sin(lon));
  const north = up.clone().cross(east);
  const forward = north.clone().multiplyScalar(Math.sin(angle)).addScaledVector(up, -Math.cos(angle));
  camera.up.copy(north).multiplyScalar(Math.cos(angle)).addScaledVector(up, Math.sin(angle));
  camera.lookAt(camera.position.clone().addScaledVector(forward, 10000));
  camera.rotateZ(roll * Math.PI / 180);
  camera.updateMatrixWorld(); camera.updateProjectionMatrix();
  const options = { tilingScheme: new WebMercatorTilingScheme(), minLevel: 2, maxLevel: 27,
    targetPixels: 128, maxTiles: 350, maximumSurfaceDisplacement: 12000 };
  const selector = new GlobeLodSelector(options);
  const result = selector.select(camera, 1000);
  assert.ok(result.tiles.length <= 350 && result.tiles.length > 0, 'budget and visible coverage');
  for (const tile of result.tiles) assert.ok(selector.maximumFacingInRectangle(tile.rectangle) > 0,
    'a tile wholly on the antipodal half must never survive');
  let hits = 0;
  const groundDetail = [];
  for (let y = 0; y <= 20; y++) for (let x = 0; x <= 24; x++) {
    const direction = new THREE.Vector3(-.98 + 1.96 * x / 24, -.98 + 1.96 * y / 20, .5)
      .unproject(camera).sub(camera.position).normalize();
    const point = groundHit(camera.position, direction);
    if (!point) continue;
    hits++;
    const lonHit = Math.atan2(point.x, point.z) * 180 / Math.PI;
    const latHit = Math.atan2(point.y * ellipsoid.equatorialRadius ** 2,
      Math.hypot(point.x, point.z) * ellipsoid.polarRadius ** 2) * 180 / Math.PI;
    assert.ok(result.tiles.some(({ rectangle: r }) => lonHit >= r.west - 1e-8 && lonHit <= r.east + 1e-8 &&
      latHit >= r.south - 1e-8 && latHit <= r.north + 1e-8), `visible ground hole ${lonHit}/${latHit}, tilt=${tilt}`);
    const leaf = result.tiles.find(({ rectangle: r }) => lonHit >= r.west && lonHit <= r.east && latHit >= r.south && latHit <= r.north);
    if (leaf) groundDetail.push({ distance: point.distanceTo(camera.position), level: leaf.id.level, y: -.98 + 1.96 * y / 20 });
  }
  if (tilt >= 60) {
    groundDetail.sort((a, b) => a.distance - b.distance);
    const quarter = Math.max(1, Math.floor(groundDetail.length / 4));
    const medianLevel = (values) => values.map((v) => v.level).sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const near = medianLevel(groundDetail.slice(0, quarter));
    const far = medianLevel(groundDetail.slice(-quarter));
    assert.ok(near >= far + 1, `near foreground must be finer than far horizon: ${near}/${far}, tilt=${tilt}`);
    console.log(`  projected detail near/far median levels ${near}/${far}, roll ${roll}, fov ${fov}, aspect ${aspect}`);
  }
  let elevatedHits = 0;
  for (let latOffset = -5; latOffset <= 5; latOffset += .25) for (let lonOffset = -5; lonOffset <= 5; lonOffset += .25) {
    const lonHit = longitude + lonOffset, latHit = latitude + latOffset;
    if (lonHit < -180 || lonHit > 180 || latHit < -85 || latHit > 85) continue;
    const point = ellipsoid.cartographicToCartesian({ longitude: lonHit, latitude: latHit, height: 8000 });
    const projected = point.clone().project(camera);
    if (Math.abs(projected.x) > .98 || Math.abs(projected.y) > .98 || projected.z < -1 || projected.z > 1) continue;
    const direction = point.clone().sub(camera.position).normalize();
    const occluder = groundHit(camera.position, direction);
    if (occluder && occluder.distanceTo(camera.position) < point.distanceTo(camera.position) - 1) continue;
    elevatedHits++;
    assert.ok(result.tiles.some(({ rectangle: r }) => lonHit >= r.west - 1e-8 && lonHit <= r.east + 1e-8 &&
      latHit >= r.south - 1e-8 && latHit <= r.north + 1e-8), `visible elevated terrain hole ${lonHit}/${latHit}`);
  }
  const sphereReference = new GlobeLodSelector({ ...options, maxTiles: 480, horizonPaddingDegrees: .75 });
  sphereReference.boxInsideFrustum = () => true;
  const reference = sphereReference.select(camera, 1000);
  console.log(`LOD ${longitude}/${latitude}, ${altitude}m, tilt ${tilt}: sphere/padding reference ${reference.tiles.length}, tight/budget ${result.tiles.length}, ground hits ${hits}, elevated hits ${elevatedHits}`);
}
const urgencyTile = { id: { level: 15, x: 1, y: 1 }, rectangle: { west: 0, east: 1, south: 0, north: 1 } };
assert.ok(tileRequestUrgency({ ...urgencyTile, screenPixels: 300, viewCenterDistance: 1 }) >
  tileRequestUrgency({ ...urgencyTile, screenPixels: 100, viewCenterDistance: 0 }), 'near-edge error must beat distant centre');
assert.ok(tileRequestUrgency({ ...urgencyTile, screenPixels: 100, viewCenterDistance: 0 }) >
  tileRequestUrgency({ ...urgencyTile, screenPixels: 100, viewCenterDistance: 1 }), 'equal error retains centre preference');
console.log('LOD visibility passed (oblique, terrain bounds, antipodal exclusion, dateline/high latitude, dense visible-ground coverage).');
