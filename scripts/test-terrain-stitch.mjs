import assert from 'node:assert/strict';
import * as THREE from 'three';
import { stitchTerrainNeighborhood } from '../dist/spring-and-autumn-gis.es.js';

function terrainTile(id, size, value) {
  const heights = new Float32Array(size * size).fill(value);
  const texture = new THREE.DataTexture(
    heights,
    size,
    size,
    THREE.RedFormat,
    THREE.FloatType
  );
  return {
    id,
    data: {
      id,
      width: size,
      height: size,
      heights,
      minimumHeight: value,
      maximumHeight: value,
      texture
    }
  };
}

function edge(tile, side) {
  const { width, height, heights } = tile.data;
  const length = side === 'west' || side === 'east' ? height : width;
  return Array.from({ length }, (_, index) => {
    const offset = side === 'west'
      ? index * width
      : side === 'east'
        ? index * width + width - 1
        : side === 'north'
          ? index
          : (height - 1) * width + index;
    return heights[offset];
  });
}

function inwardLine(tile, side, edgeIndex) {
  const { width, height, heights } = tile.data;
  const depth = side === 'west' || side === 'east' ? width : height;
  return Array.from({ length: depth }, (_, index) => {
    const offset = side === 'west'
      ? edgeIndex * width + index
      : side === 'east'
        ? edgeIndex * width + width - 1 - index
        : side === 'north'
          ? index * width + edgeIndex
          : (height - 1 - index) * width + edgeIndex;
    return heights[offset];
  });
}

function assertMonotonic(values, direction) {
  for (let index = 1; index < values.length; index += 1) {
    if (direction === 'up') assert.ok(values[index] >= values[index - 1]);
    else assert.ok(values[index] <= values[index - 1]);
  }
}

function setInwardLine(tile, side, edgeIndex, values) {
  const { width, height, heights } = tile.data;
  for (let index = 0; index < values.length; index += 1) {
    const offset = side === 'west'
      ? edgeIndex * width + index
      : side === 'east'
        ? edgeIndex * width + width - 1 - index
        : side === 'north'
          ? index * width + edgeIndex
          : (height - 1 - index) * width + edgeIndex;
    heights[offset] = values[index];
  }
}

const sameA = terrainTile({ level: 3, x: 2, y: 3 }, 9, 0);
const sameB = terrainTile({ level: 3, x: 3, y: 3 }, 9, 100);
const sameResult = stitchTerrainNeighborhood(sameB, [sameA, sameB]);
assert.deepEqual(edge(sameA, 'east'), edge(sameB, 'west'));
const sameABounds = sameResult.bounds.get(sameA);
assert.ok(sameABounds);
assert.ok(sameABounds.maximumHeight < sameB.data.maximumHeight);
assert.equal(sameABounds.maximumHeight, Math.max(...sameA.data.heights));
assert.equal(sameABounds.minimumHeight, Math.min(...sameA.data.heights));

const slopeA = terrainTile({ level: 3, x: 2, y: 4 }, 9, 0);
const slopeB = terrainTile({ level: 3, x: 3, y: 4 }, 9, 100);
for (let index = 0; index < 9; index += 1) {
  setInwardLine(slopeA, 'east', index, [0, 20, 40, 60, 80, 100]);
  setInwardLine(slopeB, 'west', index, [100, 70, 40, 10, -20, -50]);
}
stitchTerrainNeighborhood(slopeB, [slopeA, slopeB]);
const firstSlopeLine = inwardLine(slopeA, 'east', 4);
const secondSlopeLine = inwardLine(slopeB, 'west', 4);
const firstBoundarySlope = firstSlopeLine[1] - firstSlopeLine[0];
const secondBoundarySlope = secondSlopeLine[1] - secondSlopeLine[0];
assert.ok(Math.abs(firstBoundarySlope + secondBoundarySlope) < 1e-5);
assert.ok([...slopeA.data.heights, ...slopeB.data.heights].every(
  (height) => height >= -50 && height <= 100
));

