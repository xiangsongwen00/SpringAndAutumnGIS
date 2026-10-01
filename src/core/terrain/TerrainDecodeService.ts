import DecodeWorker from './TerrainDecodeWorker?worker&inline';
import { SerialWorkerClient } from '../workers/SerialWorkerClient';
import { convertTerrainPixels, type TerrainHeightField } from './TerrainHeightConversion';

/** Shared, bounded DEM worker. Releases its worker after 30s idle; layer/provider
 * lifetimes need not take ownership of another user's shared terrain provider.
 */
export class TerrainDecodeService {
  private client: SerialWorkerClient | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private active = 0;
  private conversionMs = 0;
  get stats() { return { worker: this.client?.available ?? false, active: this.active, conversionMs: this.conversionMs,
    ...this.client?.stats }; }
  dispose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null; this.client?.dispose(); this.client = null;
  }
  async decode(blob: Blob, encoding: 'mapbox' | 'terrarium', signal?: AbortSignal): Promise<TerrainHeightField> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.active++;
    try {
      signal?.throwIfAborted();
      const client = this.client ??= new SerialWorkerClient(() => new DecodeWorker(), 32);
      if (client.available) {
        const result = await client.request<TerrainHeightField | { needsPixels: true }>({ blob, encoding }, signal);
        if (!('needsPixels' in result)) { this.conversionMs = result.conversionMs; return result; }
      }
      const bitmap = await createImageBitmap(blob);
      let pixels: Uint8ClampedArray;
      const width = bitmap.width, height = bitmap.height;
      try {
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('Terrain canvas unavailable');
        context.drawImage(bitmap, 0, 0); pixels = context.getImageData(0, 0, width, height).data;
      } finally { bitmap.close(); }
      signal?.throwIfAborted();
      if (client.available) {
        const field = await client.request<TerrainHeightField>({ pixels, width, height, encoding }, signal, [pixels.buffer]);
        this.conversionMs = field.conversionMs; return field;
      }
      console.warn('[Terrain] Worker unavailable; using cooperative conversion fallback');
      const field = await convertTerrainPixels(pixels, width, height, encoding, async () => {
        signal?.throwIfAborted(); await new Promise<void>(resolve => setTimeout(resolve, 0));
      });
      this.conversionMs = field.conversionMs; return field;
    } finally {
      this.active--;
      if (!this.active && this.client?.available) this.idleTimer = setTimeout(() => {
        this.client?.dispose(); this.client = null; this.idleTimer = null;
      }, 30000);
    }
  }
}
export const terrainDecodeService = new TerrainDecodeService();
