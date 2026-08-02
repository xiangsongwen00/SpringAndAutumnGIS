import * as THREE from 'three';
import { sampleTerrainTile, type TerrainTileData } from './TerrainProvider';
import type { TileId } from '../tiling/GeographicTilingScheme';

export type StitchableTerrainTile = Readonly<{
  id: TileId;
  data: TerrainTileData;
}>;

export type TerrainStitchBounds = Readonly<{
  minimumHeight: number;
  maximumHeight: number;
}>;

export type TerrainStitchResult = Readonly<{
  modified: ReadonlySet<StitchableTerrainTile>;
  bounds: ReadonlyMap<StitchableTerrainTile, TerrainStitchBounds>;
  stitchedEdges: number;
}>;

export type TerrainEdgeStitchOptions = Readonly<{
  minimumBlendTexels?: number;
  maximumBlendTexels?: number;
  /** Maximum slope introduced perpendicular to an edge (rise / run). */
  maximumAddedSlope?: number;
}>;

type Edge = 'west' | 'east' | 'north' | 'south';
type EdgeMatch = Readonly<{
  firstEdge: Edge;
  secondEdge: Edge;
  overlapStart: number;
  overlapEnd: number;
  firstStart: number;
  firstEnd: number;
  secondStart: number;
  secondEnd: number;
}>;

/**
 * Reconciles only exact shared boundaries affected by one newly loaded tile.
 * Interior samples are untouched except for an adaptive slope-limited easing band.
 */
export function stitchTerrainNeighborhood(
  loaded: StitchableTerrainTile,
  readyTiles: readonly StitchableTerrainTile[],
  optionsInput: TerrainEdgeStitchOptions | number = {}
): TerrainStitchResult {
  const options = normalizeOptions(optionsInput);
  const modified = new Set<StitchableTerrainTile>();
  const bounds = new Map<StitchableTerrainTile, TerrainStitchBounds>();
  const affected = new Set<StitchableTerrainTile>([loaded]);
  for (const tile of readyTiles) {
    if (tile !== loaded && isAncestor(loaded.id, tile.id)) affected.add(tile);
  }

  let stitchedEdges = 0;
  // A fine tile can arrive before its adjacent fine neighbour. Until then its
  // boundary must match the height function currently used by the fallback.
  for (const tile of affected) {
    const ancestor = closestReadyAncestor(tile, readyTiles);
    if (!ancestor) continue;
    for (const edge of ['west', 'east', 'north', 'south'] as const) {
      snapEdgeToAncestor(tile, ancestor, edge, options);
      markModified(tile, modified);
      stitchedEdges += 1;
    }
  }

  // Re-apply real neighbour relationships after ancestor snapping. The pair
  // key prevents a descendant set from averaging the same shared edge twice.
  const completedPairs = new Set<string>();
  for (const first of affected) {
    for (const second of readyTiles) {
      if (first === second) continue;
      const match = sharedEdge(first.id, second.id);
      if (!match) continue;
      const pairKey = edgePairKey(first, second, match);
      if (completedPairs.has(pairKey)) continue;
      completedPairs.add(pairKey);
      averageSharedEdge(first, second, match, options);
      markModified(first, modified);
      markModified(second, modified);
      stitchedEdges += 1;
    }
  }

  // Bounds must describe the samples that actually remain in this tile.
  // Unioning a neighbour's whole min/max range causes high peaks to propagate
  // through every stitched neighbour and makes terrain-aware LOD bounds grow
  // without limit after repeated updates.
  for (const tile of modified) {
    tile.data.texture.needsUpdate = true;
    bounds.set(tile, calculateBounds(tile.data.heights));
  }
  return { modified, bounds, stitchedEdges };
}

function closestReadyAncestor(
  tile: StitchableTerrainTile,
  readyTiles: readonly StitchableTerrainTile[]
): StitchableTerrainTile | undefined {
  let result: StitchableTerrainTile | undefined;
  for (const candidate of readyTiles) {
    if (candidate === tile || !isAncestor(candidate.id, tile.id)) continue;
    if (!result || candidate.id.level > result.id.level) result = candidate;
  }
  return result;
}

