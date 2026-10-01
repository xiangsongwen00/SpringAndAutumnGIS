import * as THREE from 'three';
import { Ellipsoid } from '../geo/Ellipsoid';
import type { TileId } from '../tiling/GeographicTilingScheme';

export type TerrainSurfaceTile = {
  id: TileId;
  segments: number;
  /** Same resolved DEM/ancestor and exaggeration as the vertex shader. */
  height: (u: number, v: number) => number;
};
type Edge = { tile: TerrainSurfaceTile; axis: 'x' | 'y'; fixed: number; start: number; end: number };

/** Reconcile the actual rendered ECEF polylines, not merely DEM texels.
 * Fine T-junctions lie on the coarse edge's straight segment. Shared corners
 * use one canonical authority, including mixed-LOD and ancestor fallback.
 */
export function terrainSurfaceEdges(tiles: readonly TerrainSurfaceTile[], heightOffset = 0):
  Map<TerrainSurfaceTile, Map<number, THREE.Vector3>> {
  const vertical = new Map<number, Edge[]>(), horizontal = new Map<number, Edge[]>();
  const put = (map: Map<number, Edge[]>, key: number, edge: Edge) => {
    const list = map.get(key) ?? []; list.push(edge); map.set(key, list);
  };
  for (const tile of tiles) {
    const size = 2 ** tile.id.level;
    const west = tile.id.x / size, east = (tile.id.x + 1) / size;
    const north = tile.id.y / size, south = (tile.id.y + 1) / size;
    put(vertical, west, { tile, axis: 'x', fixed: west, start: north, end: south });
    put(vertical, east === 1 ? 0 : east, { tile, axis: 'x', fixed: east, start: north, end: south });
    put(horizontal, north, { tile, axis: 'y', fixed: north, start: west, end: east });
    put(horizontal, south, { tile, axis: 'y', fixed: south, start: west, end: east });
  }
  const pointCache = new Map<string, THREE.Vector3>();
  const rank = (a: Edge, b: Edge) => a.tile.id.level - b.tile.id.level ||
    a.tile.segments - b.tile.segments || a.tile.id.y - b.tile.id.y || a.tile.id.x - b.tile.id.x ||
    a.axis.localeCompare(b.axis);
  // Authority rank is independent of the sampled point. Sort once per edge
  // line, then take the first covering interval instead of allocating and
  // sorting candidate arrays for every vertex on every tile.
  for (const edges of vertical.values()) edges.sort(rank);
  for (const edges of horizontal.values()) edges.sort(rank);
  const point = (x: number, y: number): THREE.Vector3 => {
    const wrappedX = x === 1 ? 0 : x;
    const key = `${wrappedX}/${y}`;
    const cached = pointCache.get(key);
    if (cached) return cached;
    const v = vertical.get(wrappedX)?.find((e) => y >= e.start && y <= e.end);
    const h = horizontal.get(y)?.find((e) => wrappedX >= e.start && wrappedX <= e.end || wrappedX === 0 && e.end === 1);
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
      result = first.clone().lerp(second, fraction);
    } else {
      const size = 2 ** authority.tile.id.level;
      const localX = authority.tile.id.x === size - 1 && wrappedX === 0 ? 1 : wrappedX;
      const u = Math.min(1, Math.max(0, localX * size - authority.tile.id.x));
      const v = Math.min(1, Math.max(0, y * size - authority.tile.id.y));
      result = Ellipsoid.WGS84.cartographicToCartesian({ longitude: wrappedX * 360 - 180,
        latitude: Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI,
        height: authority.tile.height(u, v) + heightOffset });
    }
    pointCache.set(key, result);
    return result;
  };
  const result = new Map<TerrainSurfaceTile, Map<number, THREE.Vector3>>();
  for (const tile of tiles) {
    const boundary = new Map<number, THREE.Vector3>(), size = 2 ** tile.id.level, n = tile.segments;
    for (let step = 0; step <= n; step++) {
      for (const [u, v] of [[step / n, 0], [step / n, 1], [0, step / n], [1, step / n]] as const) {
        const x = (tile.id.x + u) / size, y = (tile.id.y + v) / size;
        boundary.set(Math.round(v * n) * (n + 1) + Math.round(u * n), point(x, y));
      }
    }
    result.set(tile, boundary);
  }
  return result;
}
