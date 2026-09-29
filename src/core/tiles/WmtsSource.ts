import type { TileId } from '../tiling/GeographicTilingScheme';
import { DEFAULT_LEVEL_OFFSET, type RasterTileProvider } from './RasterTileProvider';

export type WmtsResourceUrl = Readonly<{
  format: string;
  resourceType: string;
  template: string;
}>;

export type WmtsLayer = Readonly<{
  identifier: string;
  title?: string;
  formats: readonly string[];
  styles: readonly Readonly<{ identifier: string; isDefault: boolean }>[];
  tileMatrixSets: readonly string[];
  tileMatrixSetLinks: readonly WmtsTileMatrixSetLink[];
  resourceUrls: readonly WmtsResourceUrl[];
}>;

export type WmtsTileMatrixLimit = Readonly<{
  tileMatrix: string;
  minTileRow: number;
  maxTileRow: number;
  minTileCol: number;
  maxTileCol: number;
}>;

export type WmtsTileMatrixSetLink = Readonly<{
  identifier: string;
  limits: readonly WmtsTileMatrixLimit[];
}>;

export type WmtsTileMatrix = Readonly<{
  identifier: string;
  scaleDenominator: number;
  topLeftCorner: readonly [number, number];
  tileWidth: number;
  tileHeight: number;
  matrixWidth: number;
  matrixHeight: number;
}>;

export type WmtsTileMatrixSet = Readonly<{
  identifier: string;
  supportedCrs: string;
  matrices: readonly WmtsTileMatrix[];
}>;

export type WmtsCapabilities = Readonly<{
  version: string;
  getTileKvpUrl?: string;
  layers: readonly WmtsLayer[];
  tileMatrixSets: readonly WmtsTileMatrixSet[];
}>;

export type WmtsRasterProviderOptions = Readonly<{
  id?: string;
  capabilities: WmtsCapabilities;
  layer: string;
  tileMatrixSet: string;
  style?: string;
  format?: string;
  requestEncoding?: 'auto' | 'rest' | 'kvp';
  /** Replaces the advertised endpoint origin, typically with a same-origin dev proxy. */
  endpointBaseUrl?: string;
  levelOffset?: number;
  attribution?: string;
}>;

export async function loadWmtsCapabilities(
  url: string,
  fetcher: typeof fetch = fetch
): Promise<WmtsCapabilities> {
  const response = await fetcher(url, { headers: { Accept: 'application/xml,text/xml' } });
  if (!response.ok) throw new Error(`WMTS GetCapabilities failed (${response.status}): ${url}`);
  return parseWmtsCapabilities(await response.text());
}

/** Namespace-tolerant WMTS 1.0.0 parser that also works in Node without DOMParser. */
export function parseWmtsCapabilities(xml: string): WmtsCapabilities {
  if (!/<(?:\w+:)?Capabilities\b/i.test(xml)) throw new Error('Invalid WMTS capabilities document.');
  const contents = firstBlock(xml, 'Contents') ?? xml;
  const layers = blocks(contents, 'Layer').map(parseLayer);
  // TileMatrixSetLink also contains a short <TileMatrixSet> reference. Only
  // definitions carry SupportedCRS and child TileMatrix elements.
  const tileMatrixSets = blocks(contents, 'TileMatrixSet')
    .filter((block) => /<(?:\w+:)?SupportedCRS\b/i.test(block))
    .map(parseMatrixSet);
  if (layers.length === 0) throw new Error('WMTS capabilities contains no layers.');
  if (tileMatrixSets.length === 0) throw new Error('WMTS capabilities contains no TileMatrixSet.');
  const version = attribute(firstTag(xml, 'Capabilities') ?? '', 'version') ?? '1.0.0';
  const operation = blocks(xml, 'Operation').find((block) => attribute(firstTag(block, 'Operation') ?? '', 'name') === 'GetTile');
  const getTag = operation ? firstTag(operation, 'Get') : undefined;
  const getTileKvpUrl = getTag ? attribute(getTag, 'xlink:href') ?? attribute(getTag, 'href') : undefined;
  return Object.freeze({ version, getTileKvpUrl, layers, tileMatrixSets });
}