function snapEdgeToAncestor(
  tile: StitchableTerrainTile,
  ancestor: StitchableTerrainTile,
  edge: Edge,
  options: Required<TerrainEdgeStitchOptions>
): void {
  const levels = tile.id.level - ancestor.id.level;
  const scale = 1 / 2 ** levels;
  const offsetX = (tile.id.x - ancestor.id.x * 2 ** levels) * scale;
  const offsetY = (tile.id.y - ancestor.id.y * 2 ** levels) * scale;
  const length = edgeLength(tile.data, edge);
  const targets = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const amount = length <= 1 ? 0 : index / (length - 1);
    const u = offsetX + (edge === 'west' ? 0 : edge === 'east' ? scale : amount * scale);
    const v = offsetY + (edge === 'north' ? 0 : edge === 'south' ? scale : amount * scale);
    targets[index] = sampleTerrainTile(ancestor.data, u, v);
  }
  writeEdge(tile, edge, targets, options);
}

function averageSharedEdge(
  first: StitchableTerrainTile,
  second: StitchableTerrainTile,
  match: EdgeMatch,
  options: Required<TerrainEdgeStitchOptions>
): void {
  if (first.id.level !== second.id.level) {
    if (first.id.level < second.id.level) {
      conformFineEdgeToCoarse(
        first,
        second,
        match.firstEdge,
        match.secondEdge,
        match.firstStart,
        match.firstEnd,
        match.secondStart,
        match.secondEnd,
        match.overlapStart,
        match.overlapEnd,
        options
      );
    } else {
      conformFineEdgeToCoarse(
        second,
        first,
        match.secondEdge,
        match.firstEdge,
        match.secondStart,
        match.secondEnd,
        match.firstStart,
        match.firstEnd,
        match.overlapStart,
        match.overlapEnd,
        options
      );
    }
    return;
  }
  const firstProfile = readEdge(first.data, match.firstEdge);
  const secondProfile = readEdge(second.data, match.secondEdge);
  const firstTargets = firstProfile.slice();
  const secondTargets = secondProfile.slice();

  averageProfileSamples(
    firstProfile,
    secondProfile,
    firstTargets,
    match.firstStart,
    match.firstEnd,
    match.secondStart,
    match.secondEnd,
    match.overlapStart,
    match.overlapEnd
  );
  averageProfileSamples(
    secondProfile,
    firstProfile,
    secondTargets,
    match.secondStart,
    match.secondEnd,
    match.firstStart,
    match.firstEnd,
    match.overlapStart,
    match.overlapEnd
  );
  const firstSlopes = matchingInwardSlopes(
    first,
    second,
    match.firstEdge,
    match.secondEdge,
    match.firstStart,
    match.firstEnd,
    match.secondStart,
    match.secondEnd
  );
  writeEdge(first, match.firstEdge, firstTargets, options, firstSlopes.first);
  writeEdge(second, match.secondEdge, secondTargets, options, firstSlopes.second);
}

function conformFineEdgeToCoarse(
  coarse: StitchableTerrainTile,
  fine: StitchableTerrainTile,
  coarseEdge: Edge,
  fineEdge: Edge,
  coarseStart: number,
  coarseEnd: number,
  fineStart: number,
  fineEnd: number,
  overlapStart: number,
  overlapEnd: number,
  options: Required<TerrainEdgeStitchOptions>
): void {
  const coarseProfile = readEdge(coarse.data, coarseEdge);
  const fineProfile = readEdge(fine.data, fineEdge);
  // The coarser edge is the only curve both meshes can represent. It must stay
  // authoritative: moving both sides to their midpoint creates two opposing
  // ramps and the characteristic M-shaped ridge at an LOD transition.
  const canonicalCoarse = coarseProfile;
  const fineTargets = fineProfile.slice();
  const fineSlopes = new Float32Array(fineProfile.length);
  const coarseMetres = edgeMetresPerTexel(coarse, coarseEdge);
  const fineMetres = edgeMetresPerTexel(fine, fineEdge);
  for (let index = 0; index < fineTargets.length; index += 1) {
    const amount = fineTargets.length <= 1 ? 0 : index / (fineTargets.length - 1);
    const coordinate = THREE.MathUtils.lerp(fineStart, fineEnd, amount);
    if (coordinate < overlapStart - 1e-9 || coordinate > overlapEnd + 1e-9) continue;
    const coarseAmount = (coordinate - coarseStart) / (coarseEnd - coarseStart);
    fineTargets[index] = sampleProfile(canonicalCoarse, coarseAmount);
    // Inward directions point away from the shared edge on opposite sides.
    // Negating the coarse inward derivative gives the fine side the same
    // world-space normal. Scale it to the fine tile's metres per texel.
    fineSlopes[index] = -sampleInwardSlope(coarse, coarseEdge, coarseAmount) *
      fineMetres / Math.max(0.001, coarseMetres);
  }
  writeEdge(fine, fineEdge, fineTargets, options, fineSlopes);
}

