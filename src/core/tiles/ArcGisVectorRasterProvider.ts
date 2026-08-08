import * as THREE from 'three';
import type { TileId } from '../tiling/GeographicTilingScheme';
import {
  DEFAULT_LEVEL_OFFSET,
  type RasterTileProvider
} from './RasterTileProvider';
import { MvtDecoder } from '../../vector/decoder/MvtDecoder';
import { CanvasVectorRasterizer } from '../../vector/raster/CanvasVectorRasterizer';
import { MvtTileSource } from '../../vector/source/MvtTileSource';
import { ArcGisStyleAdapter } from '../../vector/style/ArcGisStyleAdapter';

export type ArcGisVectorRasterProviderOptions = {
  styleUrl: string;
  id?: string;
  sourceId?: string;
  minLevel?: number;
  maxLevel?: number;
  /** ArcGIS basemap convention currently uses -2 to align its data zoom with globe LOD. */
  levelOffset?: number;
  /** Continuous source zoom = floor(camera zoom + offset). */
  viewLevelOffset?: number | null;
  /** Prevents coarse horizon tiles from using incompatible small-scale map styles. */
  minimumLodLevelOffset?: number;
  /** Re-enables Admin0 country labels when a style explicitly hides them. */
  showCountryLabels?: boolean;
  tileSize?: number;
  attribution?: string;
};

/**
 * Compatibility renderer for ArcGIS/Mapbox-style MVT services.
 * Features are decoded as vectors, then intentionally rasterized to Canvas.
 */
export class ArcGisVectorRasterProvider implements RasterTileProvider {
  readonly id: string;
  readonly minLevel: number;
  readonly maxLevel: number;
  readonly levelOffset: number;
  readonly minimumLodLevelOffset: number;
  readonly estimatedTextureBytes: number;
  readonly attribution?: string;

  private readonly styleAdapter: ArcGisStyleAdapter;
  private readonly decoder = new MvtDecoder();
  private readonly rasterizer: CanvasVectorRasterizer;
  private source: MvtTileSource | null = null;
  private viewSourceLevel: number;
  private _viewLevelOffset: number | null;
  private _revision = 0;

  constructor(options: ArcGisVectorRasterProviderOptions) {
    this.id = options.id ?? 'arcgis-vector-raster';
    this.minLevel = Math.max(0, Math.round(options.minLevel ?? 0));
    this.maxLevel = Math.max(this.minLevel, Math.round(options.maxLevel ?? 20));
    this._viewLevelOffset = normalizeViewLevelOffset(
      options.viewLevelOffset ?? options.levelOffset ?? DEFAULT_LEVEL_OFFSET
    );
    this.levelOffset = Math.min(0, Math.round(this._viewLevelOffset ?? 0));
    this.minimumLodLevelOffset = Math.min(0, Math.round(options.minimumLodLevelOffset ?? -1));
    this.attribution = options.attribution ?? 'Esri';
    const tileSize = Math.max(256, Math.round(options.tileSize ?? 512));
    this.estimatedTextureBytes = Math.ceil(tileSize * tileSize * 4 * 4 / 3);
    this.styleAdapter = new ArcGisStyleAdapter({
      styleUrl: options.styleUrl,
      sourceId: options.sourceId
    });
    this.rasterizer = new CanvasVectorRasterizer({
      tileSize,
      showCountryLabels: options.showCountryLabels
    });
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

  url(tile: TileId): string {
    return `${this.styleAdapter.styleUrl}#${tile.level}/${tile.x}/${tile.y}`;
  }

  async loadTexture(tile: TileId): Promise<THREE.Texture> {
    const style = await this.styleAdapter.load();
    const selected = this.styleAdapter.selectVectorSource(style);
    const source = this.source ??= new MvtTileSource(selected);
    const bytes = await source.load(tile);
    const decoded = this.decoder.decode(
      bytes,
      this.styleAdapter.sourceLayerNames(style, selected.id)
    );
    const canvas = this.rasterizer.rasterize(style, selected.id, decoded, tile.level);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  }
}

function normalizeViewLevelOffset(value: number | null | undefined): number | null {
  if (value === null) return null;
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_LEVEL_OFFSET;
  return Math.max(-8, Math.min(2, value));
}
