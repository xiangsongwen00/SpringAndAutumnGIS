import type { TileId } from '../../core/tiling/GeographicTilingScheme';
import type { VectorSource } from '../style/VectorStyleTypes';

export type MvtTileSourceOptions = {
  id: string;
  source: VectorSource;
};

/** Fetches raw MVT bytes. Decoding and rendering deliberately live elsewhere. */
export class MvtTileSource {
  readonly id: string;
  readonly minLevel: number;
  readonly maxLevel: number;

  private readonly templates: readonly string[];

  constructor(options: MvtTileSourceOptions) {
    const templates = options.source.tiles ?? [];
    if (templates.length === 0) throw new Error(`矢量数据源 ${options.id} 没有 tiles 模板。`);
    this.id = options.id;
    this.templates = templates;
    this.minLevel = Math.max(0, Math.round(options.source.minzoom ?? 0));
    this.maxLevel = Math.max(this.minLevel, Math.round(options.source.maxzoom ?? 30));
  }

  url(tile: TileId): string {
    // Keep the compatibility renderer deterministic. ArcGIS style sources
    // normally expose equivalent templates, and the legacy provider used the
    // first one consistently.
    const template = this.templates[0];
    if (!template) throw new Error(`矢量数据源 ${this.id} 没有可用 tiles 模板。`);
    return template
      .split('{z}').join(String(tile.level))
      .split('{x}').join(String(tile.x))
      .split('{y}').join(String(tile.y));
  }

  async load(tile: TileId, signal?: AbortSignal): Promise<ArrayBuffer> {
    const tileUrl = this.url(tile);
    const response = await fetch(tileUrl, { signal });
    if (!response.ok) throw new Error(`MVT 请求失败：${response.status} ${tileUrl}`);
    return response.arrayBuffer();
  }
}
