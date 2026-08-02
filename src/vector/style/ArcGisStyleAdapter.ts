import type {
  MapStyle,
  SelectedVectorSource
} from './VectorStyleTypes';

export type ArcGisStyleAdapterOptions = {
  styleUrl: string;
  sourceId?: string;
};

/** Loads ArcGIS VectorTileServer styles expressed through the Mapbox Style v8 schema. */
export class ArcGisStyleAdapter {
  readonly styleUrl: string;
  readonly sourceId?: string;

  private stylePromise: Promise<MapStyle> | null = null;

  constructor(options: ArcGisStyleAdapterOptions) {
    this.styleUrl = options.styleUrl;
    this.sourceId = options.sourceId;
  }

  load(): Promise<MapStyle> {
    return this.stylePromise ??= this.fetchStyle();
  }

  selectVectorSource(style: MapStyle): SelectedVectorSource {
    const entries = Object.entries(style.sources);
    const selected = this.sourceId
      ? entries.find(([id]) => id === this.sourceId)
      : entries.find(([, source]) => source.type === 'vector');
    if (!selected || selected[1].type !== 'vector') {
      throw new Error(`样式中找不到矢量数据源${this.sourceId ? ` ${this.sourceId}` : ''}。`);
    }
    return { id: selected[0], source: selected[1] };
  }

  sourceLayerNames(style: MapStyle, sourceId: string): ReadonlySet<string> {
    const names = new Set<string>();
    for (const layer of style.layers) {
      if (layer.source && layer.source !== sourceId) continue;
      if (layer['source-layer']) names.add(layer['source-layer']);
    }
    return names;
  }

  private async fetchStyle(): Promise<MapStyle> {
    const response = await fetch(this.styleUrl);
    if (!response.ok) throw new Error(`矢量样式加载失败：${response.status} ${this.styleUrl}`);
    const style = await response.json() as MapStyle;
    if (style.version !== 8 || !style.sources || !Array.isArray(style.layers)) {
      throw new Error('矢量样式不是有效的 Mapbox Style v8。');
    }
    return style;
  }
}
