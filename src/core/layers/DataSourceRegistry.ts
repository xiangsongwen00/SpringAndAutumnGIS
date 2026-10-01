import { ArcGisVectorRasterProvider } from '../tiles/ArcGisVectorRasterProvider';
import { MvtRasterProvider } from '../tiles/MvtRasterProvider';
import {
  DEFAULT_LEVEL_OFFSET,
  UrlTemplateRasterProvider,
  type RasterTileProvider
} from '../tiles/RasterTileProvider';
import { WmtsRasterProvider, loadWmtsCapabilities } from '../tiles/WmtsSource';
import { GeoJsonSource } from '../../feature/GeoJsonSource';
import { Ellipsoid } from '../geo/Ellipsoid';
import { MvtVectorLayer } from '../../render/MvtVectorLayer';
import type { TerrainHeightSource } from '../../render/TerrainTileLayer';

export type DataSourceKind =
  | 'xyz-raster'
  | 'wmts-raster'
  | 'rasterized-vector-style'
  | 'mvt'
  | 'geojson';

export type DataSourceStatus = 'stable' | 'experimental' | 'planned';
export type DataCoordinateReference = 'wgs84-webmercator' | 'gcj02-webmercator-in-china';

export type DataSourceDefinition = Readonly<{
  id: string;
  name: string;
  kind: DataSourceKind;
  urlTemplate?: string;
  capabilitiesUrl?: string;
  layer?: string;
  style?: string;
  format?: string;
  tileMatrixSet?: string;
  requestEncoding?: 'auto' | 'rest' | 'kvp';
  endpointBaseUrl?: string;
  url?: string;
  crs?: string;
  maxFeatures?: number;
  styleUrl?: string;
  sourceId?: string;
  scheme?: 'xyz' | 'tms';
  subdomains?: readonly string[];
  minLevel?: number;
  maxLevel?: number;
  tileSize?: number;
  bounds?: readonly [number, number, number, number];
  levelOffset?: number;
  minimumLodLevelOffset?: number;
  showCountryLabels?: boolean;
  attribution?: string;
  termsUrl?: string;
  requires?: readonly string[];
  status?: DataSourceStatus;
  note?: string;
  coordinateReference?: DataCoordinateReference;
}>;

export type DataSourceRegistryOptions = Readonly<{
  variables?: Readonly<Record<string, string | undefined>>;
  defaultLevelOffset?: number;
  fetcher?: typeof fetch;
}>;

export type RasterProviderOverrides = Readonly<{
  levelOffset?: number;
}>;

export type MvtVectorLayerOverrides = Readonly<{
  levelOffset?: number;
  opacity?: number;
  order?: number;
  terrain?: TerrainHeightSource;
  maxLabelsPerTile?: number;
  maxVisibleLabels?: number;
  role?: 'base' | 'overlay';
  symbols?: boolean;
}>;

export type DataSourceAvailability = Readonly<{
  available: boolean;
  missingVariables: readonly string[];
  supported: boolean;
}>;

/** Registry of serializable source definitions and runtime Provider factories. */
export class DataSourceRegistry {
  private readonly sources = new Map<string, DataSourceDefinition>();
  private readonly variables: Readonly<Record<string, string | undefined>>;
  readonly defaultLevelOffset: number;
  private readonly fetcher: typeof fetch;

  constructor(
    initialSources: readonly DataSourceDefinition[] = [],
    options: DataSourceRegistryOptions = {}
  ) {
    this.variables = options.variables ?? {};
    this.fetcher = options.fetcher ?? fetch;
    this.defaultLevelOffset = normalizeLevelOffset(
      options.defaultLevelOffset ?? DEFAULT_LEVEL_OFFSET
    );
    for (const source of initialSources) this.register(source);
  }

  register(source: DataSourceDefinition): void {
    validateSource(source);
    if (this.sources.has(source.id)) throw new Error(`Data source already exists: ${source.id}`);
    this.sources.set(source.id, freezeSource(source));
  }

  replace(source: DataSourceDefinition): void {
    validateSource(source);
    this.sources.set(source.id, freezeSource(source));
  }

  remove(id: string): boolean {
    return this.sources.delete(id);
  }

  get(id: string): DataSourceDefinition | undefined {
    return this.sources.get(id);
  }

  values(): readonly DataSourceDefinition[] {
    return [...this.sources.values()];
  }

