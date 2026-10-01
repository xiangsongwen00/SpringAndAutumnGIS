import { buildFillGeometry, buildLineStrokeGeometry, buildPointGeometry } from '../bucket/VectorGeometryBuilder';
import type { TileId } from '../../core/tiling/GeographicTilingScheme';
import type { DecodedVectorTile, StyleLayer } from '../style/VectorStyleTypes';
import { VectorStyleRuntime } from '../style/VectorStyleRuntime';

export type SurfaceChunk = { layer: StyleLayer; order: number; positions: Float32Array; distances: Float32Array;
  indices: Uint16Array; bytes: number };
export type SurfaceBuildInput = { sourceId: string; sourceTile: TileId; zoom: number;
  offset: { x: number; y: number }; scale: number; tileSize: number; decoded: DecodedVectorTile };
export type SurfacePlan = { chunks: SurfaceChunk[]; buildMs: number; bytes: number };
const types = new Set(['background', 'fill', 'line', 'circle']);

export function buildSurfacePlan(runtime: VectorStyleRuntime, input: SurfaceBuildInput): SurfacePlan {
  const started = performance.now();
  const { sourceTile, offset, scale, tileSize } = input;
  const visible = scale === 1 ? input.decoded : filterToSubtile(input.decoded, offset, scale, tileSize);
  const buckets = runtime.buckets(visible, input.sourceId, input.zoom, types);
  const drawBuckets = buckets.flatMap(bucket => {
    const outline = bucket.layer.paint?.['fill-outline-color'];
    return bucket.layer.type === 'fill' && outline ? [bucket, { ...bucket, order: bucket.order + .001,
      layer: { ...bucket.layer, type: 'line', paint: { 'line-color': outline,
        'line-opacity': bucket.layer.paint?.['fill-opacity'] ?? 1, 'line-width': 1 } } }] : [bucket];
  }).sort((a, b) => a.order - b.order);
  const chunks: SurfaceChunk[] = [];
  let preparedBytes = 0;
  for (const { layer, features, order } of drawBuckets) {
    const type = layer.type;
    const geometry = type === 'fill' ? buildFillGeometry(sourceTile, features, false)
      : type === 'line' ? buildLineStrokeGeometry(sourceTile, features, Number(layer.paint?.['line-width'] ?? 1), tileSize * scale)
      : type === 'circle' ? buildPointGeometry(sourceTile, features) : null;
    const uvs = geometry?.uvs ?? [0, 0, 1, 0, 0, 1, 1, 1];
    const indices = geometry?.indices ?? [0, 1, 2, 1, 3, 2];
    // Even a single huge feature/bucket is split on primitive boundaries in
    // the worker. Bounded transfer buffers also bound first GPU uploads.
    const primitive = type === 'circle' ? 1 : 3;
    const sourceIndices = indices.length ? indices : Array.from({ length: uvs.length / 2 }, (_, index) => index);
    let remap = new Map<number, number>(), positions: number[] = [], distances: number[] = [], localIndices: number[] = [];
    const flush = () => {
      if (!positions.length) return;
      const p = new Float32Array(positions), d = new Float32Array(distances), i = new Uint16Array(localIndices);
      const bytes = p.byteLength + d.byteLength + i.byteLength;
      preparedBytes += bytes;
      if (preparedBytes > 32 * 1024 * 1024) throw new Error('Vector surface plan exceeds 32MiB capacity');
      chunks.push({ layer, order, positions: p, distances: d, indices: i, bytes });
      remap = new Map(); positions = []; distances = []; localIndices = [];
    };
    for (let index = 0; index < sourceIndices.length; index += primitive) {
      // <=4096 vertices and <=16384 indices: at most 96KiB per chunk.
      if (remap.size + primitive > 4096 || localIndices.length + primitive > 16384) flush();
      for (let v = 0; v < primitive; v++) {
        const source = sourceIndices[index + v]; if (source === undefined) continue;
        let target = remap.get(source);
        if (target === undefined) {
          target = remap.size; remap.set(source, target);
          positions.push(uvs[source * 2]!, uvs[source * 2 + 1]!, 0);
          distances.push(geometry?.distances?.[source] ?? 0);
        }
        localIndices.push(target);
      }
    }
    flush();
  }
  return { chunks, buildMs: performance.now() - started, bytes: chunks.reduce((sum, chunk) => sum + chunk.bytes, 0) };
}

export function filterToSubtile(tile: DecodedVectorTile, offset: { x: number; y: number }, scale: number, tileSize: number): DecodedVectorTile {
  const result = new Map(); const padding = 64 / (tileSize * scale);
  for (const [name, features] of tile) result.set(name, features.filter(feature => {
    let west = Infinity, north = Infinity, east = -Infinity, south = -Infinity;
    for (const ring of feature.geometry) for (const point of ring) {
      west = Math.min(west, point.x / feature.extent); east = Math.max(east, point.x / feature.extent);
      north = Math.min(north, point.y / feature.extent); south = Math.max(south, point.y / feature.extent);
    }
    return east >= offset.x - padding && west <= offset.x + 1 / scale + padding &&
      south >= offset.y - padding && north <= offset.y + 1 / scale + padding;
  }));
  return result;
}
