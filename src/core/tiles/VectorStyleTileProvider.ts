import * as THREE from 'three';
import { VectorTile, type VectorTileFeature } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import type { TileId } from '../tiling/GeographicTilingScheme';
import type { RasterTileProvider } from './RasterTileProvider';

type StyleValue = unknown;
type StyleLayer = {
  id: string;
  type: 'background' | 'fill' | 'line' | 'symbol' | string;
  source?: string;
  'source-layer'?: string;
  minzoom?: number;
  maxzoom?: number;
  filter?: unknown[];
  layout?: Record<string, StyleValue>;
  paint?: Record<string, StyleValue>;
};
type VectorSource = {
  type: string;
  tiles?: string[];
  minzoom?: number;
  maxzoom?: number;
};
type MapStyle = {
  version: number;
  sources: Record<string, VectorSource>;
  layers: StyleLayer[];
};
type DecodedFeature = {
  type: VectorTileFeature['type'];
  properties: Record<string, number | string | boolean>;
  geometry: ReturnType<VectorTileFeature['loadGeometry']>;
  extent: number;
};
type SymbolCandidate = {
  feature: DecodedFeature;
  layer: StyleLayer;
  order: number;
};

export type VectorStyleTileProviderOptions = {
  styleUrl: string;
  id?: string;
  sourceId?: string;
  minLevel?: number;
  maxLevel?: number;
  /** Esri basemap convention currently uses -2 to align its data zoom with globe LOD. */
  levelOffset?: number;
  /** Prevents coarse horizon tiles from using incompatible small-scale map styles. */
  minimumLodLevelOffset?: number;
  /** Re-enables Admin0 country labels when a style explicitly hides them. */
  showCountryLabels?: boolean;
  tileSize?: number;
  attribution?: string;
};

/** Rasterizes Mapbox Style v8 MVT layers into GPU-ready canvas tile textures. */
export class VectorStyleTileProvider implements RasterTileProvider {
  readonly id: string;
  readonly minLevel: number;
  readonly maxLevel: number;
  readonly levelOffset: number;
  readonly minimumLodLevelOffset: number;
  readonly attribution?: string;

  private readonly styleUrl: string;
  private readonly sourceId?: string;
  private readonly tileSize: number;
  private readonly showCountryLabels: boolean;
  private stylePromise: Promise<MapStyle> | null = null;
  private viewSourceLevel: number;

  constructor(options: VectorStyleTileProviderOptions) {
    this.id = options.id ?? 'vector-style';
    this.minLevel = Math.max(0, Math.round(options.minLevel ?? 0));
    this.maxLevel = Math.max(this.minLevel, Math.round(options.maxLevel ?? 20));
    this.levelOffset = Math.min(0, Math.round(options.levelOffset ?? -2));
    this.minimumLodLevelOffset = Math.min(0, Math.round(options.minimumLodLevelOffset ?? 0));
    this.attribution = options.attribution ?? 'Esri';
    this.styleUrl = options.styleUrl;
    this.sourceId = options.sourceId;
    this.tileSize = Math.max(256, Math.round(options.tileSize ?? 512));
    this.showCountryLabels = options.showCountryLabels ?? false;
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
    return Math.min(
      renderLevel + this.levelOffset,
      this.viewSourceLevel,
      this.maxLevel
    );
  }

  url(tile: TileId): string {
    return `${this.styleUrl}#${tile.level}/${tile.x}/${tile.y}`;
  }

  async loadTexture(tile: TileId): Promise<THREE.Texture> {
    const style = await (this.stylePromise ??= this.loadStyle());
    const [sourceId, source] = this.selectSource(style);
    const template = source.tiles?.[0];
    if (!template) throw new Error(`矢量数据源 ${sourceId} 没有 tiles 模板。`);
    const tileUrl = resolveUrlTemplate(template, tile);
    const response = await fetch(tileUrl);
    if (!response.ok) throw new Error(`MVT 请求失败：${response.status} ${tileUrl}`);
    const vectorTile = new VectorTile(new PbfReader(await response.arrayBuffer()));
    const canvas = document.createElement('canvas');
    canvas.width = this.tileSize;
    canvas.height = this.tileSize;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前浏览器不支持 Canvas 2D。');
    this.renderStyle(context, style, sourceId, vectorTile, tile.level);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  }

