import { VectorStyleRuntime, type EvaluatedBucket } from '../style/VectorStyleRuntime';
import { buildBackgroundGeometry, buildFillGeometry, buildLineGeometry, buildPointGeometry, type GeometryBuilder } from '../bucket/VectorGeometryBuilder';
import type { TileId } from '../../core/tiling/GeographicTilingScheme';
import type { DecodedVectorTile } from '../style/VectorStyleTypes';
export type NativeGeometry = { positions: Float32Array; uvs: Float32Array; indices: Uint32Array };
export type NativeBucket = EvaluatedBucket & { geometry?: NativeGeometry; outline?: NativeGeometry };
export function buildNativeBuckets(runtime: VectorStyleRuntime, decoded: DecodedVectorTile,
  id: TileId, sourceId: string, types: ReadonlySet<string>): NativeBucket[] {
  const convert = (builder: GeometryBuilder): NativeGeometry => ({ positions: new Float32Array(builder.positions),
    uvs: new Float32Array(builder.uvs), indices: new Uint32Array(builder.indices) });
  return runtime.buckets(decoded, sourceId, id.level, types).map(bucket => {
    const { layer, features } = bucket;
    const geometry = layer.type === 'fill' ? convert(buildFillGeometry(id, features))
      : layer.type === 'line' ? convert(buildLineGeometry(id, features))
      : layer.type === 'circle' ? convert(buildPointGeometry(id, features))
      : layer.type === 'background' ? convert(buildBackgroundGeometry(id)) : undefined;
    const outline = layer.type === 'fill' && layer.paint?.['fill-outline-color'] !== undefined
      ? convert(buildLineGeometry(id, features)) : undefined;
    // Geometry consumers only need nonempty status; symbols still need actual
    // point/property candidates for their bounded main-thread text pass.
    return { ...bucket, features: layer.type === 'symbol' ? features : features.slice(0, 1), geometry, outline };
  });
}
