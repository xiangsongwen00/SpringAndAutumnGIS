import type { TileId } from '../../core/tiling/GeographicTilingScheme';
import type { VectorSource } from '../style/VectorStyleTypes';

export type MvtTileSourceOptions = {
  id: string;
  source: VectorSource;
  fetcher?: typeof fetch;
};

/** Fetches raw MVT bytes. Decoding and rendering deliberately live elsewhere. */
export class MvtTileSource {
  readonly id: string;
  readonly minLevel: number;
  readonly maxLevel: number;

  private templates: readonly string[];
  private readonly tileJsonUrl?: string;
  private readonly scheme: 'xyz' | 'tms';
  private readonly subdomains: readonly string[];
  private readonly fetcher: typeof fetch;
  private metadataPromise: Promise<readonly string[]> | null = null;

  constructor(options: MvtTileSourceOptions) {
    const templates = options.source.tiles ?? [];
    if (templates.length === 0 && !options.source.url) {
      throw new Error(`矢量数据源 ${options.id} 没有 tiles 模板或 TileJSON URL。`);
    }
    this.id = options.id;
    this.templates = templates;
    this.tileJsonUrl = options.source.url;
    this.scheme = options.source.scheme ?? 'xyz';
    this.subdomains = options.source.subdomains ?? [];
    this.fetcher = options.fetcher ?? fetch;
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
    return resolveTileUrl(template, tile, this.scheme, this.subdomains);
  }

  async load(tile: TileId, signal?: AbortSignal): Promise<ArrayBuffer> {
    const templates = await this.resolveTemplates(signal);
    const template = templates[(tile.x + tile.y) % templates.length];
    if (!template) throw new Error(`矢量数据源 ${this.id} 没有可用 tiles 模板。`);
    const tileUrl = resolveTileUrl(template, tile, this.scheme, this.subdomains);
    const response = await this.fetcher.call(globalThis, tileUrl, { signal });
    if (!response.ok) throw new Error(`MVT 请求失败：${response.status} ${tileUrl}`);
    return response.arrayBuffer();
  }

  private resolveTemplates(signal?: AbortSignal): Promise<readonly string[]> {
    if (this.templates.length > 0) return Promise.resolve(this.templates);
    return this.metadataPromise ??= this.loadTileJson(signal);
  }

  private async loadTileJson(signal?: AbortSignal): Promise<readonly string[]> {
    if (!this.tileJsonUrl) throw new Error(`矢量数据源 ${this.id} 没有 TileJSON URL。`);
    const response = await this.fetcher.call(globalThis, this.tileJsonUrl, { signal });
    if (!response.ok) {
      throw new Error(`矢量 TileJSON 加载失败：${response.status} ${sanitizeUrl(this.tileJsonUrl)}`);
    }
    const tileJson = await response.json() as { tiles?: string[] };
    const templates = (tileJson.tiles ?? []).map((template) =>
      resolveMetadataUrl(template, this.tileJsonUrl!)
    );
    if (templates.length === 0) throw new Error(`矢量 TileJSON ${this.id} 没有 tiles 模板。`);
    this.templates = templates;
    return templates;
  }
}

function resolveTileUrl(
  template: string,
  tile: TileId,
  scheme: 'xyz' | 'tms',
  subdomains: readonly string[]
): string {
  const invertedY = 2 ** tile.level - tile.y - 1;
  const y = scheme === 'tms' ? invertedY : tile.y;
  const subdomain = subdomains.length > 0
    ? subdomains[(tile.x + tile.y) % subdomains.length] ?? ''
    : '';
  return template
    .split('{z}').join(String(tile.level))
    .split('{x}').join(String(tile.x))
    .split('{y}').join(String(y))
    .split('{-y}').join(String(invertedY))
    .split('{s}').join(subdomain);
}

function sanitizeUrl(value: string): string {
  return value.replace(/([?&](?:key|token|access_token)=)[^&]+/gi, '$1***');
}

function resolveMetadataUrl(value: string, metadataUrl: string): string {
  try {
    const runtimeBase = typeof location === 'undefined' ? 'http://localhost/' : location.href;
    return new URL(value, new URL(metadataUrl, runtimeBase)).toString()
      .replace(/%7B/gi, '{')
      .replace(/%7D/gi, '}');
  } catch {
    return value;
  }
}
