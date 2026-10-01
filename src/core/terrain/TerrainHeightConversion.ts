export type TerrainHeightField = { width: number; height: number; heights: Float32Array;
  minimumHeight: number; maximumHeight: number; conversionMs: number };

/** Identical XYZ north-to-south endpoint sampling in worker and fallback. */
export async function convertTerrainPixels(pixels: Uint8ClampedArray, sourceWidth: number, sourceHeight: number,
  encoding: 'mapbox' | 'terrarium', yieldControl?: () => Promise<void>): Promise<TerrainHeightField> {
  const started = performance.now();
  if (sourceWidth < 1 || sourceHeight < 1 || pixels.length !== sourceWidth * sourceHeight * 4) {
    throw new Error('Invalid Terrain-RGB dimensions');
  }
  const source = new Float32Array(sourceWidth * sourceHeight);
  let minimumHeight = Infinity, maximumHeight = -Infinity;
  for (let y = 0; y < sourceHeight; y++) {
    for (let x = 0; x < sourceWidth; x++) {
      const index = y * sourceWidth + x, pixel = index * 4;
      const red = pixels[pixel]!, green = pixels[pixel + 1]!, blue = pixels[pixel + 2]!;
      const value = encoding === 'terrarium' ? red * 256 + green + blue / 256 - 32768
        : -10000 + (red * 65536 + green * 256 + blue) * .1;
      source[index] = value;
      minimumHeight = Math.min(minimumHeight, value); maximumHeight = Math.max(maximumHeight, value);
    }
    if (yieldControl && y % 16 === 15) await yieldControl();
  }
  const width = sourceWidth > 1 ? 257 : 1, height = sourceHeight > 1 ? 257 : 1;
  const heights = width === sourceWidth && height === sourceHeight ? source : new Float32Array(width * height);
  if (heights !== source) for (let y = 0; y < height; y++) {
    const sy = height === 1 ? 0 : y / (height - 1) * (sourceHeight - 1);
    const y0 = Math.floor(sy), y1 = Math.min(sourceHeight - 1, y0 + 1), ty = sy - y0;
    for (let x = 0; x < width; x++) {
      const sx = width === 1 ? 0 : x / (width - 1) * (sourceWidth - 1);
      const x0 = Math.floor(sx), x1 = Math.min(sourceWidth - 1, x0 + 1), tx = sx - x0;
      const a = source[y0 * sourceWidth + x0]!, b = source[y0 * sourceWidth + x1]!;
      const c = source[y1 * sourceWidth + x0]!, d = source[y1 * sourceWidth + x1]!;
      // Keep the old THREE.MathUtils.lerp operation order, including rounding.
      const north = (1 - tx) * a + tx * b, south = (1 - tx) * c + tx * d;
      heights[y * width + x] = (1 - ty) * north + ty * south;
    }
    if (yieldControl && y % 16 === 15) await yieldControl();
  }
  return { width, height, heights, minimumHeight, maximumHeight, conversionMs: performance.now() - started };
}
