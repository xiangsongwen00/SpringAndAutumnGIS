import * as THREE from 'three';
import type { TileId } from '../../core/tiling/GeographicTilingScheme';
import type { DecodedFeature } from '../style/VectorStyleTypes';

export type GeometryBuilder = {
  coordinates: number[];
  positions: number[];
  heights: number[];
  indices: number[];
  uvs: number[];
  distances?: number[];
};

/** Pixel-width stroke quads for the cartographic GPU surface pass (butt caps). */
export function buildLineStrokeGeometry(id: TileId, features: readonly DecodedFeature[], width: number, tileSize: number): GeometryBuilder {
  const builder = createBuilder();
  builder.distances = [];
  for (const feature of features) {
    if (feature.type !== 2 && feature.type !== 3) continue;
    for (const line of feature.geometry) {
      let distance = 0;
      for (let index = 1; index < line.length; index += 1) {
        const a = line[index - 1]!, b = line[index]!;
        const dx = (b.x - a.x) / feature.extent, dy = (b.y - a.y) / feature.extent;
        const length = Math.hypot(dx, dy);
        if (length === 0) continue;
        const nx = -dy / length * width / tileSize / 2;
        const ny = dx / length * width / tileSize / 2;
        const start = builder.positions.length / 3;
        const distanceEnd = distance + length * tileSize;
        for (const [point, sign, along] of [[a, 1, distance], [a, -1, distance], [b, 1, distanceEnd], [b, -1, distanceEnd]] as const) {
          appendTilePoint(builder, id, point.x / feature.extent + nx * sign, point.y / feature.extent + ny * sign, 1);
          builder.distances.push(along);
        }
        builder.indices.push(start, start + 1, start + 2, start + 1, start + 3, start + 2);
        distance = distanceEnd;
      }
    }
  }
  return builder;
}

export function buildFillGeometry(id: TileId, features: readonly DecodedFeature[], subdivide = true): GeometryBuilder {
  const builder = createBuilder();
  for (const feature of features) {
    if (feature.type !== 3) continue;
    for (const polygon of classifyRings(feature.geometry)) {
      const contour = polygon[0];
      if (!contour || contour.length < 3) continue;
      const rings = polygon.map((ring) => ring.map((point) => new THREE.Vector2(point.x, point.y)));
      const faces = THREE.ShapeUtils.triangulateShape(rings[0]!, rings.slice(1));
      const offsets: number[] = [];
      // ShapeUtils removes duplicate closing vertices in-place; all offsets
      // must use those same normalized rings, otherwise holes index the wrong vertices.
      for (const ring of rings) {
        offsets.push(builder.positions.length / 3);
        for (const point of ring) appendTilePoint(builder, id, point.x, point.y, feature.extent);
      }
      const flattened: number[] = [];
      rings.forEach((ring, ringIndex) => {
        const start = offsets[ringIndex]!;
        for (let index = 0; index < ring.length; index += 1) flattened.push(start + index);
      });
      for (const face of faces) {
        const [a, b, c] = face;
        if (a === undefined || b === undefined || c === undefined) continue;
        builder.indices.push(flattened[a]!, flattened[b]!, flattened[c]!);
      }
    }
  }
  return subdivide ? subdivideSurface(id, builder) : builder;
}

/** Bound triangle span in tile space so terrain interiors and globe curvature have vertices. */
function subdivideSurface(id: TileId, source: GeometryBuilder): GeometryBuilder {
  const result = createBuilder();
  type Point = readonly [number, number];
  const point = (index: number): Point => [source.uvs[index * 2]!, source.uvs[index * 2 + 1]!];
  const emit = (a: Point, b: Point, c: Point, depth: number): void => {
    const edges = [[a, b, c], [b, c, a], [c, a, b]] as const;
    const edge = [...edges].sort((left, right) =>
      Math.hypot(right[0][0] - right[1][0], right[0][1] - right[1][1]) -
      Math.hypot(left[0][0] - left[1][0], left[0][1] - left[1][1]))[0]!;
    if (depth < 10 && Math.hypot(edge[0][0] - edge[1][0], edge[0][1] - edge[1][1]) > 1 / 16) {
      const mid: Point = [(edge[0][0] + edge[1][0]) / 2, (edge[0][1] + edge[1][1]) / 2];
      emit(edge[0], mid, edge[2], depth + 1);
      emit(mid, edge[1], edge[2], depth + 1);
      return;
    }
    const offset = result.positions.length / 3;
    for (const vertex of [a, b, c]) appendTilePoint(result, id, vertex[0], vertex[1], 1);
    result.indices.push(offset, offset + 1, offset + 2);
  };
  for (let index = 0; index < source.indices.length; index += 3) {
    emit(point(source.indices[index]!), point(source.indices[index + 1]!), point(source.indices[index + 2]!), 0);
  }
  return result;
}

