import { MvtDecoder } from '../decoder/MvtDecoder';
import DecodeWorker from './VectorDecodeWorker?worker&inline';
import type { DecodedVectorTile } from '../style/VectorStyleTypes';

/** PBF transport boundary; geometry/style phases can move behind the same worker protocol. */
export class VectorDecodeService {
  private worker: Worker | null = null;
  private nextId = 0;
  private disposed = false;
  private readonly pending = new Map<number, {
    resolve: (tile: DecodedVectorTile) => void;
    reject: (reason: Error) => void;
  }>();

  constructor() {
    if (typeof Worker === 'undefined') return;
    this.worker = new DecodeWorker();
    this.worker.onmessage = (event: MessageEvent<{
      id: number; tile?: DecodedVectorTile; error?: string;
    }>) => {
      const request = this.pending.get(event.data.id);
      if (!request) return;
      this.pending.delete(event.data.id);
      if (event.data.tile) request.resolve(event.data.tile);
      else request.reject(new Error(event.data.error ?? 'MVT Worker decode failed'));
    };
    this.worker.onerror = (event) => {
      for (const request of this.pending.values()) request.reject(new Error(event.message));
      this.pending.clear();
    };
  }

  decode(bytes: ArrayBuffer, layers?: ReadonlySet<string>): Promise<DecodedVectorTile> {
    if (this.disposed) return Promise.reject(new Error('Vector decoder disposed'));
    if (!this.worker) return Promise.resolve(new MvtDecoder().decode(bytes, layers));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ id, bytes, layers: layers ? [...layers] : undefined }, [bytes]);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.worker?.terminate();
    for (const request of this.pending.values()) request.reject(new Error('Vector decoder disposed'));
    this.pending.clear();
  }
}
