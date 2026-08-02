import type { TileId } from '../tiling/GeographicTilingScheme';
import type * as THREE from 'three';

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
  attribution?: string;
  subdomains?: readonly string[];
};

/** XYZ URL template provider supporting {z}, {x}, {y} and optional {s}. */
export class UrlTemplateRasterProvider implements RasterTileProvider {
  readonly id: string;
  readonly minLevel: number;
  readonly maxLevel: number;
  readonly levelOffset: number;
  readonly attribution?: string;
  private readonly urlTemplate: string;
  private readonly subdomains: readonly string[];

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
    this.attribution = options.attribution;
    this.urlTemplate = options.urlTemplate;
    this.subdomains = options.subdomains ?? [];
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
