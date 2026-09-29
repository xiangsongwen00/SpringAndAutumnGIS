export type GeoJsonPosition = readonly [number, number, ...number[]];
export type GeoJsonGeometry = Readonly<{
  type: 'Point' | 'MultiPoint' | 'LineString' | 'MultiLineString' | 'Polygon' | 'MultiPolygon';
  coordinates: unknown;
}>;
export type GeoJsonFeature = Readonly<{
  type: 'Feature';
  id?: string | number;
  properties?: Readonly<Record<string, unknown>> | null;
  geometry: GeoJsonGeometry | null;
}>;
export type GeoJsonFeatureCollection = Readonly<{
  type: 'FeatureCollection';
  features: readonly GeoJsonFeature[];
  crs?: unknown;
}>;

export type GeoJsonSourceOptions = Readonly<{
  id: string;
  url: string;
  maxFeatures?: number;
  crs?: string;
}>;

/** Validated URL-backed GeoJSON source. Rendering remains owned by GeoJsonLayer. */
export class GeoJsonSource {
  readonly id: string;
  readonly url: string;
  readonly maxFeatures: number;
  readonly crs: string;

  constructor(options: GeoJsonSourceOptions) {
    if (!options.id.trim()) throw new Error('GeoJSON source id is required.');
    if (!options.url.trim()) throw new Error(`GeoJSON URL is required: ${options.id}`);
    this.id = options.id;
    this.url = options.url;
    this.maxFeatures = Math.max(1, Math.round(options.maxFeatures ?? 5_000));
    this.crs = options.crs ?? 'EPSG:4326';
  }

  async load(signal?: AbortSignal): Promise<GeoJsonFeatureCollection> {
    const response = await fetch(this.url, { signal });
    if (!response.ok) throw new Error(`GeoJSON 请求失败 (${response.status}): ${this.url}`);
    const value: unknown = await response.json();
    if (!isRecord(value) || value.type !== 'FeatureCollection' || !Array.isArray(value.features)) {
      throw new Error(`GeoJSON source ${this.id} must contain a FeatureCollection.`);
    }
    if (value.features.length > this.maxFeatures) {
      throw new Error(
        `GeoJSON source ${this.id} contains ${value.features.length} features; ` +
        `configured limit is ${this.maxFeatures}.`
      );
    }
    for (let index = 0; index < value.features.length; index += 1) {
      const feature = value.features[index];
      if (!isRecord(feature) || feature.type !== 'Feature') {
        throw new Error(`Invalid GeoJSON feature at index ${index}: ${this.id}`);
      }
    }
    return value as GeoJsonFeatureCollection;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