  private async loadStyle(): Promise<MapStyle> {
    const response = await fetch(this.styleUrl);
    if (!response.ok) throw new Error(`矢量样式加载失败：${response.status} ${this.styleUrl}`);
    const style = await response.json() as MapStyle;
    if (style.version !== 8 || !style.sources || !Array.isArray(style.layers)) {
      throw new Error('矢量样式不是有效的 Mapbox Style v8。');
    }
    return style;
  }

  private selectSource(style: MapStyle): [string, VectorSource] {
    const entries = Object.entries(style.sources);
    const selected = this.sourceId
      ? entries.find(([id]) => id === this.sourceId)
      : entries.find(([, source]) => source.type === 'vector');
    if (!selected || selected[1].type !== 'vector') {
      throw new Error(`样式中找不到矢量数据源${this.sourceId ? ` ${this.sourceId}` : ''}。`);
    }
    return selected;
  }

  private renderStyle(
    context: CanvasRenderingContext2D,
    style: MapStyle,
    sourceId: string,
    tile: VectorTile,
    zoom: number
  ): void {
    const decodedLayers = new Map<string, DecodedFeature[]>();
    const occupiedLabels: Array<readonly [number, number, number, number]> = [];
    const symbolCandidates: SymbolCandidate[] = [];
    const renderScale = this.tileSize / 256;
    context.clearRect(0, 0, this.tileSize, this.tileSize);
    context.lineJoin = 'round';
    context.lineCap = 'round';

    for (const layer of style.layers) {
      if (!isLayerVisible(layer, zoom, this.showCountryLabels)) continue;
      if (layer.type === 'background') {
        context.globalAlpha = numberValue(resolveStyleValue(layer.paint?.['background-opacity'], zoom), 1);
        context.fillStyle = colorValue(resolveStyleValue(layer.paint?.['background-color'], zoom), '#dcebf3');
        context.fillRect(0, 0, this.tileSize, this.tileSize);
        continue;
      }
      if (layer.source && layer.source !== sourceId) continue;
      const sourceLayerName = layer['source-layer'];
      if (!sourceLayerName) continue;
      const vectorLayer = tile.layers[sourceLayerName];
      if (!vectorLayer) continue;
      let features = decodedLayers.get(sourceLayerName);
      if (!features) {
        features = [];
        for (let index = 0; index < vectorLayer.length; index += 1) {
          const feature = vectorLayer.feature(index);
          features.push({
            type: feature.type,
            properties: feature.properties,
            geometry: feature.loadGeometry(),
            extent: feature.extent
          });
        }
        decodedLayers.set(sourceLayerName, features);
      }
      for (const feature of features) {
        if (!matchesFilter(layer.filter, feature.properties)) continue;
        if (layer.type === 'fill') {
          drawFill(context, feature, layer, zoom, this.tileSize);
        } else if (layer.type === 'line') {
          drawLine(context, feature, layer, zoom, this.tileSize, renderScale);
        } else if (layer.type === 'symbol') {
          symbolCandidates.push({
            feature,
            layer,
            order: symbolCandidates.length
          });
        }
      }
    }
    symbolCandidates.sort((a, b) =>
      symbolPriority(b.layer, b.feature, zoom) - symbolPriority(a.layer, a.feature, zoom) ||
      b.order - a.order
    );
    for (const candidate of symbolCandidates) {
      drawSymbol(
        context,
        candidate.feature,
        candidate.layer,
        zoom,
        this.tileSize,
        renderScale,
        occupiedLabels
      );
    }
    context.globalAlpha = 1;
    context.setLineDash([]);
  }
}