const coarse = terrainTile({ level: 2, x: 1, y: 1 }, 9, 0);
const fine = terrainTile({ level: 3, x: 4, y: 2 }, 9, 100);
stitchTerrainNeighborhood(fine, [coarse, fine]);
const coarseEdge = edge(coarse, 'east');
const fineEdge = edge(fine, 'west');
assert.ok(coarseEdge.every((height) => height === 0));
for (let coarseIndex = 0; coarseIndex <= 4; coarseIndex += 1) {
  assert.equal(coarseEdge[coarseIndex], fineEdge[coarseIndex * 2]);
}
const fineTransition = inwardLine(fine, 'west', 4);
assertMonotonic(fineTransition, 'up');
assert.ok(fineTransition.every((height) => height >= 0 && height <= 100));

const parent = terrainTile({ level: 2, x: 1, y: 1 }, 9, 20);
const child = terrainTile({ level: 3, x: 2, y: 2 }, 9, 100);
stitchTerrainNeighborhood(child, [parent, child]);
for (const side of ['west', 'east', 'north', 'south']) {
  assert.ok(edge(child, side).every((height) => height === 20));
}

console.log('Terrain edge stitching tests passed.');

// DEM-edge equality is insufficient: a 16-segment mesh renders chords, not
// every high-frequency height texel. Fine T-junctions must lie on those chords.
const { terrainSurfaceEdges } = await import('../dist/spring-and-autumn-gis.es.js');
for (const gap of [1, 2, 4]) {
  const scale = 2 ** gap;
  const coarseSurface = { id: { level: 9, x: 350, y: 200 }, segments: 16,
    height: (_u, v) => 6000 + 2500 * Math.sin(v * 55) };
  const fineSurface = { id: { level: 9 + gap, x: 351 * scale, y: 200 * scale + Math.floor(scale / 2) }, segments: 16,
    height: (_u, v) => 7000 + 1800 * Math.cos(v * 29) };
  const edges = terrainSurfaceEdges([coarseSurface, fineSurface]);
  const coarseBoundary = edges.get(coarseSurface), fineBoundary = edges.get(fineSurface);
  for (let step = 0; step <= 16; step++) {
    const amount = ((fineSurface.id.y - coarseSurface.id.y * scale) + step / 16) / scale * 16;
    const lower = Math.floor(amount), upper = Math.min(16, lower + 1);
    const expected = coarseBoundary.get(lower * 17 + 16).clone()
      .lerp(coarseBoundary.get(upper * 17 + 16), amount - lower);
    assert.ok(fineBoundary.get(step * 17).distanceTo(expected) < 1e-8,
      `actual rendered fine/coarse chord gap ${gap}, vertex ${step}`);
  }
}
const worldWest = { id: { level: 4, x: 0, y: 7 }, segments: 16, height: () => 5000 };
const worldEast = { id: { level: 4, x: 15, y: 7 }, segments: 16, height: () => 8000 };
const dateEdges = terrainSurfaceEdges([worldWest, worldEast]);
for (let step = 0; step <= 16; step++) assert.ok(
  dateEdges.get(worldWest).get(step * 17).distanceTo(dateEdges.get(worldEast).get(step * 17 + 16)) < 1e-8,
  'dateline shared ECEF authority');
console.log('Rendered terrain edge checks passed (mountain profiles, LOD gaps 1/2/4, dateline).');
const cornerTiles = [[350, 200], [351, 200], [350, 201], [351, 201]].map(([x, y], index) => ({
  id: { level: 9, x, y }, segments: 16, height: () => 5000 + index * 1000 }));
