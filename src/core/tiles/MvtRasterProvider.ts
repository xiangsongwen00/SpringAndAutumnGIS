import * as THREE from 'three';
import type { TileId } from '../tiling/GeographicTilingScheme';
import {
  DEFAULT_LEVEL_OFFSET,
  type RasterTileProvider
} from './RasterTileProvider';
import { MvtDecoder } from '../../vector/decoder/MvtDecoder';
import { CanvasVectorRasterizer } from '../../vector/raster/CanvasVectorRasterizer';
import { MvtTileSource } from '../../vector/source/MvtTileSource';
import { MapStyleLoader } from '../../vector/style/MapStyleLoader';
import type { MapStyleCapabilityReport } from '../../vector/style/MapStyleLoader';
import type { MapStyle, VectorSource } from '../../vector/style/VectorStyleTypes';

export type MvtRasterProviderOptions = Readonly<{
  id?: string;
  urlTemplate?: string;
  tileJsonUrl?: string;
  styleUrl?: string;
  style?: MapStyle;
  sourceId?: string;
  scheme?: 'xyz' | 'tms';
  subdomains?: readonly string[];
  minLevel?: number;
  maxLevel?: number;
  levelOffset?: number;
  viewLevelOffset?: number | null;
  minimumLodLevelOffset?: number;
  showCountryLabels?: boolean;
  tileSize?: number;
  bounds?: readonly [number, number, number, number];
  attribution?: string;
  fetcher?: typeof fetch;
}>;

/**
 * Generic MVT compatibility provider.
 *
 * It preserves vector decoding and custom Style v8 evaluation, then produces a
 * transparent raster tile so the existing surface compositor can drape it on
 * the exact same terrain mesh as imagery.
 */
export class MvtRasterProvider implements RasterTileProvider {
  readonly id: string;
  readonly minLevel: number;
  readonly maxLevel: number;
  readonly levelOffset: number;
  readonly minimumLodLevelOffset: number;
  readonly estimatedTextureBytes: number;
  readonly attribution?: string;

  private readonly styleLoader: MapStyleLoader;
  private readonly decoder = new MvtDecoder();
  private readonly rasterizer: CanvasVectorRasterizer;
  private readonly directSource?: VectorSource;
  private readonly bounds?: readonly [number, number, number, number];
  private readonly fetcher?: typeof fetch;
  private source: MvtTileSource | null = null;
  private viewSourceLevel: number;
  private _viewLevelOffset: number | null;
  private _revision = 0;

  constructor(options: MvtRasterProviderOptions) {
    if (!options.urlTemplate && !options.tileJsonUrl && !options.style && !options.styleUrl) {
      throw new Error('MVT 数据源必须提供 urlTemplate、tileJsonUrl 或带矢量 source 的样式。');
    }
    this.id = options.id ?? 'mvt-raster';
    this.minLevel = Math.max(0, Math.round(options.minLevel ?? 0));
    this.maxLevel = Math.max(this.minLevel, Math.round(options.maxLevel ?? 20));
    this._viewLevelOffset = normalizeViewLevelOffset(
      options.viewLevelOffset ?? options.levelOffset ?? DEFAULT_LEVEL_OFFSET
    );
    this.levelOffset = Math.min(0, Math.round(this._viewLevelOffset ?? 0));
    this.minimumLodLevelOffset = Math.min(0, Math.round(options.minimumLodLevelOffset ?? -1));
    this.attribution = options.attribution;
    const tileSize = Math.max(256, Math.round(options.tileSize ?? 512));
    this.estimatedTextureBytes = tileSize * tileSize * 4;
    this.styleLoader = new MapStyleLoader({
      styleUrl: options.styleUrl,
      style: options.style,
      sourceId: options.sourceId,
      fetcher: options.fetcher
    });
    this.rasterizer = new CanvasVectorRasterizer({
      tileSize,
      showCountryLabels: options.showCountryLabels
    });
    this.directSource = options.urlTemplate || options.tileJsonUrl
      ? {
          type: 'vector',
          tiles: options.urlTemplate ? [options.urlTemplate] : undefined,
          url: options.tileJsonUrl,
          minzoom: this.minLevel,
          maxzoom: this.maxLevel,
          scheme: options.scheme,
          subdomains: options.subdomains
        }
      : undefined;
    this.bounds = options.bounds ? normalizeBounds(options.bounds) : undefined;
    this.fetcher = options.fetcher;
    this.viewSourceLevel = this.minLevel;
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
      : THREE.MathUtils.clamp(
          Math.floor(cameraLevel + this._viewLevelOffset + 1e-9),
          this.minLevel,
          this.maxLevel
        );
    if (next === this.viewSourceLevel) return;
    this.viewSourceLevel = next;
    this._revision += 1;
  }