export function buildBackgroundGeometry(id: TileId): GeometryBuilder {
  const builder = createBuilder();
  const steps = 32;
  for (let y = 0; y <= steps; y += 1) for (let x = 0; x <= steps; x += 1) {
    appendTilePoint(builder, id, x, y, steps);
  }
  for (let y = 0; y < steps; y += 1) for (let x = 0; x < steps; x += 1) {
    const a = y * (steps + 1) + x;
    builder.indices.push(a, a + 1, a + steps + 1, a + 1, a + steps + 2, a + steps + 1);
  }
  return builder;
}

export function buildLineGeometry(id: TileId, features: readonly DecodedFeature[]): GeometryBuilder {
  const builder = createBuilder();
  for (const feature of features) {
    if (feature.type !== 2 && feature.type !== 3) continue;
    for (const line of feature.geometry) {
      for (let index = 1; index < line.length; index += 1) {
        const previous = line[index - 1]!;
        const current = line[index]!;
        const steps = Math.min(64, Math.max(1, Math.ceil(Math.hypot(current.x - previous.x, current.y - previous.y) / feature.extent * 32)));
        for (let step = 0; step < steps; step += 1) {
          for (const amount of [step / steps, (step + 1) / steps]) {
            appendTilePoint(builder, id,
              THREE.MathUtils.lerp(previous.x, current.x, amount),
              THREE.MathUtils.lerp(previous.y, current.y, amount), feature.extent);
          }
        }
      }
    }
  }
  return builder;
}

export function buildPointGeometry(id: TileId, features: readonly DecodedFeature[]): GeometryBuilder {
  const builder = createBuilder();
  for (const feature of features) {
    if (feature.type !== 1) continue;
    for (const line of feature.geometry) {
      for (const point of line) appendTilePoint(builder, id, point.x, point.y, feature.extent);
    }
  }
  return builder;
}

export function firstPoint(id: TileId, feature: DecodedFeature): readonly [number, number] | null {
  const point = feature.geometry[0]?.[0];
  return point ? tilePointToGeographic(id, point.x, point.y, feature.extent) : null;
}

function appendTilePoint(builder: GeometryBuilder, id: TileId, x: number, y: number, extent: number): void {
  const [longitude, latitude] = tilePointToGeographic(id, x, y, extent);
  // Terrain sampling and labels consume degrees; the native globe shader's
  // geodetic position contract is radians.
  builder.coordinates.push(longitude, latitude);
  builder.uvs.push(x / extent, y / extent);
  const [shaderLongitude, shaderLatitude] = geographicDegreesToShaderRadians(
    longitude,
    latitude
  );
  builder.positions.push(shaderLongitude, shaderLatitude, 0);
  builder.heights.push(0);
}

/** Convert public/terrain degree coordinates to the native globe shader contract. */
export function geographicDegreesToShaderRadians(
  longitude: number,
  latitude: number
): readonly [number, number] {
  return [THREE.MathUtils.degToRad(longitude), THREE.MathUtils.degToRad(latitude)];
}

function tilePointToGeographic(
  id: TileId, x: number, y: number, extent: number
): readonly [number, number] {
  const size = 2 ** id.level;
  const u = (id.x + x / extent) / size;
  const v = (id.y + y / extent) / size;
  const longitude = u * 360 - 180;
  const latitude = Math.atan(Math.sinh(Math.PI * (1 - 2 * v))) * 180 / Math.PI;
  return [longitude, latitude];
}

export function webMercatorTileBounds(id: TileId): readonly [number, number, number, number] {
  const size = 2 ** id.level;
  const west = id.x / size * 360 - 180;
  const east = (id.x + 1) / size * 360 - 180;
  const north = Math.atan(Math.sinh(Math.PI - id.y / size * Math.PI * 2)) * 180 / Math.PI;
  const south = Math.atan(Math.sinh(Math.PI - (id.y + 1) / size * Math.PI * 2)) * 180 / Math.PI;
  return [west, south, east, north];
}

function classifyRings(geometry: DecodedFeature['geometry']) {
  const polygons: Array<Array<DecodedFeature['geometry'][number]>> = [];
  let current: Array<DecodedFeature['geometry'][number]> | null = null;
  let outerSign = 0;
  for (const ring of geometry) {
    const area = signedArea(ring);
    if (area === 0) continue;
    const sign = Math.sign(area);
    if (outerSign === 0) outerSign = sign;
    if (sign === outerSign || !current) {
      current = [ring];
      polygons.push(current);
    } else current.push(ring);
  }
  return polygons;
}

function signedArea(ring: DecodedFeature['geometry'][number]): number {
  let sum = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index]!;
    const next = ring[(index + 1) % ring.length]!;
    sum += current.x * next.y - next.x * current.y;
  }
  return sum * 0.5;
}

function createBuilder(): GeometryBuilder {
  return { coordinates: [], positions: [], heights: [], indices: [], uvs: [] };
}

export function ancestorAtLevel(id: TileId, level: number): TileId {
  const shift = Math.max(0, id.level - level);
  return { level, x: Math.floor(id.x / 2 ** shift), y: Math.floor(id.y / 2 ** shift) };
}


