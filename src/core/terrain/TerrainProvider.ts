import * as THREE from 'three';
import type { TileId } from '../tiling/GeographicTilingScheme';

export type TerrainTileScheme = 'xyz' | 'tms';
export type TerrainRgbEncoding = 'mapbox' | 'terrarium';

export type TerrainTileData = {
  readonly id: TileId;
  readonly width: number;
  readonly height: number;
  readonly heights: Float32Array;
  readonly minimumHeight: number;
  readonly maximumHeight: number;
  readonly texture: THREE.DataTexture;
};

export interface TerrainProvider {
  readonly id: string;
  readonly minLevel: number;
  readonly maxLevel: number;
  readonly attribution?: string;
  loadTile(tile: TileId): Promise<TerrainTileData>;
}

export type TerrainRgbProviderOptions = {
  id?: string;
  /** Ordered failover templates. Tile coordinates passed to the provider stay XYZ. */
  urlTemplates?: readonly string[];
  /** Optional TileJSON endpoint. Its tiles/minzoom/maxzoom/scheme fill missing options. */
  tileJsonUrl?: string;
  scheme?: TerrainTileScheme;
  encoding?: TerrainRgbEncoding;
  minLevel?: number;
  maxLevel?: number;
  attribution?: string;
  noDataHeight?: number;
};

type TileJson = {
  tiles?: string[];
  minzoom?: number;
  maxzoom?: number;
  scheme?: TerrainTileScheme;
  attribution?: string;
};

/** Loads Terrain-RGB pixels into a CPU-queryable float heightfield and GPU texture. */
export class TerrainRgbProvider implements TerrainProvider {
  readonly id: string;
  readonly minLevel: number;
  readonly attribution?: string;

  private readonly configuredTemplates: readonly string[];
  private readonly tileJsonUrl?: string;
  private readonly configuredScheme?: TerrainTileScheme;
  private readonly encoding: TerrainRgbEncoding;
  private readonly configuredMaxLevel: number;
  private readonly noDataHeight: number;
  private metadataPromise: Promise<Required<Pick<TileJson, 'tiles' | 'scheme'>> & TileJson> | null = null;
  private resolvedMaxLevel: number;

  constructor(options: TerrainRgbProviderOptions) {
    if ((!options.urlTemplates || options.urlTemplates.length === 0) && !options.tileJsonUrl) {
      throw new Error('TerrainRgbProvider 至少需要一个 URL 模板或 TileJSON 地址。');
    }
    this.id = options.id ?? 'terrain-rgb';
    this.minLevel = Math.max(0, Math.round(options.minLevel ?? 0));
    this.configuredMaxLevel = Math.max(this.minLevel, Math.round(options.maxLevel ?? 14));
    this.resolvedMaxLevel = this.configuredMaxLevel;
    this.attribution = options.attribution;
    this.configuredTemplates = options.urlTemplates ?? [];
    this.tileJsonUrl = options.tileJsonUrl;
    this.configuredScheme = options.scheme;
    this.encoding = options.encoding ?? 'mapbox';
    this.noDataHeight = options.noDataHeight ?? 0;
  }

  get maxLevel(): number {
    return this.resolvedMaxLevel;
  }

  async loadTile(tile: TileId): Promise<TerrainTileData> {
    const metadata = await this.metadata();
    const level = Math.min(tile.level, this.maxLevel);
    const sourceTile = level === tile.level
      ? tile
      : {
          level,
          x: Math.floor(tile.x / 2 ** (tile.level - level)),
          y: Math.floor(tile.y / 2 ** (tile.level - level))
        };
    let sawNoData = false;
    let lastError: unknown;
    for (const template of metadata.tiles) {
      const url = resolveTerrainUrl(template, sourceTile, metadata.scheme);
      try {
        const response = await fetch(url);
        if (response.status === 404 || response.status === 204) {
          sawNoData = true;
          continue;
        }
        if (!response.ok) throw new Error(`地形请求失败：${response.status} ${url}`);
        return await decodeTerrainImage(sourceTile, await response.blob(), this.encoding);
      } catch (error) {
        lastError = error;
      }
    }
    if (sawNoData && !lastError) return createFlatTerrainTile(sourceTile, this.noDataHeight);
    throw lastError ?? new Error(`地形瓦片 ${sourceTile.level}/${sourceTile.x}/${sourceTile.y} 没有可用数据。`);
  }

  private async metadata(): Promise<Required<Pick<TileJson, 'tiles' | 'scheme'>> & TileJson> {
    return this.metadataPromise ??= this.loadMetadata();
  }

  private async loadMetadata(): Promise<Required<Pick<TileJson, 'tiles' | 'scheme'>> & TileJson> {
    let tileJson: TileJson = {};
    if (this.tileJsonUrl) {
      try {
        const response = await fetch(this.tileJsonUrl);
        if (!response.ok) throw new Error(`地形 TileJSON 加载失败：${response.status}`);
        tileJson = await response.json() as TileJson;
      } catch (error) {
        if (this.configuredTemplates.length === 0) throw error;
      }
    }
    const tiles = [...new Set([...this.configuredTemplates, ...(tileJson.tiles ?? [])])];
    if (tiles.length === 0) throw new Error('地形 TileJSON 没有 tiles 模板。');
    const metadataMaximum = Number.isFinite(tileJson.maxzoom)
      ? Math.round(tileJson.maxzoom!)
      : this.configuredMaxLevel;
    this.resolvedMaxLevel = Math.max(
      this.minLevel,
      Math.min(this.configuredMaxLevel, metadataMaximum)
    );
    return {
      ...tileJson,
      tiles,
      scheme: this.configuredScheme ?? tileJson.scheme ?? 'xyz'
    };
  }
}