function matchingInwardSlopes(
  first: StitchableTerrainTile,
  second: StitchableTerrainTile,
  firstEdge: Edge,
  secondEdge: Edge,
  firstStart: number,
  firstEnd: number,
  secondStart: number,
  secondEnd: number
): { first: Float32Array; second: Float32Array } {
  const firstLength = edgeLength(first.data, firstEdge);
  const secondLength = edgeLength(second.data, secondEdge);
  const firstSlopes = new Float32Array(firstLength);
  const secondSlopes = new Float32Array(secondLength);
  for (let index = 0; index < firstLength; index += 1) {
    const amount = firstLength <= 1 ? 0 : index / (firstLength - 1);
    const coordinate = THREE.MathUtils.lerp(firstStart, firstEnd, amount);
    const otherAmount = (coordinate - secondStart) / (secondEnd - secondStart);
    const own = sampleInwardSlope(first, firstEdge, amount);
    const other = sampleInwardSlope(second, secondEdge, otherAmount);
    firstSlopes[index] = 0.5 * (own - other);
  }
  for (let index = 0; index < secondLength; index += 1) {
    const amount = secondLength <= 1 ? 0 : index / (secondLength - 1);
    const coordinate = THREE.MathUtils.lerp(secondStart, secondEnd, amount);
    const otherAmount = (coordinate - firstStart) / (firstEnd - firstStart);
    const own = sampleInwardSlope(second, secondEdge, amount);
    const other = sampleInwardSlope(first, firstEdge, otherAmount);
    secondSlopes[index] = 0.5 * (own - other);
  }
  return { first: firstSlopes, second: secondSlopes };
}

function sampleInwardSlope(
  tile: StitchableTerrainTile,
  edge: Edge,
  amount: number
): number {
  const length = edgeLength(tile.data, edge);
  if (length <= 1) return 0;
  const position = THREE.MathUtils.clamp(amount, 0, 1) * (length - 1);
  const lower = Math.floor(position);
  const upper = Math.min(length - 1, lower + 1);
  const sample = (index: number): number => {
    const boundary = tile.data.heights[edgeIndex(tile.data, edge, index, 0)] ?? 0;
    const inward = tile.data.heights[edgeIndex(tile.data, edge, index, 1)] ?? boundary;
    return inward - boundary;
  };
  return THREE.MathUtils.lerp(sample(lower), sample(upper), position - lower);
}

function averageProfileSamples(
  ownProfile: Float32Array,
  otherProfile: Float32Array,
  targets: Float32Array,
  ownStart: number,
  ownEnd: number,
  otherStart: number,
  otherEnd: number,
  overlapStart: number,
  overlapEnd: number
): void {
  for (let index = 0; index < ownProfile.length; index += 1) {
    const amount = ownProfile.length <= 1 ? 0 : index / (ownProfile.length - 1);
    const coordinate = THREE.MathUtils.lerp(ownStart, ownEnd, amount);
    if (coordinate < overlapStart - 1e-9 || coordinate > overlapEnd + 1e-9) continue;
    const otherAmount = (coordinate - otherStart) / (otherEnd - otherStart);
    targets[index] = 0.5 * (
      (ownProfile[index] ?? 0) + sampleProfile(otherProfile, otherAmount)
    );
  }
}

function readEdge(data: TerrainTileData, edge: Edge): Float32Array {
  const length = edgeLength(data, edge);
  const result = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    result[index] = data.heights[edgeIndex(data, edge, index, 0)] ?? 0;
  }
  return result;
}

