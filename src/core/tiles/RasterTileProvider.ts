import type { TileId } from '../tiling/GeographicTilingScheme';

export interface RasterTileProvider {
  readonly id: string;
  readonly minLevel: number;
  readonly maxLevel: number;
  readonly attribution?: string;
  url(tile: TileId): string;
}

export type UrlTemplateRasterProviderOptions = {
  id?: string;
  urlTemplate: string;
  minLevel?: number;
  maxLevel?: number;
  attribution?: string;
  subdomains?: readonly string[];
};

/** XYZ URL template provider supporting {z}, {x}, {y} and optional {s}. */
export class UrlTemplateRasterProvider implements RasterTileProvider {
  readonly id: string;
  readonly minLevel: number;
  readonly maxLevel: number;
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

