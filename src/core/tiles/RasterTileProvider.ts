import type { TileId } from '../tiling/GeographicTilingScheme';
import type * as THREE from 'three';

/** Default continuous mapping: source zoom = floor(camera zoom + offset). */
export const DEFAULT_LEVEL_OFFSET = -1.7;

export interface RasterTileProvider {
  readonly id: string;
  readonly minLevel: number;
  readonly maxLevel: number;
  /** Data zoom = globe LOD zoom + levelOffset. Only zero or negative offsets are supported. */
  readonly levelOffset?: number;
  /** Optional minimum selected globe LOD relative to the current camera level. */
  readonly minimumLodLevelOffset?: number;
  /** Receives the continuous camera level before each selection/update. */
  setViewLevel?(cameraLevel: number): void;
  /** Changes the continuous camera-to-source zoom offset for diagnostics. */
  setViewLevelOffset?(offset: number | null): void;
  /** Current continuous camera-to-source zoom offset. */
  readonly viewLevelOffset?: number | null;
  /** Current integer data zoom selected from the continuous camera level. */
  readonly currentSourceLevel?: number;
  /** Increments when source-level mapping changes without replacing the provider. */
  readonly revision?: number;
  /** Approximate resident GPU bytes reserved by one decoded texture, including mipmaps. */
  readonly estimatedTextureBytes?: number;
  /** Resolves the highest data level allowed for a globe render tile. */
  maximumSourceLevel?(renderLevel: number): number;
  readonly attribution?: string;
  url(tile: TileId): string;
  loadTexture?(tile: TileId): Promise<THREE.Texture>;
}

export type UrlTemplateRasterProviderOptions = {
  id?: string;
  urlTemplate: string;
  minLevel?: number;
  maxLevel?: number;
  levelOffset?: number;
  /** Optional data zoom = floor(camera zoom + offset), e.g. -1.7. */
  viewLevelOffset?: number | null;
  attribution?: string;
  subdomains?: readonly string[];
  tileSize?: number;
};

/** XYZ URL template provider supporting {z}, {x}, {y} and optional {s}. */
export class UrlTemplateRasterProvider implements RasterTileProvider {
  readonly id: string;
  readonly minLevel: number;
  readonly maxLevel: number;
  readonly levelOffset: number;
  readonly estimatedTextureBytes: number;
  readonly attribution?: string;
  private readonly urlTemplate: string;
  private readonly subdomains: readonly string[];
  private _viewLevelOffset: number | null;
  private viewSourceLevel: number;
  private _revision = 0;

  constructor(options: UrlTemplateRasterProviderOptions) {
    if (!options.urlTemplate.includes('{z}') ||
        !options.urlTemplate.includes('{x}') ||
        !options.urlTemplate.includes('{y}')) {
      throw new Error('Raster tile URL must include {z}, {x}, and {y}.');
    }
    this.id = options.id ?? 'raster';
    this.minLevel = Math.max(0, Math.round(options.minLevel ?? 0));
    this.maxLevel = Math.max(this.minLevel, Math.round(options.maxLevel ?? 19));
    this.levelOffset = Math.min(0, Math.round(options.levelOffset ?? 0));
    const tileSize = Math.max(1, Math.round(options.tileSize ?? 256));
    this.estimatedTextureBytes = Math.ceil(tileSize * tileSize * 4 * 4 / 3);
    this.attribution = options.attribution;
    this.urlTemplate = options.urlTemplate;
    this.subdomains = options.subdomains ?? [];
    this._viewLevelOffset = normalizeViewLevelOffset(
      options.viewLevelOffset === undefined ? DEFAULT_LEVEL_OFFSET : options.viewLevelOffset
    );
    this.viewSourceLevel = this.maxLevel;
  }

  get revision(): number {
    return this._revision;
  }

  get currentSourceLevel(): number {
    return this.viewSourceLevel;
  }

  get viewLevelOffset(): number | null {
    return this._viewLevelOffset;
  }

  setViewLevel(cameraLevel: number): void {
    const next = this._viewLevelOffset === null
      ? this.maxLevel
      : clampLevel(floorZoom(cameraLevel + this._viewLevelOffset), this.minLevel, this.maxLevel);
    if (next === this.viewSourceLevel) return;
    this.viewSourceLevel = next;
    this._revision += 1;
  }

  setViewLevelOffset(offset: number | null): void {
    const next = normalizeViewLevelOffset(offset);
    if (next === this._viewLevelOffset) return;
    this._viewLevelOffset = next;
    // The next setViewLevel call resolves the new integer zoom and invalidates
    // the raster queue only if that effective zoom actually changed.
    this.viewSourceLevel = Number.NaN;
  }

  maximumSourceLevel(renderLevel: number): number {
    return Math.min(renderLevel, this.viewSourceLevel, this.maxLevel);
  }

  url(tile: TileId): string {
    const subdomain = this.subdomains.length > 0
      ? this.subdomains[(tile.x + tile.y) % this.subdomains.length] ?? ''
      : '';
    return this.urlTemplate
      .split('{z}').join(String(tile.level))
      .split('{x}').join(String(tile.x))
      .split('{y}').join(String(tile.y))
      .split('{s}').join(subdomain);
  }
}

function normalizeViewLevelOffset(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.max(-8, Math.min(2, value));
}

function clampLevel(level: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, level));
}

function floorZoom(value: number): number {
  return Math.floor(value + 1e-9);
}
