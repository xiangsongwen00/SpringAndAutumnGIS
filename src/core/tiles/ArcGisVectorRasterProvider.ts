import {
  MvtRasterProvider,
  type MvtRasterProviderOptions
} from './MvtRasterProvider';

export type ArcGisVectorRasterProviderOptions = Readonly<{
  styleUrl: string;
  id?: string;
  sourceId?: string;
  minLevel?: number;
  maxLevel?: number;
  /** ArcGIS basemap convention currently uses -2 to align its data zoom with globe LOD. */
  levelOffset?: number;
  /** Continuous source zoom = floor(camera zoom + offset). */
  viewLevelOffset?: number | null;
  /** Prevents coarse horizon tiles from using incompatible small-scale map styles. */
  minimumLodLevelOffset?: number;
  /** Re-enables Admin0 country labels when a style explicitly hides them. */
  showCountryLabels?: boolean;
  tileSize?: number;
  attribution?: string;
  fetcher?: typeof fetch;
}>;

/**
 * ArcGIS naming-compatible wrapper around the generic MVT compatibility path.
 * Existing applications keep their API while base and business MVT share the
 * same source, decoder, custom style and terrain-draping implementation.
 */
export class ArcGisVectorRasterProvider extends MvtRasterProvider {
  constructor(options: ArcGisVectorRasterProviderOptions) {
    const generic: MvtRasterProviderOptions = {
      ...options,
      id: options.id ?? 'arcgis-vector-raster'
    };
    super(generic);
  }
}