function symbolPriority(layer: StyleLayer, feature: DecodedFeature, zoom: number): number {
  const sourceLayer = layer['source-layer'] ?? '';
  let hierarchy = 0;
  if (sourceLayer === 'Admin0 point') hierarchy = 10_000;
  else if (sourceLayer === 'Disputed label point') hierarchy = 9_000;
  else if (sourceLayer.startsWith('Admin1')) hierarchy = 8_000;
  else if (sourceLayer === 'City small scale') hierarchy = 7_000;
  else if (sourceLayer.includes('Ocean')) hierarchy = 6_000;
  else if (sourceLayer.includes('Water')) hierarchy = 5_000;
  const fontSize = numberValue(
    resolveStyleValue(layer.layout?.['text-size'], zoom, feature.properties),
    10
  );
  return hierarchy + fontSize * 10;
}

function drawFill(
  context: CanvasRenderingContext2D,
  feature: DecodedFeature,
  layer: StyleLayer,
  zoom: number,
  tileSize: number
): void {
  if (feature.type !== 3) return;
  const color = resolveStyleValue(layer.paint?.['fill-color'], zoom, feature.properties);
  const outline = resolveStyleValue(layer.paint?.['fill-outline-color'], zoom, feature.properties);
  const opacity = numberValue(resolveStyleValue(layer.paint?.['fill-opacity'], zoom, feature.properties), 1);
  context.beginPath();
  appendGeometryPath(context, feature, tileSize, true);
  context.globalAlpha = opacity;
  context.fillStyle = colorValue(color, '#d8e2d0');
  context.fill('evenodd');
  if (outline !== undefined) {
    context.strokeStyle = colorValue(outline, context.fillStyle as string);
    context.lineWidth = 1;
    context.stroke();
  }
}

function drawLine(
  context: CanvasRenderingContext2D,
  feature: DecodedFeature,
  layer: StyleLayer,
  zoom: number,
  tileSize: number,
  renderScale: number
): void {
  if (feature.type !== 2 && feature.type !== 3) return;
  context.beginPath();
  appendGeometryPath(context, feature, tileSize, false);
  context.globalAlpha = numberValue(resolveStyleValue(layer.paint?.['line-opacity'], zoom, feature.properties), 1);
  context.strokeStyle = colorValue(
    resolveStyleValue(layer.paint?.['line-color'], zoom, feature.properties),
    '#82939b'
  );
  context.lineWidth = Math.max(
    0.35,
    numberValue(resolveStyleValue(layer.paint?.['line-width'], zoom, feature.properties), 1) * renderScale
  );
  context.lineJoin = stringValue(layer.layout?.['line-join'], 'round') as CanvasLineJoin;
  context.lineCap = stringValue(layer.layout?.['line-cap'], 'round') as CanvasLineCap;
  const dash = resolveStyleValue(layer.paint?.['line-dasharray'], zoom, feature.properties);
  context.setLineDash(Array.isArray(dash) ? dash.map((item) => numberValue(item, 0) * context.lineWidth) : []);
  context.stroke();
  context.setLineDash([]);
}

