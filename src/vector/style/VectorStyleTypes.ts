import type { VectorTileFeature } from '@mapbox/vector-tile';

export type StyleValue = unknown;

export type StyleLayer = {
  id: string;
  type: 'background' | 'fill' | 'line' | 'circle' | 'symbol' | string;
  source?: string;
  'source-layer'?: string;
  minzoom?: number;
  maxzoom?: number;
  filter?: unknown[];
  layout?: Record<string, StyleValue>;
  paint?: Record<string, StyleValue>;
};

export type VectorSource = {
  type: string;
  tiles?: string[];
  /** TileJSON URL used by Mapbox Style v8 sources such as MapTiler. */
  url?: string;
  minzoom?: number;
  maxzoom?: number;
  scheme?: 'xyz' | 'tms';
  subdomains?: readonly string[];
};

export type MapStyle = {
  version: number;
  sprite?: string;
  glyphs?: string;
  sources: Record<string, VectorSource>;
  layers: StyleLayer[];
};

export type DecodedFeature = {
  id?: number;
  type: VectorTileFeature['type'];
  properties: Record<string, number | string | boolean>;
  geometry: ReturnType<VectorTileFeature['loadGeometry']>;
  extent: number;
};

export type DecodedVectorTile = ReadonlyMap<string, readonly DecodedFeature[]>;

export type SelectedVectorSource = Readonly<{
  id: string;
  source: VectorSource;
}>;