/** Raster provider created from advertised WMTS matrix identifiers and REST/KVP endpoints. */
export class WmtsRasterProvider implements RasterTileProvider {
  readonly id: string;
  readonly minLevel = 0;
  readonly maxLevel: number;
  readonly levelOffset = 0;
  readonly estimatedTextureBytes: number;
  readonly attribution?: string;
  private readonly layer: WmtsLayer;
  private readonly matrixSet: WmtsTileMatrixSet;
  private readonly matrixSetLink: WmtsTileMatrixSetLink;
  private readonly style: string;
  private readonly format: string;
  private readonly restTemplate?: string;
  private readonly kvpUrl?: string;
  private readonly endpointBaseUrl?: string;
  private _viewLevelOffset: number | null;
  private viewSourceLevel: number;
  private _revision = 0;

  constructor(options: WmtsRasterProviderOptions) {
    const layer = options.capabilities.layers.find((candidate) => candidate.identifier === options.layer);
    if (!layer) throw new Error(`Unknown WMTS layer: ${options.layer}`);
    const matrixSet = options.capabilities.tileMatrixSets.find(
      (candidate) => candidate.identifier === options.tileMatrixSet
    );
    if (!matrixSet) throw new Error(`Unknown WMTS TileMatrixSet: ${options.tileMatrixSet}`);
    const matrixSetLink = layer.tileMatrixSetLinks.find(
      (candidate) => candidate.identifier === matrixSet.identifier
    );
    if (!matrixSetLink) {
      throw new Error(`WMTS layer ${layer.identifier} does not link ${matrixSet.identifier}.`);
    }
    if (!/(?:EPSG(?::|::)?(?:3857|900913)|urn:ogc:def:crs:EPSG::(?:3857|900913))/i.test(matrixSet.supportedCrs)) {
      throw new Error(
        `WMTS matrix set ${matrixSet.identifier} uses unsupported CRS ${matrixSet.supportedCrs}; ` +
        'the current globe raster path requires Web Mercator (EPSG:3857/900913).'
      );
    }
    if (matrixSet.matrices.length === 0) throw new Error(`WMTS matrix set is empty: ${matrixSet.identifier}`);
    this.layer = layer;
    this.matrixSet = matrixSet;
    this.matrixSetLink = matrixSetLink;
    this.style = options.style ?? layer.styles.find((candidate) => candidate.isDefault)?.identifier ?? layer.styles[0]?.identifier ?? '';
    this.format = options.format ?? layer.formats[0] ?? 'image/png';
    const restResource = layer.resourceUrls.find(
      (resource) => resource.resourceType.toLowerCase() === 'tile' && resource.format === this.format
    );
    const encoding = options.requestEncoding ?? 'auto';
    this.restTemplate = encoding === 'kvp' ? undefined : restResource?.template;
    this.kvpUrl = encoding === 'rest' ? undefined : options.capabilities.getTileKvpUrl;
    this.endpointBaseUrl = options.endpointBaseUrl;
    if (!this.restTemplate && !this.kvpUrl) {
      throw new Error(`WMTS layer ${layer.identifier} exposes neither a matching REST template nor KVP GetTile URL.`);
    }
    this.id = options.id ?? `wmts:${layer.identifier}:${matrixSet.identifier}`;
    this.maxLevel = matrixSet.matrices.length - 1;
    const tileSize = matrixSet.matrices[0]?.tileWidth ?? 256;
    this.estimatedTextureBytes = Math.ceil(tileSize * tileSize * 4 * 4 / 3);
    this.attribution = options.attribution;
    this._viewLevelOffset = normalizeOffset(options.levelOffset ?? DEFAULT_LEVEL_OFFSET);
    this.viewSourceLevel = this.maxLevel;
  }

  get revision(): number { return this._revision; }
  get viewLevelOffset(): number | null { return this._viewLevelOffset; }
  get currentSourceLevel(): number { return this.viewSourceLevel; }