function writeEdge(
  tile: StitchableTerrainTile,
  edge: Edge,
  targets: Float32Array,
  options: Required<TerrainEdgeStitchOptions>,
  targetInwardSlopes?: Float32Array
): void {
  const data = tile.data;
  const availableDepth = edge === 'west' || edge === 'east' ? data.width : data.height;
  const metresPerTexel = edgeMetresPerTexel(tile, edge);
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index] ?? 0;
    const boundaryOffset = edgeIndex(data, edge, index, 0);
    const boundaryHeight = data.heights[boundaryOffset] ?? target;
    const correction = Math.abs(target - boundaryHeight);
    // Smoothstep reaches its steepest derivative at 1.5. Include that factor
    // so the generated ramp respects the configured maximum added slope.
    const adaptiveDepth = Math.ceil(
      (1.5 * correction) /
      Math.max(0.001, metresPerTexel * options.maximumAddedSlope)
    ) + 1;
    const depthLimit = Math.min(
      availableDepth,
      options.maximumBlendTexels,
      Math.max(options.minimumBlendTexels, adaptiveDepth)
    );
    let permittedMinimum = Math.min(target, target + (targetInwardSlopes?.[index] ?? 0));
    let permittedMaximum = Math.max(target, target + (targetInwardSlopes?.[index] ?? 0));
    for (let depth = 0; depth < depthLimit; depth += 1) {
      const height = data.heights[edgeIndex(data, edge, index, depth)] ?? target;
      permittedMinimum = Math.min(permittedMinimum, height);
      permittedMaximum = Math.max(permittedMaximum, height);
    }
    const originalSlope = depthLimit > 1
      ? (data.heights[edgeIndex(data, edge, index, 1)] ?? boundaryHeight) - boundaryHeight
      : 0;
    const targetSlope = targetInwardSlopes?.[index] ?? 0;
    const slopeCorrection = (targetSlope - originalSlope) * Math.max(1, depthLimit - 1);
    for (let depth = 0; depth < depthLimit; depth += 1) {
      const amount = depthLimit <= 1 ? 0 : depth / (depthLimit - 1);
      // Cubic Hermite correction: match both height and inward derivative at
      // the shared edge, then decay correction and its derivative to zero at
      // the end of the band. This removes the C0-only V-shaped crease.
      const amount2 = amount * amount;
      const amount3 = amount2 * amount;
      const valueBasis = 2 * amount3 - 3 * amount2 + 1;
      const slopeBasis = amount3 - 2 * amount2 + amount;
      const offset = edgeIndex(data, edge, index, depth);
      const current = data.heights[offset] ?? target;
      const smoothed = current +
        (target - boundaryHeight) * valueBasis +
        slopeCorrection * slopeBasis;
      // The rendered grid uses finite differences, not the analytic Hermite
      // derivative. Pin its first inward sample so the visible first segment
      // has exactly the agreed boundary slope on both tiles.
      data.heights[offset] = depth === 0
        ? target
        : depth === 1
          ? target + targetSlope
          : THREE.MathUtils.clamp(smoothed, permittedMinimum, permittedMaximum);
    }
  }
}

function edgeMetresPerTexel(tile: StitchableTerrainTile, edge: Edge): number {
  const size = 2 ** tile.id.level;
  const mercator = Math.PI - ((tile.id.y + 0.5) / size) * Math.PI * 2;
  const cosineLatitude = 1 / Math.cosh(mercator);
  const samples = edge === 'west' || edge === 'east'
    ? Math.max(1, tile.data.width - 1)
    : Math.max(1, tile.data.height - 1);
  return (2 * Math.PI * 6_378_137 * cosineLatitude) / (size * samples);
}

function normalizeOptions(
  input: TerrainEdgeStitchOptions | number
): Required<TerrainEdgeStitchOptions> {
  const legacyMinimum = typeof input === 'number' ? input : input.minimumBlendTexels;
  const minimumBlendTexels = Math.max(2, Math.round(legacyMinimum ?? 6));
  const maximumBlendTexels = Math.max(
    minimumBlendTexels,
    Math.round(typeof input === 'number' ? 128 : input.maximumBlendTexels ?? 128)
  );
  return {
    minimumBlendTexels,
    maximumBlendTexels,
    maximumAddedSlope: Math.max(
      0.05,
      typeof input === 'number' ? 0.45 : input.maximumAddedSlope ?? 0.45
    )
  };
}

function edgeLength(data: TerrainTileData, edge: Edge): number {
  return edge === 'west' || edge === 'east' ? data.height : data.width;
}

function edgeIndex(data: TerrainTileData, edge: Edge, index: number, depth: number): number {
  if (edge === 'west') return index * data.width + depth;
  if (edge === 'east') return index * data.width + (data.width - 1 - depth);
  if (edge === 'north') return depth * data.width + index;
  return (data.height - 1 - depth) * data.width + index;
}

