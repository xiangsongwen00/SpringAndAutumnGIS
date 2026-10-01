import { VectorStyleRuntime } from '../style/VectorStyleRuntime';
import type { MapStyle, DecodedVectorTile } from '../style/VectorStyleTypes';
import type { TileId } from '../../core/tiling/GeographicTilingScheme';
import { buildNativeBuckets } from './VectorNativeBuild';
let runtime: VectorStyleRuntime | null = null, types = new Set<string>();
const scope = globalThis as unknown as { onmessage: (event: MessageEvent<{
  id: number; style?: MapStyle; types?: string[]; decoded: DecodedVectorTile; tileId: TileId; sourceId: string
}>) => void; postMessage: (message: unknown, transfer?: Transferable[]) => void };
scope.onmessage = ({ data }) => {
  try {
    if (data.style) {
      types = new Set(data.types);
      runtime = new VectorStyleRuntime(data.style, types);
      scope.postMessage({ id: data.id, result: { issues: runtime.issues } }); return;
    }
    if (!runtime) throw new Error('Native worker not initialized');
    const started = performance.now();
    const buckets = buildNativeBuckets(runtime, data.decoded, data.tileId, data.sourceId, types);
    const transfer: Transferable[] = [];
    for (const bucket of buckets) for (const geometry of [bucket.geometry, bucket.outline]) if (geometry) {
      transfer.push(geometry.positions.buffer, geometry.uvs.buffer, geometry.indices.buffer);
    }
    scope.postMessage({ id: data.id, result: { buckets, buildMs: performance.now() - started } }, transfer);
  } catch (error) { scope.postMessage({ id: data.id, error: String(error) }); }
};