  setViewLevel(cameraLevel: number): void {
    const next = this._viewLevelOffset === null
      ? this.maxLevel
      : Math.max(this.minLevel, Math.min(this.maxLevel, Math.floor(cameraLevel + this._viewLevelOffset + 1e-9)));
    if (next === this.viewSourceLevel) return;
    this.viewSourceLevel = next;
    this._revision += 1;
  }

  setViewLevelOffset(offset: number | null): void {
    const next = normalizeOffset(offset);
    if (next === this._viewLevelOffset) return;
    this._viewLevelOffset = next;
    this.viewSourceLevel = Number.NaN;
  }

  maximumSourceLevel(renderLevel: number): number {
    return Math.min(renderLevel, this.viewSourceLevel, this.maxLevel);
  }

  hasTile(tile: TileId): boolean {
    const matrix = this.matrixSet.matrices[tile.level];
    if (!matrix || tile.x < 0 || tile.y < 0 ||
        tile.x >= matrix.matrixWidth || tile.y >= matrix.matrixHeight) return false;
    const limits = this.matrixSetLink.limits;
    if (limits.length === 0) return true;
    const limit = limits.find((candidate) => candidate.tileMatrix === matrix.identifier);
    return limit !== undefined &&
      tile.x >= limit.minTileCol && tile.x <= limit.maxTileCol &&
      tile.y >= limit.minTileRow && tile.y <= limit.maxTileRow;
  }

  url(tile: TileId): string {
    const matrix = this.matrixSet.matrices[tile.level];
    if (!matrix) throw new Error(`WMTS level is outside ${this.matrixSet.identifier}: ${tile.level}`);
    if (tile.x >= matrix.matrixWidth || tile.y >= matrix.matrixHeight) {
      throw new Error(`WMTS tile is outside matrix ${matrix.identifier}: ${tile.x}/${tile.y}`);
    }
    if (this.restTemplate) {
      return rewriteEndpoint(replaceTokens(this.restTemplate, {
        style: this.style,
        TileMatrixSet: this.matrixSet.identifier,
        TileMatrix: matrix.identifier,
        TileRow: String(tile.y),
        TileCol: String(tile.x)
      }), this.endpointBaseUrl);
    }
    const url = new URL(this.kvpUrl!);
    const params: Record<string, string> = {
      SERVICE: 'WMTS', REQUEST: 'GetTile', VERSION: '1.0.0',
      LAYER: this.layer.identifier, STYLE: this.style, FORMAT: this.format,
      TILEMATRIXSET: this.matrixSet.identifier, TILEMATRIX: matrix.identifier,
      TILEROW: String(tile.y), TILECOL: String(tile.x)
    };
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    return rewriteEndpoint(url.toString(), this.endpointBaseUrl);
  }
}

function parseLayer(block: string): WmtsLayer {
  const identifier = requiredText(block, 'Identifier', 'WMTS layer');
  const formats = texts(block, 'Format');
  const styles = blocks(block, 'Style').map((style) => ({
    identifier: requiredText(style, 'Identifier', `WMTS style in ${identifier}`),
    isDefault: attribute(firstTag(style, 'Style') ?? '', 'isDefault') === 'true'
  }));
  const tileMatrixSetLinks = blocks(block, 'TileMatrixSetLink').map((link) => ({
    identifier: requiredText(link, 'TileMatrixSet', `WMTS layer ${identifier}`),
    limits: blocks(link, 'TileMatrixLimits').map((limit) => ({
      tileMatrix: requiredText(limit, 'TileMatrix', `WMTS layer ${identifier} limits`),
      minTileRow: requiredInteger(limit, 'MinTileRow', identifier),
      maxTileRow: requiredInteger(limit, 'MaxTileRow', identifier),
      minTileCol: requiredInteger(limit, 'MinTileCol', identifier),
      maxTileCol: requiredInteger(limit, 'MaxTileCol', identifier)
    }))
  }));
  const tileMatrixSets = tileMatrixSetLinks.map((link) => link.identifier);
  const resourceUrls = tags(block, 'ResourceURL').map((tag) => ({
    format: attribute(tag, 'format') ?? '',
    resourceType: attribute(tag, 'resourceType') ?? '',
    template: attribute(tag, 'template') ?? ''
  })).filter((resource) => resource.template.length > 0);
  return Object.freeze({
    identifier,
    title: text(block, 'Title'),
    formats,
    styles,
    tileMatrixSets,
    tileMatrixSetLinks,
    resourceUrls
  });
}

