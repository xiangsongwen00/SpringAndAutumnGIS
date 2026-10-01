import { convertTerrainPixels } from './TerrainHeightConversion';
const scope = globalThis as unknown as { onmessage: (event: MessageEvent<{
  id: number; blob?: Blob; pixels?: Uint8ClampedArray; width?: number; height?: number; encoding: 'mapbox' | 'terrarium'
}>) => void; postMessage: (message: unknown, transfer?: Transferable[]) => void };
scope.onmessage = async ({ data }) => {
  try {
    let pixels = data.pixels, width = data.width, height = data.height;
    if (!pixels) {
      if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
        scope.postMessage({ id: data.id, result: { needsPixels: true } }); return;
      }
      const bitmap = await createImageBitmap(data.blob!);
      try {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('Worker 2D canvas unavailable');
        context.drawImage(bitmap, 0, 0); width = bitmap.width; height = bitmap.height;
        pixels = context.getImageData(0, 0, width, height).data;
      } finally { bitmap.close(); }
    }
    const result = await convertTerrainPixels(pixels, width!, height!, data.encoding);
    scope.postMessage({ id: data.id, result }, [result.heights.buffer]);
  } catch (error) { scope.postMessage({ id: data.id, error: String(error) }); }
};
