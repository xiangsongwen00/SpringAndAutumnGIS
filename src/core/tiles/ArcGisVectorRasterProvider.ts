import * as THREE from 'three';
import type { TileId } from '../tiling/GeographicTilingScheme';
import type { RasterTileProvider } from './RasterTileProvider';
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

  constructor(options: ArcGisVectorRasterProviderOptions) {
    this.id = options.id ?? 'arcgis-vector-raster';
    this.minLevel = Math.max(0, Math.round(options.minLevel ?? 0));
    this.maxLevel = Math.max(this.minLevel, Math.round(options.maxLevel ?? 20));
    this.levelOffset = Math.min(0, Math.round(options.levelOffset ?? -2));
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

  setViewLevel(cameraLevel: number): void {
    this.viewSourceLevel = THREE.MathUtils.clamp(
      Math.floor(cameraLevel + this.levelOffset),
      this.minLevel,
      this.maxLevel
    );
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
