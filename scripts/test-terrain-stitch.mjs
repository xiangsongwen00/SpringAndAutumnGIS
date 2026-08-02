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