export function sampleTerrainTile(data: TerrainTileData, u: number, v: number): number {
  const x = THREE.MathUtils.clamp(u, 0, 1) * (data.width - 1);
  const y = THREE.MathUtils.clamp(v, 0, 1) * (data.height - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(data.width - 1, x0 + 1);
  const y1 = Math.min(data.height - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const northWest = data.heights[y0 * data.width + x0] ?? 0;
  const northEast = data.heights[y0 * data.width + x1] ?? northWest;
  const southWest = data.heights[y1 * data.width + x0] ?? northWest;
  const southEast = data.heights[y1 * data.width + x1] ?? southWest;
  return THREE.MathUtils.lerp(
    THREE.MathUtils.lerp(northWest, northEast, tx),
    THREE.MathUtils.lerp(southWest, southEast, tx),
    ty
  );
}

/** Decode one RGB triplet without requiring DOM image APIs; useful for tests and workers. */
export function decodeTerrainRgbHeight(
  red: number,
  green: number,
  blue: number,
  encoding: TerrainRgbEncoding = 'mapbox'
): number {
  return encoding === 'terrarium'
    ? red * 256 + green + blue / 256 - 32768
    : -10_000 + (red * 256 * 256 + green * 256 + blue) * 0.1;
}

function resolveTerrainUrl(template: string, tile: TileId, scheme: TerrainTileScheme): string {
  const y = scheme === 'tms' ? 2 ** tile.level - 1 - tile.y : tile.y;
  return template
    .split('{z}').join(String(tile.level))
    .split('{x}').join(String(tile.x))
    .split('{y}').join(String(y));
}

async function decodeTerrainImage(
  id: TileId,
  blob: Blob,
  encoding: TerrainRgbEncoding
): Promise<TerrainTileData> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    bitmap.close();
    throw new Error('当前浏览器无法读取 Terrain-RGB 像素。');
  }
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const heights = new Float32Array(canvas.width * canvas.height);
  let minimumHeight = Number.POSITIVE_INFINITY;
  let maximumHeight = Number.NEGATIVE_INFINITY;
  for (let pixel = 0, index = 0; pixel < pixels.length; pixel += 4, index += 1) {
    const red = pixels[pixel] ?? 0;
    const green = pixels[pixel + 1] ?? 0;
    const blue = pixels[pixel + 2] ?? 0;
    const height = decodeTerrainRgbHeight(red, green, blue, encoding);
    heights[index] = height;
    minimumHeight = Math.min(minimumHeight, height);
    maximumHeight = Math.max(maximumHeight, height);
  }
  const normalized = normalizeDyadicHeightGrid(heights, canvas.width, canvas.height);
  return createTerrainTile(
    id,
    normalized.width,
    normalized.height,
    normalized.heights,
    minimumHeight,
    maximumHeight
  );
}

function createFlatTerrainTile(id: TileId, height: number): TerrainTileData {
  return createTerrainTile(id, 1, 1, new Float32Array([height]), height, height);
}

function createTerrainTile(
  id: TileId,
  width: number,
  height: number,
  heights: Float32Array,
  minimumHeight: number,
  maximumHeight: number
): TerrainTileData {
  const texture = new THREE.DataTexture(heights, width, height, THREE.RedFormat, THREE.FloatType);
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  // Linear sampling makes the stitched border profile continuous at geometry
  // vertices. Nearest filtering can select opposite texels on the two sides.
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return { id, width, height, heights, minimumHeight, maximumHeight, texture };
}

/**
 * A 256-sample edge has 255 intervals and cannot nest exactly under quadtree
 * subdivision. 257 samples produce 256 dyadic cells, so parent/child edge
 * vertices coincide at every level transition.
 */
function normalizeDyadicHeightGrid(
  source: Float32Array,
  sourceWidth: number,
  sourceHeight: number
): { width: number; height: number; heights: Float32Array } {
  // The rendered regular grid needs 256 dyadic cells, not one vertex per
  // source image pixel. Keeping a 512px Terrain-RGB source as 513x513 makes a
  // tile four times heavier while providing detail the current mesh cannot
  // consume. A fixed 257x257 endpoint grid also guarantees parent/child
  // coincidence and makes resource budgeting independent of provider size.
  const width = sourceWidth > 1 ? 257 : 1;
  const height = sourceHeight > 1 ? 257 : 1;
  if (width === sourceWidth && height === sourceHeight) {
    return { width, height, heights: source };
  }
  const heights = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const sourceY = height <= 1 ? 0 : (y / (height - 1)) * (sourceHeight - 1);
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(sourceHeight - 1, y0 + 1);
    const ty = sourceY - y0;
    for (let x = 0; x < width; x += 1) {
      const sourceX = width <= 1 ? 0 : (x / (width - 1)) * (sourceWidth - 1);
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(sourceWidth - 1, x0 + 1);
      const tx = sourceX - x0;
      const northWest = source[y0 * sourceWidth + x0] ?? 0;
      const northEast = source[y0 * sourceWidth + x1] ?? northWest;
      const southWest = source[y1 * sourceWidth + x0] ?? northWest;
      const southEast = source[y1 * sourceWidth + x1] ?? southWest;
      heights[y * width + x] = THREE.MathUtils.lerp(
        THREE.MathUtils.lerp(northWest, northEast, tx),
        THREE.MathUtils.lerp(southWest, southEast, tx),
        ty
      );
    }
  }
  return { width, height, heights };
}
