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

  private templates: readonly string[];
  private readonly tileJsonUrl?: string;
  private metadataPromise: Promise<readonly string[]> | null = null;

  constructor(options: MvtTileSourceOptions) {
    const templates = options.source.tiles ?? [];
    if (templates.length === 0 && !options.source.url) {
      throw new Error(`矢量数据源 ${options.id} 没有 tiles 模板或 TileJSON URL。`);
    }
    this.id = options.id;
    this.templates = templates;
    this.tileJsonUrl = options.source.url;
    this.minLevel = Math.max(0, Math.round(options.source.minzoom ?? 0));
    this.maxLevel = Math.max(this.minLevel, Math.round(options.source.maxzoom ?? 30));
  }

  url(tile: TileId): string {
    // Keep the compatibility renderer deterministic. ArcGIS style sources
    // normally expose equivalent templates, and the legacy provider used the
    // first one consistently.
    const template = this.templates[0];
    if (!template) {
      throw new Error(`矢量数据源 ${this.id} 的 TileJSON 尚未解析，请通过 load() 请求瓦片。`);
    }
    return template
      .split('{z}').join(String(tile.level))
      .split('{x}').join(String(tile.x))
      .split('{y}').join(String(tile.y));
  }

  async load(tile: TileId, signal?: AbortSignal): Promise<ArrayBuffer> {
    const templates = await this.resolveTemplates(signal);
    const template = templates[(tile.x + tile.y) % templates.length];
    if (!template) throw new Error(`矢量数据源 ${this.id} 没有可用 tiles 模板。`);
    const tileUrl = resolveTileUrl(template, tile);
    const response = await fetch(tileUrl, { signal });
    if (!response.ok) throw new Error(`MVT 请求失败：${response.status} ${tileUrl}`);
    return response.arrayBuffer();
  }

  private resolveTemplates(signal?: AbortSignal): Promise<readonly string[]> {
    if (this.templates.length > 0) return Promise.resolve(this.templates);
    return this.metadataPromise ??= this.loadTileJson(signal);
  }

  private async loadTileJson(signal?: AbortSignal): Promise<readonly string[]> {
    if (!this.tileJsonUrl) throw new Error(`矢量数据源 ${this.id} 没有 TileJSON URL。`);
    const response = await fetch(this.tileJsonUrl, { signal });
    if (!response.ok) {
      throw new Error(`矢量 TileJSON 加载失败：${response.status} ${sanitizeUrl(this.tileJsonUrl)}`);
    }
    const tileJson = await response.json() as { tiles?: string[] };
    const templates = tileJson.tiles ?? [];
    if (templates.length === 0) throw new Error(`矢量 TileJSON ${this.id} 没有 tiles 模板。`);
    this.templates = templates;
    return templates;
  }
}

function resolveTileUrl(template: string, tile: TileId): string {
  return template
    .split('{z}').join(String(tile.level))
    .split('{x}').join(String(tile.x))
    .split('{y}').join(String(tile.y));
}

function sanitizeUrl(value: string): string {
  return value.replace(/([?&](?:key|token|access_token)=)[^&]+/gi, '$1***');
}