  toJSON(): readonly DataSourceDefinition[] {
    return this.values();
  }

  availability(id: string): DataSourceAvailability {
    const source = this.require(id);
    const missingVariables = (source.requires ?? []).filter(
      (name) => !this.variables[name]?.trim()
    );
    const supported = source.kind !== 'mvt' || Boolean(source.styleUrl);
    return {
      available: missingVariables.length === 0 && supported,
      missingVariables,
      supported
    };
  }

  createRasterProvider(
    id: string,
    overrides: RasterProviderOverrides = {}
  ): RasterTileProvider {
    const source = this.require(id);
    const availability = this.availability(id);
    if (!availability.supported) {
      throw new Error(`Data source ${id} requires a Mapbox Style v8 styleUrl.`);
    }
    if (!availability.available) {
      throw new Error(
        `Data source ${id} is missing variables: ${availability.missingVariables.join(', ')}`
      );
    }
    const levelOffset = normalizeLevelOffset(
      overrides.levelOffset ?? source.levelOffset ?? this.defaultLevelOffset
    );
    if (source.kind === 'wmts-raster' && source.capabilitiesUrl) {
      throw new Error(`Data source ${id} uses GetCapabilities; call createRasterProviderAsync().`);
    }
    if (source.kind === 'rasterized-vector-style') {
      if (!source.styleUrl) throw new Error(`styleUrl is required: ${id}`);
      return new ArcGisVectorRasterProvider({
        id: source.id,
        styleUrl: resolveVariables(source.styleUrl, this.variables),
        sourceId: source.sourceId,
        minLevel: source.minLevel,
        maxLevel: source.maxLevel,
        viewLevelOffset: levelOffset,
        minimumLodLevelOffset: source.minimumLodLevelOffset,
        showCountryLabels: source.showCountryLabels,
        tileSize: source.tileSize,
        attribution: source.attribution,
        fetcher: this.fetcher
      });
    }
    if (source.kind === 'mvt') {
      if (!source.urlTemplate) throw new Error(`urlTemplate is required: ${id}`);
      if (!source.styleUrl) throw new Error(`styleUrl is required for MVT rendering: ${id}`);
      return new MvtRasterProvider({
        id: source.id,
        urlTemplate: resolveVariables(source.urlTemplate, this.variables),
        styleUrl: resolveVariables(source.styleUrl, this.variables),
        sourceId: source.sourceId,
        scheme: source.scheme,
        subdomains: source.subdomains,
        minLevel: source.minLevel,
        maxLevel: source.maxLevel,
        bounds: source.bounds,
        viewLevelOffset: levelOffset,
        minimumLodLevelOffset: source.minimumLodLevelOffset,
        showCountryLabels: source.showCountryLabels,
        tileSize: source.tileSize,
        attribution: source.attribution,
        fetcher: this.fetcher
      });
    }
    if (!source.urlTemplate) throw new Error(`urlTemplate is required: ${id}`);
    return new UrlTemplateRasterProvider({
      id: source.id,
      urlTemplate: resolveVariables(source.urlTemplate, this.variables),
      subdomains: source.subdomains,
      minLevel: source.minLevel,
      maxLevel: source.maxLevel,
      tileSize: source.tileSize,
      bounds: source.bounds,
      viewLevelOffset: levelOffset,
      attribution: source.attribution
    });
  }

  async createRasterProviderAsync(
    id: string,
    overrides: RasterProviderOverrides = {}
  ): Promise<RasterTileProvider> {
    const source = this.require(id);
    if (source.kind !== 'wmts-raster' || !source.capabilitiesUrl) {
      const provider = this.createRasterProvider(id, overrides);
      if (provider instanceof MvtRasterProvider) await provider.initialize();
      return provider;
    }
    const availability = this.availability(id);
    if (!availability.available) {
      throw new Error(`Data source ${id} is missing variables: ${availability.missingVariables.join(', ')}`);
    }
    if (!source.layer || !source.tileMatrixSet) {
      throw new Error(`WMTS layer and tileMatrixSet are required: ${id}`);
    }
    const capabilities = await loadWmtsCapabilities(
      resolveVariables(source.capabilitiesUrl, this.variables),
      this.fetcher
    );
    return new WmtsRasterProvider({
      id: source.id,
      capabilities,
      layer: source.layer,
      tileMatrixSet: source.tileMatrixSet,
      style: source.style,
      format: source.format,
      requestEncoding: source.requestEncoding,
      endpointBaseUrl: source.endpointBaseUrl,
      levelOffset: overrides.levelOffset ?? source.levelOffset ?? this.defaultLevelOffset,
      attribution: source.attribution
    });
  }

