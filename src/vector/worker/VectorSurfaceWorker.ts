import { VectorStyleRuntime } from '../style/VectorStyleRuntime';
import type { MapStyle, DecodedVectorTile } from '../style/VectorStyleTypes';
import { buildSurfacePlan, type SurfaceBuildInput } from './VectorSurfaceBuild';
let runtime: VectorStyleRuntime | null = null;
const cache = new Map<string, { decoded: DecodedVectorTile; bytes: number }>();
let cacheBytes = 0;
const scope = globalThis as unknown as { onmessage: (event: MessageEvent<{
  id: number; style?: MapStyle; key: string; input: Omit<SurfaceBuildInput, 'decoded'>; decoded?: DecodedVectorTile
}>) => void; postMessage: (message: unknown, transfer?: Transferable[]) => void };
scope.onmessage = ({ data }) => {
  try {
    if (data.style) {
      runtime = new VectorStyleRuntime(data.style, new Set(['background', 'fill', 'line', 'circle']));
      scope.postMessage({ id: data.id, result: { issues: runtime.issues } }); return;
    }
    if (!runtime) throw new Error('Surface worker not initialized');
    let entry = cache.get(data.key);
    if (data.decoded) {
      let bytes = 0;
      for (const features of data.decoded.values()) for (const feature of features) {
        bytes += 128 + JSON.stringify(feature.properties).length * 2;
        for (const ring of feature.geometry) bytes += ring.length * 32;
      }
      if (entry) cacheBytes -= entry.bytes;
      entry = { decoded: data.decoded, bytes }; cache.set(data.key, entry); cacheBytes += bytes;
    }
    if (!entry) { scope.postMessage({ id: data.id, result: { miss: true } }); return; }
    cache.delete(data.key); cache.set(data.key, entry);
    const plan = buildSurfacePlan(runtime, { ...data.input, decoded: entry.decoded });
    while (cache.size > 256 || cacheBytes > 32 * 1024 * 1024) {
      const key = cache.keys().next().value!; cacheBytes -= cache.get(key)!.bytes; cache.delete(key);
    }
    scope.postMessage({ id: data.id, result: plan }, plan.chunks.flatMap(chunk =>
      [chunk.positions.buffer, chunk.distances.buffer, chunk.indices.buffer]));
  } catch (error) { scope.postMessage({ id: data.id, error: String(error) }); }
};
