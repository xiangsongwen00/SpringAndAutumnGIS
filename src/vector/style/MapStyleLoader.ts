import type {
  MapStyle,
  SelectedVectorSource
} from './VectorStyleTypes';

export type MapStyleLoaderOptions = Readonly<{
  styleUrl?: string;
  style?: MapStyle;
  sourceId?: string;
  fetcher?: typeof fetch;
}>;

export type MapStyleCapabilityIssue = Readonly<{
  layerId: string;
  severity: 'degraded' | 'unsupported';
  message: string;
}>;

export type MapStyleCapabilityReport = Readonly<{
  supportedLayers: number;
  degradedLayers: number;
  unsupportedLayers: number;
  issues: readonly MapStyleCapabilityIssue[];
}>;

/** Loads and validates the supported Mapbox Style v8 envelope. */
export class MapStyleLoader {
  readonly styleUrl?: string;
  readonly sourceId?: string;

  private readonly inlineStyle?: MapStyle;
  private readonly fetcher: typeof fetch;
  private stylePromise: Promise<MapStyle> | null = null;

  constructor(options: MapStyleLoaderOptions) {
    if (!options.style && !options.styleUrl) {
      throw new Error('MVT 样式必须提供 style 或 styleUrl。');
    }
    this.styleUrl = options.styleUrl;
    this.sourceId = options.sourceId;
    this.inlineStyle = options.style;
    this.fetcher = options.fetcher ?? fetch;
  }

  load(): Promise<MapStyle> {
    return this.stylePromise ??= this.inlineStyle
      ? Promise.resolve(validateMapStyle(this.inlineStyle))
      : this.fetchStyle();
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

  async capabilities(): Promise<MapStyleCapabilityReport> {
    return analyzeMapStyle(await this.load());
  }

  private async fetchStyle(): Promise<MapStyle> {
    if (!this.styleUrl) throw new Error('MVT 样式 URL 为空。');
    // Browser-native Window.fetch is brand-checked in some runtimes. Calling
    // it as this.fetcher(...) incorrectly binds `this` to MapStyleLoader and
    // throws "Illegal invocation". Always restore the global receiver.
    const response = await this.fetcher.call(globalThis, this.styleUrl);
    if (!response.ok) throw new Error(`矢量样式加载失败：${response.status} ${this.styleUrl}`);
    return validateMapStyle(await response.json() as MapStyle);
  }
}

export function validateMapStyle(style: MapStyle): MapStyle {
  if (style.version !== 8 || !style.sources || !Array.isArray(style.layers)) {
    throw new Error('矢量样式不是有效的 Mapbox Style v8。');
  }
  return style;
}

/** Reports the compatibility renderer's explicit Style v8 boundary. */
export function analyzeMapStyle(style: MapStyle): MapStyleCapabilityReport {
  const issues: MapStyleCapabilityIssue[] = [];
  let supportedLayers = 0;
  let degradedLayers = 0;
  let unsupportedLayers = 0;
  const supportedTypes = new Set(['background', 'fill', 'line', 'circle', 'symbol']);
  for (const layer of style.layers) {
    const layerIssues: MapStyleCapabilityIssue[] = [];
    if (!supportedTypes.has(layer.type)) {
      layerIssues.push({
        layerId: layer.id,
        severity: 'unsupported',
        message: `不支持 ${layer.type} 图层。`
      });
    }
    if (layer.type === 'symbol' && layer.layout?.['icon-image'] !== undefined) {
      layerIssues.push({
        layerId: layer.id,
        severity: 'degraded',
        message: '兼容模式不绘制 sprite icon，仅保留可用文字。'
      });
    }
    if (layer.type === 'symbol' && layer.layout?.['symbol-placement'] === 'line') {
      layerIssues.push({
        layerId: layer.id,
        severity: 'degraded',
        message: '兼容模式不支持沿线文字，标注会使用代表点。'
      });
    }
    for (const [property, value] of Object.entries({ ...layer.layout, ...layer.paint })) {
      const operators = collectUnsupportedExpressionOperators(value);
      if (operators.length > 0) {
        layerIssues.push({
          layerId: layer.id,
          severity: 'degraded',
          message: `${property} 使用未完整支持的表达式：${operators.join('、')}。`
        });
      }
    }
    issues.push(...layerIssues);
    if (layerIssues.some((issue) => issue.severity === 'unsupported')) unsupportedLayers += 1;
    else if (layerIssues.length > 0) degradedLayers += 1;
    else supportedLayers += 1;
  }
  return Object.freeze({
    supportedLayers,
    degradedLayers,
    unsupportedLayers,
    issues: Object.freeze(issues)
  });
}

const SUPPORTED_EXPRESSION_OPERATORS = new Set([
  'literal', 'get', 'zoom', 'coalesce', 'concat', 'to-string'
]);
const KNOWN_EXPRESSION_OPERATORS = new Set([
  ...SUPPORTED_EXPRESSION_OPERATORS,
  'array', 'at', 'boolean', 'case', 'collator', 'format', 'has', 'in',
  'interpolate', 'interpolate-hcl', 'interpolate-lab', 'let', 'match',
  'number', 'object', 'slice', 'step', 'string', 'to-boolean', 'to-color',
  'to-number', 'typeof', 'var', 'within', 'distance', 'config',
  '!', '!=', '<', '<=', '==', '>', '>=', '+', '-', '*', '/', '%', '^',
  'all', 'any', 'index-of', 'length', 'upcase', 'downcase', 'rgb', 'rgba'
]);

function collectUnsupportedExpressionOperators(value: unknown): string[] {
  const result = new Set<string>();
  visitExpression(value, result);
  return [...result];
}

function visitExpression(value: unknown, result: Set<string>): void {
  if (!Array.isArray(value) || value.length === 0) return;
  const operator = value[0];
  // Plain arrays such as dash patterns and text offsets are style values, not expressions.
  if (typeof operator !== 'string' || !KNOWN_EXPRESSION_OPERATORS.has(operator)) return;
  if (!SUPPORTED_EXPRESSION_OPERATORS.has(operator)) result.add(operator);
  for (const argument of value.slice(1)) visitExpression(argument, result);
}
