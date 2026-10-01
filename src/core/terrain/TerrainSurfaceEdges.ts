import * as THREE from 'three';
import { Ellipsoid } from '../geo/Ellipsoid';
import type { TileId } from '../tiling/GeographicTilingScheme';

export type TerrainSurfaceTile = {
  id: TileId;
  segments: number;
  /** Same resolved DEM/ancestor and exaggeration as the vertex shader. */
  height: (u: number, v: number) => number;
  /** Immutable binding/content token; omit to disable cross-frame caching. */
  heightKey?: string;
};
type Edge = { tile: TerrainSurfaceTile; axis: 'x' | 'y'; fixed: number; start: number; end: number; cachePrefix?: string };
// Coordinate-keyed retention avoids constructing a long source/height string
// for every boundary vertex on every camera movement. Metadata is weak so
// eviction/disposal does not leave a second unbounded owner of world points.
const retainedBindings = new WeakMap<THREE.Vector3, { binding?: string;
  first?: THREE.Vector3; second?: THREE.Vector3; fraction?: number }>();

/** Reconcile the actual rendered ECEF polylines, not merely DEM texels.
 * Fine T-junctions lie on the coarse edge's straight segment. Shared corners
 * use one canonical authority, including mixed-LOD and ancestor fallback.
 */
