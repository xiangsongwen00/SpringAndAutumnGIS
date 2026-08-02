import {
  ArcGisVectorRasterProvider,
  type ArcGisVectorRasterProviderOptions
} from './ArcGisVectorRasterProvider';

/** @deprecated Use ArcGisVectorRasterProvider for the rasterized compatibility path. */
export class VectorStyleTileProvider extends ArcGisVectorRasterProvider {
  constructor(options: VectorStyleTileProviderOptions) {
    super({ ...options, id: options.id ?? 'vector-style' });
  }
}

/** @deprecated Use ArcGisVectorRasterProviderOptions. */
export type VectorStyleTileProviderOptions = ArcGisVectorRasterProviderOptions;