function parseMatrixSet(block: string): WmtsTileMatrixSet {
  const identifier = requiredText(block, 'Identifier', 'WMTS TileMatrixSet');
  const matrices = blocks(block, 'TileMatrix').map((matrix) => {
    const corner = requiredText(matrix, 'TopLeftCorner', `WMTS matrix ${identifier}`)
      .trim().split(/\s+/).map(Number);
    if (corner.length < 2 || corner.some((value) => !Number.isFinite(value))) {
      throw new Error(`Invalid TopLeftCorner in WMTS matrix ${identifier}.`);
    }
    return Object.freeze({
      identifier: requiredText(matrix, 'Identifier', `WMTS matrix ${identifier}`),
      scaleDenominator: requiredNumber(matrix, 'ScaleDenominator', identifier),
      topLeftCorner: Object.freeze([corner[0]!, corner[1]!] as const),
      tileWidth: requiredNumber(matrix, 'TileWidth', identifier),
      tileHeight: requiredNumber(matrix, 'TileHeight', identifier),
      matrixWidth: requiredNumber(matrix, 'MatrixWidth', identifier),
      matrixHeight: requiredNumber(matrix, 'MatrixHeight', identifier)
    });
  });
  return Object.freeze({
    identifier,
    supportedCrs: requiredText(block, 'SupportedCRS', `WMTS matrix set ${identifier}`),
    matrices
  });
}

function blocks(xml: string, name: string): string[] {
  const pattern = new RegExp(`<(?:(?:\\w+):)?${name}\\b[^>]*>[\\s\\S]*?<\\/(?:(?:\\w+):)?${name}>`, 'gi');
  return xml.match(pattern) ?? [];
}

function firstBlock(xml: string, name: string): string | undefined { return blocks(xml, name)[0]; }
function tags(xml: string, name: string): string[] {
  const pattern = new RegExp(`<(?:(?:\\w+):)?${name}\\b[^>]*\\/?>`, 'gi');
  return xml.match(pattern) ?? [];
}
function firstTag(xml: string, name: string): string | undefined { return tags(xml, name)[0]; }
function texts(xml: string, name: string): string[] {
  const pattern = new RegExp(`<(?:(?:\\w+):)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:\\w+):)?${name}>`, 'gi');
  return [...xml.matchAll(pattern)].map((match) => decodeXml(match[1]?.trim() ?? ''));
}
function text(xml: string, name: string): string | undefined { return texts(xml, name)[0]; }
function requiredText(xml: string, name: string, context: string): string {
  const value = text(xml, name);
  if (!value) throw new Error(`${name} is required in ${context}.`);
  return value;
}
function requiredNumber(xml: string, name: string, context: string): number {
  const value = Number(requiredText(xml, name, context));
  if (!Number.isFinite(value)) throw new Error(`${name} must be numeric in ${context}.`);
  return value;
}
function requiredInteger(xml: string, name: string, context: string): number {
  const value = requiredNumber(xml, name, context);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer in ${context}.`);
  }
  return value;
}
function attribute(tag: string, name: string): string | undefined {
  const escaped = name.replace(':', '\\:');
  const match = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag);
  return match ? decodeXml(match[1] ?? '') : undefined;
}
function decodeXml(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function replaceTokens(template: string, values: Readonly<Record<string, string>>): string {
  let result = template;
  for (const [name, value] of Object.entries(values)) {
    result = result.replace(new RegExp(`\\{${name}\\}`, 'gi'), encodeURIComponent(value));
  }
  return result;
}
function normalizeOffset(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.max(-8, Math.min(2, value));
}

function rewriteEndpoint(value: string, baseUrl?: string): string {
  if (!baseUrl) return value;
  const source = new URL(value);
  return `${baseUrl.replace(/\/$/, '')}${source.pathname}${source.search}${source.hash}`;
}