function sampleProfile(profile: Float32Array, amountInput: number): number {
  if (profile.length <= 1) return profile[0] ?? 0;
  const position = THREE.MathUtils.clamp(amountInput, 0, 1) * (profile.length - 1);
  const lower = Math.floor(position);
  const upper = Math.min(profile.length - 1, lower + 1);
  return THREE.MathUtils.lerp(
    profile[lower] ?? 0,
    profile[upper] ?? profile[lower] ?? 0,
    position - lower
  );
}

function sharedEdge(first: TileId, second: TileId): EdgeMatch | null {
  const level = Math.max(first.level, second.level);
  const worldSize = 2 ** level;
  const firstRect = tileRectangle(first, level);
  const secondRect = tileRectangle(second, level);
  const verticalOverlapStart = Math.max(firstRect.north, secondRect.north);
  const verticalOverlapEnd = Math.min(firstRect.south, secondRect.south);
  if (verticalOverlapEnd > verticalOverlapStart) {
    if (wrap(firstRect.east, worldSize) === wrap(secondRect.west, worldSize)) {
      return edgeMatch('east', 'west', verticalOverlapStart, verticalOverlapEnd,
        firstRect.north, firstRect.south, secondRect.north, secondRect.south);
    }
    if (wrap(firstRect.west, worldSize) === wrap(secondRect.east, worldSize)) {
      return edgeMatch('west', 'east', verticalOverlapStart, verticalOverlapEnd,
        firstRect.north, firstRect.south, secondRect.north, secondRect.south);
    }
  }
  const horizontalOverlapStart = Math.max(firstRect.west, secondRect.west);
  const horizontalOverlapEnd = Math.min(firstRect.east, secondRect.east);
  if (horizontalOverlapEnd > horizontalOverlapStart) {
    if (firstRect.south === secondRect.north) {
      return edgeMatch('south', 'north', horizontalOverlapStart, horizontalOverlapEnd,
        firstRect.west, firstRect.east, secondRect.west, secondRect.east);
    }
    if (firstRect.north === secondRect.south) {
      return edgeMatch('north', 'south', horizontalOverlapStart, horizontalOverlapEnd,
        firstRect.west, firstRect.east, secondRect.west, secondRect.east);
    }
  }
  return null;
}

function edgeMatch(
  firstEdge: Edge,
  secondEdge: Edge,
  overlapStart: number,
  overlapEnd: number,
  firstStart: number,
  firstEnd: number,
  secondStart: number,
  secondEnd: number
): EdgeMatch {
  return {
    firstEdge,
    secondEdge,
    overlapStart,
    overlapEnd,
    firstStart,
    firstEnd,
    secondStart,
    secondEnd
  };
}

function tileRectangle(id: TileId, level: number): {
  west: number;
  east: number;
  north: number;
  south: number;
} {
  const scale = 2 ** (level - id.level);
  return {
    west: id.x * scale,
    east: (id.x + 1) * scale,
    north: id.y * scale,
    south: (id.y + 1) * scale
  };
}

function isAncestor(ancestor: TileId, child: TileId): boolean {
  if (ancestor.level >= child.level) return false;
  const scale = 2 ** (child.level - ancestor.level);
  return Math.floor(child.x / scale) === ancestor.x &&
    Math.floor(child.y / scale) === ancestor.y;
}

function wrap(value: number, size: number): number {
  return ((value % size) + size) % size;
}

function edgePairKey(
  first: StitchableTerrainTile,
  second: StitchableTerrainTile,
  match: EdgeMatch
): string {
  const firstKey = `${first.id.level}/${first.id.x}/${first.id.y}/${match.firstEdge}`;
  const secondKey = `${second.id.level}/${second.id.x}/${second.id.y}/${match.secondEdge}`;
  return firstKey < secondKey ? `${firstKey}|${secondKey}` : `${secondKey}|${firstKey}`;
}

function markModified(
  tile: StitchableTerrainTile,
  modified: Set<StitchableTerrainTile>
): void {
  modified.add(tile);
}

function calculateBounds(heights: Float32Array): TerrainStitchBounds {
  let minimumHeight = Number.POSITIVE_INFINITY;
  let maximumHeight = Number.NEGATIVE_INFINITY;
  for (const height of heights) {
    if (!Number.isFinite(height)) continue;
    minimumHeight = Math.min(minimumHeight, height);
    maximumHeight = Math.max(maximumHeight, height);
  }
  if (!Number.isFinite(minimumHeight) || !Number.isFinite(maximumHeight)) {
    return { minimumHeight: 0, maximumHeight: 0 };
  }
  return { minimumHeight, maximumHeight };
}
