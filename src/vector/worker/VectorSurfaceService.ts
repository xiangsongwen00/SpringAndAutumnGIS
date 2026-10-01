import SurfaceWorker from './VectorSurfaceWorker?worker&inline';
import { SerialWorkerClient } from '../../core/workers/SerialWorkerClient';
import { VectorStyleRuntime, type VectorStyleIssue } from '../style/VectorStyleRuntime';
import type { MapStyle } from '../style/VectorStyleTypes';
import { buildSurfacePlan, type SurfacePlan, type SurfaceBuildInput } from './VectorSurfaceBuild';

export class VectorSurfaceService {
  private readonly client = new SerialWorkerClient(() => new SurfaceWorker());
  private readonly known = new Set<string>();
  private fallback: VectorStyleRuntime | null = null;
  private disposed = false;
  get stats() { return { worker: this.client.available, ...this.client.stats }; }
  async initialize(style: MapStyle): Promise<VectorStyleIssue[]> {
    if (this.client.available) return (await this.client.request<{ issues: VectorStyleIssue[] }>({ style })).issues;
    console.warn('[Vector surface] Worker unavailable; using compatibility main-thread build');
    this.fallback = new VectorStyleRuntime(style, new Set(['background', 'fill', 'line', 'circle']));
    return this.fallback.issues;
  }
  async build(input: SurfaceBuildInput, key: string, signal?: AbortSignal): Promise<SurfacePlan> {
    signal?.throwIfAborted(); if (this.disposed) throw new Error('Surface service disposed');
    if (!this.client.available) {
      if (!this.fallback) throw new Error('Surface worker failed');
      // Compatibility is explicit, not a claim that unavailable workers can
      // guarantee the same latency. Yield before heavy synchronous geometry.
      await new Promise<void>(resolve => setTimeout(resolve, 0)); signal?.throwIfAborted();
      return buildSurfacePlan(this.fallback, input);
    }
    const { decoded, ...parameters } = input;
    let result = await this.client.request<SurfacePlan | { miss: true }>(() => ({ key, input: parameters,
      decoded: this.known.has(key) ? undefined : decoded }), signal);
    if ('miss' in result) result = await this.client.request<SurfacePlan>({ key, input: parameters, decoded }, signal);
    if (this.known.size >= 256) this.known.delete(this.known.values().next().value!);
    this.known.add(key);
    return result;
  }
  dispose(): void { this.disposed = true; this.client.dispose(); this.known.clear(); this.fallback = null; }
}