function drawSymbol(
  context: CanvasRenderingContext2D,
  feature: DecodedFeature,
  layer: StyleLayer,
  zoom: number,
  tileSize: number,
  renderScale: number,
  occupied: Array<readonly [number, number, number, number]>
): void {
  const text = resolveText(layer.layout?.['text-field'], zoom, feature.properties);
  if (!text) return;
  const point = representativePoint(feature, tileSize);
  if (!point) return;
  const fontSize = Math.max(
    8,
    numberValue(resolveStyleValue(layer.layout?.['text-size'], zoom, feature.properties), 10) * renderScale
  );
  const textOffset = resolveStyleValue(layer.layout?.['text-offset'], zoom, feature.properties);
  if (Array.isArray(textOffset)) {
    point.x += numberValue(textOffset[0], 0) * fontSize;
    point.y += numberValue(textOffset[1], 0) * fontSize;
  }
  context.font = `${fontSize}px "Microsoft YaHei", "Noto Sans CJK SC", sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  const collisionPadding = Math.max(
    2 * renderScale,
    numberValue(resolveStyleValue(layer.layout?.['text-padding'], zoom, feature.properties), 2) * renderScale
  );
  const width = context.measureText(text).width + collisionPadding * 2;
  const height = fontSize * 1.25 + collisionPadding * 2;
  const box: readonly [number, number, number, number] = [
    point.x - width * 0.5,
    point.y - height * 0.5,
    point.x + width * 0.5,
    point.y + height * 0.5
  ];
  // Labels are rasterized per tile, so any box crossing a tile boundary cannot
  // participate in collision checks on its neighbour. Suppress those labels;
  // the neighbouring MVT copy owns the placement instead.
  const edgeGuard = 4 * renderScale;
  if (
    box[0] < edgeGuard || box[1] < edgeGuard ||
    box[2] > tileSize - edgeGuard || box[3] > tileSize - edgeGuard
  ) return;
  if (occupied.some((other) => rectanglesOverlap(box, other))) return;
  occupied.push(box);
  context.globalAlpha = numberValue(resolveStyleValue(layer.paint?.['text-opacity'], zoom, feature.properties), 1);
  const haloWidth = numberValue(resolveStyleValue(layer.paint?.['text-halo-width'], zoom, feature.properties), 0) * renderScale;
  if (haloWidth > 0) {
    context.strokeStyle = colorValue(
      resolveStyleValue(layer.paint?.['text-halo-color'], zoom, feature.properties),
      '#ffffff'
    );
    context.lineWidth = haloWidth * 2;
    context.strokeText(text, point.x, point.y);
  }
  context.fillStyle = colorValue(
    resolveStyleValue(layer.paint?.['text-color'], zoom, feature.properties),
    '#34495a'
  );
  context.fillText(text, point.x, point.y);
}

function appendGeometryPath(
  context: CanvasRenderingContext2D,
  feature: DecodedFeature,
  tileSize: number,
  close: boolean
): void {
  const scale = tileSize / feature.extent;
  for (const line of feature.geometry) {
    const first = line[0];
    if (!first) continue;
    context.moveTo(first.x * scale, first.y * scale);
    for (let index = 1; index < line.length; index += 1) {
      const point = line[index];
      if (point) context.lineTo(point.x * scale, point.y * scale);
    }
    if (close) context.closePath();
  }
}

function representativePoint(feature: DecodedFeature, tileSize: number): { x: number; y: number } | null {
  const line = feature.geometry[0];
  if (!line || line.length === 0) return null;
  const point = line[Math.floor(line.length * 0.5)];
  if (!point) return null;
  const scale = tileSize / feature.extent;
  return { x: point.x * scale, y: point.y * scale };
}

function isLayerVisible(
  layer: StyleLayer,
  zoom: number,
  showCountryLabels: boolean
): boolean {
  const countryLabelOverride = showCountryLabels &&
    layer.type === 'symbol' &&
    layer['source-layer'] === 'Admin0 point';
  return (layer.layout?.visibility !== 'none' || countryLabelOverride) &&
    (layer.minzoom === undefined || zoom >= layer.minzoom) &&
    (layer.maxzoom === undefined || zoom < layer.maxzoom);
}

function matchesFilter(
  filter: unknown[] | undefined,
  properties: Record<string, number | string | boolean>
): boolean {
  if (!filter || filter.length === 0) return true;
  const [operator, ...args] = filter;
  if (operator === 'all') return args.every((item) => Array.isArray(item) && matchesFilter(item, properties));
  if (operator === 'any') return args.some((item) => Array.isArray(item) && matchesFilter(item, properties));
  if (operator === 'none') return !args.some((item) => Array.isArray(item) && matchesFilter(item, properties));
  const key = String(args[0] ?? '');
  const actual = properties[key];
  if (operator === 'has') return key in properties;
  if (operator === '!has') return !(key in properties);
  if (operator === '==') return actual === args[1];
  if (operator === '!=') return actual !== args[1];
  if (operator === 'in') return args.slice(1).includes(actual);
  if (operator === '!in') return !args.slice(1).includes(actual);
  if (operator === '>') return Number(actual) > Number(args[1]);
  if (operator === '>=') return Number(actual) >= Number(args[1]);
  if (operator === '<') return Number(actual) < Number(args[1]);
  if (operator === '<=') return Number(actual) <= Number(args[1]);
  return true;
}

function resolveStyleValue(
  value: StyleValue,
  zoom: number,
  properties: Record<string, number | string | boolean> = {}
): unknown {
  if (Array.isArray(value)) return evaluateExpression(value, zoom, properties);
  if (!value || typeof value !== 'object') return value;
  const definition = value as {
    property?: string;
    stops?: Array<[number | string, unknown]>;
    default?: unknown;
  };
  if (!definition.stops || definition.stops.length === 0) return definition.default;
  const input = definition.property ? properties[definition.property] : zoom;
  if (typeof input !== 'number') {
    return definition.stops.find(([stop]) => stop === input)?.[1] ?? definition.default;
  }
  const numericStops = definition.stops.filter((stop): stop is [number, unknown] => typeof stop[0] === 'number');
  if (numericStops.length === 0) return definition.default;
  if (input <= numericStops[0]![0]) return numericStops[0]![1];
  for (let index = 1; index < numericStops.length; index += 1) {
    const previous = numericStops[index - 1]!;
    const next = numericStops[index]!;
    if (input <= next[0]) {
      const amount = (input - previous[0]) / Math.max(1e-9, next[0] - previous[0]);
      return interpolateValue(previous[1], next[1], amount);
    }
  }
  return numericStops[numericStops.length - 1]![1];
}

function evaluateExpression(
  expression: unknown[],
  zoom: number,
  properties: Record<string, number | string | boolean>
): unknown {
  const [operator, ...args] = expression;
  if (operator === 'get') return properties[String(args[0] ?? '')];
  if (operator === 'zoom') return zoom;
  if (operator === 'literal') return args[0];
  if (operator === 'coalesce') {
    for (const argument of args) {
      const result = Array.isArray(argument)
        ? evaluateExpression(argument, zoom, properties)
        : argument;
      if (result !== undefined && result !== null && result !== '') return result;
    }
    return undefined;
  }
  if (operator === 'concat') {
    return args.map((argument) => String(Array.isArray(argument)
      ? evaluateExpression(argument, zoom, properties) ?? ''
      : argument ?? '')).join('');
  }
  if (operator === 'to-string') {
    const value = Array.isArray(args[0]) ? evaluateExpression(args[0], zoom, properties) : args[0];
    return value === undefined || value === null ? '' : String(value);
  }
  return expression;
}

function resolveText(
  value: StyleValue,
  zoom: number,
  properties: Record<string, number | string | boolean>
): string {
  const resolved = resolveStyleValue(value, zoom, properties);
  if (typeof resolved === 'string') {
    return resolved.replace(/\{([^}]+)\}/g, (_match, key: string) => String(properties[key] ?? ''));
  }
  return resolved === undefined || resolved === null ? '' : String(resolved);
}

function interpolateValue(start: unknown, end: unknown, amount: number): unknown {
  if (typeof start === 'number' && typeof end === 'number') {
    return THREE.MathUtils.lerp(start, end, amount);
  }
  if (typeof start === 'string' && typeof end === 'string' && isColor(start) && isColor(end)) {
    return `#${new THREE.Color(start).lerp(new THREE.Color(end), amount).getHexString()}`;
  }
  return amount < 0.5 ? start : end;
}

function resolveUrlTemplate(template: string, tile: TileId): string {
  return template
    .split('{z}').join(String(tile.level))
    .split('{x}').join(String(tile.x))
    .split('{y}').join(String(tile.y));
}

function colorValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && isColor(value) ? value : fallback;
}

function isColor(value: string): boolean {
  return value.startsWith('#') || value.startsWith('rgb') || /^[a-z]+$/i.test(value);
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function rectanglesOverlap(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number]
): boolean {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}