export function terrainSurfaceEdges(tiles: readonly TerrainSurfaceTile[], heightOffset = 0,
  persistentPoints?: Map<string, THREE.Vector3>):
  Map<TerrainSurfaceTile, Map<number, THREE.Vector3>> {
  const vertical = new Map<number, Edge[]>(), horizontal = new Map<number, Edge[]>();
  const put = (map: Map<number, Edge[]>, key: number, edge: Edge) => {
    const list = map.get(key) ?? []; list.push(edge); map.set(key, list);
  };
  for (const tile of tiles) {
    const size = 2 ** tile.id.level;
    const west = tile.id.x / size, east = (tile.id.x + 1) / size;
    const north = tile.id.y / size, south = (tile.id.y + 1) / size;
    const cachePrefix = tile.heightKey === undefined ? undefined :
      `${tile.id.level}/${tile.id.x}/${tile.id.y}/${tile.segments}/${tile.heightKey}/${heightOffset}/`;
    put(vertical, west, { tile, axis: 'x', fixed: west, start: north, end: south, cachePrefix });
    put(vertical, east === 1 ? 0 : east, { tile, axis: 'x', fixed: east, start: north, end: south, cachePrefix });
    put(horizontal, north, { tile, axis: 'y', fixed: north, start: west, end: east, cachePrefix });
    put(horizontal, south, { tile, axis: 'y', fixed: south, start: west, end: east, cachePrefix });
  }
  const pointCache = new Map<string, THREE.Vector3>();
  const rank = (a: Edge, b: Edge) => a.tile.id.level - b.tile.id.level ||
    a.tile.segments - b.tile.segments || a.tile.id.y - b.tile.id.y || a.tile.id.x - b.tile.id.x ||
    a.axis.localeCompare(b.axis);
  // Dyadic intervals permit O(number of distinct LODs) authority lookup,
  // instead of scanning every edge along an entire row for every vertex.
  // At a shared endpoint both adjacent cells participate; the dateline also
  // includes the last cell. Preserve exactly the original canonical rank.
  type LineIndex = Array<{ level: number; cells: Map<number, Edge> }>;
  const indexLines = (lines: Map<number, Edge[]>): Map<number, LineIndex> => {
    const result = new Map<number, LineIndex>();
    for (const [fixed, edges] of lines) {
      const levels = new Map<number, Map<number, Edge>>();
      for (const edge of edges) {
        const level = edge.tile.id.level;
        let cells = levels.get(level);
        if (!cells) { cells = new Map(); levels.set(level, cells); }
        const cell = edge.start * 2 ** level, previous = cells.get(cell);
        if (!previous || rank(edge, previous) < 0) cells.set(cell, edge);
      }
      result.set(fixed, [...levels].sort((a, b) => a[0] - b[0]).map(([level, cells]) => ({ level, cells })));
    }
    return result;
  };
  const verticalIndex = indexLines(vertical), horizontalIndex = indexLines(horizontal);
  const retain = (key: string, value: THREE.Vector3) => {
    if (!persistentPoints) return;
    if (!persistentPoints.has(key) && persistentPoints.size >= 65536)
      persistentPoints.delete(persistentPoints.keys().next().value!);
    persistentPoints.set(key, value);
  };
  const lookup = (line: LineIndex | undefined, coordinate: number, seam = false): Edge | undefined => {
    if (!line) return undefined;
    for (const { level, cells } of line) {
      const size = 2 ** level, scaled = coordinate * size, cell = Math.floor(scaled);
      let best = cells.get(cell);
      const previous = scaled === cell ? cells.get(cell - 1) : undefined;
      if (previous && (!best || rank(previous, best) < 0)) best = previous;
      const wrapped = seam && coordinate === 0 ? cells.get(size - 1) : undefined;
      if (wrapped && (!best || rank(wrapped, best) < 0)) best = wrapped;
      if (best) return best;
    }
    return undefined;
  };
  const point = (x: number, y: number): THREE.Vector3 => {
    const wrappedX = x === 1 ? 0 : x;
    const key = `${wrappedX}/${y}`;
    const cached = pointCache.get(key);
    if (cached) return cached;
    const v = lookup(verticalIndex.get(wrappedX), y);
    const h = lookup(horizontalIndex.get(y), wrappedX, true);
    const authority = v && h ? rank(v, h) <= 0 ? v : h : v ?? h;
    if (!authority) throw new Error('Terrain edge point has no authority');
    const coordinate = authority.axis === 'x' ? y : wrappedX === 0 && authority.end === 1 ? 1 : wrappedX;
    const sample = (coordinate - authority.start) / (authority.end - authority.start) * authority.tile.segments;
    const lower = Math.floor(sample + 1e-8), fraction = sample - lower;
    let result: THREE.Vector3;
    if (Math.abs(fraction) > 1e-8 && lower < authority.tile.segments) {
      const a = authority.start + lower / authority.tile.segments * (authority.end - authority.start);
      const b = authority.start + (lower + 1) / authority.tile.segments * (authority.end - authority.start);
      const first = authority.axis === 'x' ? point(authority.fixed, a) : point(a, authority.fixed);
      const second = authority.axis === 'x' ? point(authority.fixed, b) : point(b, authority.fixed);
      const retained = persistentPoints?.get(key), metadata = retained && retainedBindings.get(retained);
      if (metadata?.first === first && metadata.second === second && metadata.fraction === fraction) result = retained!;
      else {
        result = first.clone().lerp(second, fraction);
        retainedBindings.set(result, { first, second, fraction }); retain(key, result);
      }
    } else {
      const binding = authority.cachePrefix;
      const retained = binding === undefined ? undefined : persistentPoints?.get(key);
      if (retained && retainedBindings.get(retained)?.binding === binding) {
        pointCache.set(key, retained); return retained;
      }
      const size = 2 ** authority.tile.id.level;
      const localX = authority.tile.id.x === size - 1 && wrappedX === 0 ? 1 : wrappedX;
      const u = Math.min(1, Math.max(0, localX * size - authority.tile.id.x));
      const v = Math.min(1, Math.max(0, y * size - authority.tile.id.y));
      result = Ellipsoid.WGS84.cartographicToCartesian({ longitude: wrappedX * 360 - 180,
        latitude: Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI,
        height: authority.tile.height(u, v) + heightOffset });
      if (binding !== undefined) { retainedBindings.set(result, { binding }); retain(key, result); }
    }
    pointCache.set(key, result);
    return result;
  };
  const result = new Map<TerrainSurfaceTile, Map<number, THREE.Vector3>>();
  for (const tile of tiles) {
    const boundary = new Map<number, THREE.Vector3>(), size = 2 ** tile.id.level, n = tile.segments;
    const write = (u: number, v: number, index: number) => {
      boundary.set(index, point((tile.id.x + u) / size, (tile.id.y + v) / size));
    };
    for (let step = 0; step <= n; step++) {
      const fraction = step / n;
      write(fraction, 0, step); write(fraction, 1, n * (n + 1) + step);
      write(0, fraction, step * (n + 1)); write(1, fraction, step * (n + 1) + n);
    }
    result.set(tile, boundary);
  }
  return result;
}