  setViewLevelOffset(offset: number | null): void {
    const next = normalizeViewLevelOffset(offset);
    if (next === this._viewLevelOffset) return;
    this._viewLevelOffset = next;
    this.viewSourceLevel = Number.NaN;
  }

  maximumSourceLevel(renderLevel: number): number {
    return Math.min(renderLevel, this.viewSourceLevel, this.maxLevel);
  }

  styleCapabilities(): Promise<MapStyleCapabilityReport> {
    return this.styleLoader.capabilities();
  }

  hasTile(tile: TileId): boolean {
    if (!this.bounds) return true;
    const [west, south, east, north] = tileBounds(tile);
    const [boundsWest, boundsSouth, boundsEast, boundsNorth] = this.bounds;
    const latitudeIntersects = south < boundsNorth && north > boundsSouth;
    const longitudeIntersects = boundsWest <= boundsEast
      ? west < boundsEast && east > boundsWest
      : west < boundsEast || east > boundsWest;
    return latitudeIntersects && longitudeIntersects;
  }

  url(tile: TileId): string {
    if (this.source) return this.source.url(tile);
    const template = this.directSource?.tiles?.[0];
    return template
      ? resolveTemplate(template, tile, this.directSource?.scheme, this.directSource?.subdomains)
      : `${this.styleLoader.styleUrl ?? this.id}#${tile.level}/${tile.x}/${tile.y}`;
  }

  async loadTexture(tile: TileId, signal?: AbortSignal): Promise<THREE.Texture> {
    const style = await this.styleLoader.load();
    const selected = this.styleLoader.selectVectorSource(style);
    const source = this.source ??= new MvtTileSource({
      id: selected.id,
      source: this.directSource ?? selected.source,
      fetcher: this.fetcher
    });
    const bytes = await source.load(tile, signal);
    const decoded = this.decoder.decode(
      bytes,
      this.styleLoader.sourceLayerNames(style, selected.id)
    );
    const canvas = this.rasterizer.rasterize(style, selected.id, decoded, tile.level);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.premultiplyAlpha = true;
    texture.needsUpdate = true;
    return texture;
  }
}

function normalizeViewLevelOffset(value: number | null | undefined): number | null {
  if (value === null) return null;
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_LEVEL_OFFSET;
  return Math.max(-8, Math.min(2, value));
}

function normalizeBounds(value: readonly [number, number, number, number]): readonly [number, number, number, number] {
  const [west, south, east, north] = value;
  if (![west, south, east, north].every(Number.isFinite) || south >= north) {
    throw new Error('MVT bounds 必须是有效的 [west, south, east, north]。');
  }
  return Object.freeze([west, south, east, north]);
}

function tileBounds(tile: TileId): readonly [number, number, number, number] {
  const size = 2 ** tile.level;
  const west = tile.x / size * 360 - 180;
  const east = (tile.x + 1) / size * 360 - 180;
  const north = Math.atan(Math.sinh(Math.PI - tile.y / size * Math.PI * 2)) * 180 / Math.PI;
  const south = Math.atan(Math.sinh(Math.PI - (tile.y + 1) / size * Math.PI * 2)) * 180 / Math.PI;
  return [west, south, east, north];
}

function resolveTemplate(
  template: string,
  tile: TileId,
  scheme: 'xyz' | 'tms' | undefined,
  subdomains: readonly string[] | undefined
): string {
  const invertedY = 2 ** tile.level - tile.y - 1;
  const y = scheme === 'tms' ? invertedY : tile.y;
  const subdomain = subdomains && subdomains.length > 0
    ? subdomains[(tile.x + tile.y) % subdomains.length] ?? ''
    : '';
  return template
    .split('{z}').join(String(tile.level))
    .split('{x}').join(String(tile.x))
    .split('{y}').join(String(y))
    .split('{-y}').join(String(invertedY))
    .split('{s}').join(subdomain);
}