const cornerEdges = terrainSurfaceEdges(cornerTiles);
const reversedEdges = terrainSurfaceEdges([...cornerTiles].reverse());
const corners = [16 * 17 + 16, 16 * 17, 16, 0];
const canonicalCorner = cornerEdges.get(cornerTiles[0]).get(corners[0]);
for (let index = 0; index < 4; index++) {
  assert.ok(cornerEdges.get(cornerTiles[index]).get(corners[index]).distanceTo(canonicalCorner) < 1e-8);
  assert.ok(reversedEdges.get(cornerTiles[index]).get(corners[index]).distanceTo(canonicalCorner) < 1e-8);
}
const { TerrainTileLayer, Ellipsoid, sampleTerrainTile } = await import('../dist/spring-and-autumn-gis.es.js');
const heightLayer = new TerrainTileLayer(Ellipsoid.WGS84, { id: 'binding-fixture', minLevel: 0, maxLevel: 14 }, { exaggeration: 2 });
const ancestorData = terrainTile({ level: 9, x: 350, y: 200 }, 9, 0);
for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) ancestorData.data.heights[y * 9 + x] = 4000 + 100 * x + 200 * y;
heightLayer.records.set('9/350/200', { ...ancestorData, key: '9/350/200', state: 'ready', lastUsedFrame: 0 });
heightLayer.coverageReady = true;
assert.equal(heightLayer.sampleTileHeight({ level: 11, x: 1401, y: 802 }, .25, .75),
  2 * sampleTerrainTile(ancestorData.data, 1.25 / 4, 2.75 / 4));
heightLayer.dispose();
console.log('Rendered corners/order and CPU resolved DEM fallback/exaggeration checks passed.');

// No DEM: mixed spherical tessellation and the z17/z18 precision-path boundary
// still need exact shared ECEF chords.
const flatCoarse = { id: { level: 17, x: 92600, y: 59000 }, segments: 16, height: () => 0 };
const flatFine = { id: { level: 18, x: 185202, y: 118000 }, segments: 16, height: () => 0 };
const flatEdges = terrainSurfaceEdges([flatCoarse, flatFine], .1);
for (let step = 0; step <= 16; step++) {
  const amount = step / 2, lower = Math.floor(amount);
  const expected = flatEdges.get(flatCoarse).get(lower * 17 + 16).clone()
    .lerp(flatEdges.get(flatCoarse).get(Math.min(16, lower + 1) * 17 + 16), amount - lower);
  assert.ok(flatEdges.get(flatFine).get(step * 17).distanceTo(expected) < 1e-8, 'flat globe z17/z18 edge');
}
// Metadata remains stable when its DEM GPU/CPU entry is evicted.
const rangeLayer = new TerrainTileLayer(Ellipsoid.WGS84, { id: 'range', minLevel: 0, maxLevel: 14 });
rangeLayer.knownHeightRanges.set('9/350/200', { minimumHeight: 4000, maximumHeight: 8000 });
assert.deepEqual(rangeLayer.heightRange({ level: 11, x: 1401, y: 802 }), { minimumHeight: 4000, maximumHeight: 8000 });
rangeLayer.dispose();
console.log('Flat globe precision-path edge and evicted DEM metadata checks passed.');
const rawParent = terrainTile({ level: 2, x: 1, y: 1 }, 9, 5000);
const rawChild = terrainTile({ level: 3, x: 2, y: 2 }, 9, 9000);
const rawLayer = new TerrainTileLayer(Ellipsoid.WGS84, { id: 'raw', minLevel: 0, maxLevel: 14,
  loadTile: async () => rawChild.data });
rawLayer.records.set('2/1/1', { ...rawParent, key: '2/1/1', state: 'ready', lastUsedFrame: 0 });
const rawRecord = { ...rawChild, data: null, key: '3/2/2', state: 'queued', priority: 0, active: false, controller: null };
rawLayer.records.set(rawRecord.key, rawRecord);
rawLayer.load(rawRecord);
for (let tick = 0; tick < 4; tick++) await Promise.resolve();
assert.ok(rawParent.data.heights.every((v) => v === 5000) && rawChild.data.heights.every((v) => v === 9000),
  'new DEM arrival must not mutate raw parent/child heights');
rawLayer.dispose();
console.log('Runtime immutable DEM arrival checks passed.');
