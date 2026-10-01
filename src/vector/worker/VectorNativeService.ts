import NativeWorker from './VectorNativeWorker?worker&inline';
import { SerialWorkerClient } from '../../core/workers/SerialWorkerClient';
import { VectorStyleRuntime, type VectorStyleIssue } from '../style/VectorStyleRuntime';
import { buildNativeBuckets, type NativeBucket } from './VectorNativeBuild';
import type { MapStyle, DecodedVectorTile } from '../style/VectorStyleTypes';
import type { TileId } from '../../core/tiling/GeographicTilingScheme';
export class VectorNativeService {
  private readonly client = new SerialWorkerClient(() => new NativeWorker());
  private runtime: VectorStyleRuntime | null = null;
  private types = new Set<string>();
  private disposed = false;
  async initialize(style: MapStyle, types: ReadonlySet<string>): Promise<VectorStyleIssue[]> {
    this.types = new Set(types);
    if (this.client.available) return (await this.client.request<{ issues: VectorStyleIssue[] }>({ style, types: [...types] })).issues;
    console.warn('[Native vector] Worker unavailable; compatibility geometry build');
    this.runtime = new VectorStyleRuntime(style, types); return this.runtime.issues;
  }
  async build(decoded: DecodedVectorTile, tileId: TileId, sourceId: string, signal?: AbortSignal): Promise<NativeBucket[]> {
    signal?.throwIfAborted(); if (this.disposed) throw new Error('Native service disposed');
    if (this.client.available) return (await this.client.request<{ buckets: NativeBucket[] }>({ decoded, tileId, sourceId }, signal)).buckets;
    if (!this.runtime) throw new Error('Native worker failed');
    await new Promise<void>(resolve => setTimeout(resolve, 0)); signal?.throwIfAborted();
    return buildNativeBuckets(this.runtime, decoded, tileId, sourceId, this.types);
  }
  dispose(): void { this.disposed = true; this.client.dispose(); this.runtime = null; }
}