  createGeoJsonSource(id: string): GeoJsonSource {
    const source = this.require(id);
    if (source.kind !== 'geojson') throw new Error(`Data source ${id} is not GeoJSON.`);
    if (!source.url) throw new Error(`GeoJSON URL is required: ${id}`);
    return new GeoJsonSource({
      id: source.id,
      url: resolveVariables(source.url, this.variables),
      crs: source.crs,
      maxFeatures: source.maxFeatures
    });
  }

  createMvtVectorLayer(
    id: string,
    ellipsoid: Ellipsoid,
    overrides: MvtVectorLayerOverrides = {}
  ): MvtVectorLayer {
    const source = this.require(id);
    if (source.kind !== 'mvt') throw new Error(`Data source ${id} is not MVT.`);
    const availability = this.availability(id);
    if (!availability.available) {
      throw new Error(`Data source ${id} is unavailable or missing a Style v8 styleUrl.`);
    }
    if (!source.urlTemplate || !source.styleUrl) {
      throw new Error(`MVT urlTemplate and styleUrl are required: ${id}`);
    }
    return new MvtVectorLayer(ellipsoid, {
      id: source.id,
      urlTemplate: resolveVariables(source.urlTemplate, this.variables),
      styleUrl: resolveVariables(source.styleUrl, this.variables),
      sourceId: source.sourceId,
      scheme: source.scheme,
      subdomains: source.subdomains,
      minLevel: source.minLevel,
      maxLevel: source.maxLevel,
      bounds: source.bounds,
      levelOffset: overrides.levelOffset ?? source.levelOffset ?? this.defaultLevelOffset,
      opacity: overrides.opacity,
      order: overrides.order,
      terrain: overrides.terrain,
      maxLabelsPerTile: overrides.maxLabelsPerTile,
      maxVisibleLabels: overrides.maxVisibleLabels,
      role: overrides.role,
      symbols: overrides.symbols,
      fetcher: this.fetcher
    });
  }

  private require(id: string): DataSourceDefinition {
    const source = this.sources.get(id);
    if (!source) throw new Error(`Unknown data source: ${id}`);
    return source;
  }
}

function validateSource(source: DataSourceDefinition): void {
  if (!source.id.trim()) throw new Error('Data source id is required.');
  if (!source.name.trim()) throw new Error(`Data source name is required: ${source.id}`);
  if (source.kind === 'rasterized-vector-style' && !source.styleUrl) {
    throw new Error(`styleUrl is required: ${source.id}`);
  }
  if (
    (source.kind === 'xyz-raster' || source.kind === 'mvt') && !source.urlTemplate
  ) {
    throw new Error(`urlTemplate is required: ${source.id}`);
  }
  if (source.kind === 'wmts-raster' && !source.urlTemplate && !source.capabilitiesUrl) {
    throw new Error(`urlTemplate or capabilitiesUrl is required: ${source.id}`);
  }
  if (source.kind === 'wmts-raster' && source.capabilitiesUrl && (!source.layer || !source.tileMatrixSet)) {
    throw new Error(`layer and tileMatrixSet are required for WMTS capabilities: ${source.id}`);
  }
  if (source.kind === 'geojson' && !source.url) {
    throw new Error(`url is required for GeoJSON source: ${source.id}`);
  }
}

function freezeSource(source: DataSourceDefinition): DataSourceDefinition {
  return Object.freeze({
    ...source,
    subdomains: source.subdomains ? Object.freeze([...source.subdomains]) : undefined,
    bounds: source.bounds ? Object.freeze([...source.bounds]) as readonly [number, number, number, number] : undefined,
    requires: source.requires ? Object.freeze([...source.requires]) : undefined
  });
}

function resolveVariables(
  value: string,
  variables: Readonly<Record<string, string | undefined>>
): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => variables[name] ?? '');
}

function normalizeLevelOffset(value: number): number {
  return Number.isFinite(value) ? Math.max(-8, Math.min(2, value)) : DEFAULT_LEVEL_OFFSET;
}
