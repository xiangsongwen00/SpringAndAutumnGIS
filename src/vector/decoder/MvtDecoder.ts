import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import type {
  DecodedFeature,
  DecodedVectorTile
} from '../style/VectorStyleTypes';

/** Converts PBF bytes into renderer-independent feature geometry. */
export class MvtDecoder {
  decode(
    bytes: ArrayBuffer,
    requestedLayers?: ReadonlySet<string>
  ): DecodedVectorTile {
    const tile = new VectorTile(new PbfReader(bytes));
    const decoded = new Map<string, readonly DecodedFeature[]>();
    for (const [name, layer] of Object.entries(tile.layers)) {
      if (requestedLayers && !requestedLayers.has(name)) continue;
      const features: DecodedFeature[] = [];
      for (let index = 0; index < layer.length; index += 1) {
        const feature = layer.feature(index);
        features.push({
          type: feature.type,
          properties: feature.properties,
          geometry: feature.loadGeometry(),
          extent: feature.extent
        });
      }
      decoded.set(name, features);
    }
    return decoded;
  }
}
