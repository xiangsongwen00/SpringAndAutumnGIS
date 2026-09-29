import * as THREE from 'three';
import { Ellipsoid } from '../core/geo/Ellipsoid';
import type {
  GeoJsonFeatureCollection,
  GeoJsonGeometry,
  GeoJsonPosition
} from '../feature/GeoJsonSource';
import { globeCoordinateShader } from './shaders/coordinates';
import type { TerrainHeightSource } from './TerrainTileLayer';

export type GeoJsonLayerOptions = Readonly<{
  color?: THREE.ColorRepresentation;
  pointColor?: THREE.ColorRepresentation;
  opacity?: number;
  /** Metres above the ellipsoid or sampled terrain. Defaults to 3 metres. */
  heightOffset?: number;
  pointSize?: number;
  order?: number;
  /** Optional terrain source used for progressive ground clamping. */
  terrain?: TerrainHeightSource;
  /** Maximum unique coordinates sampled per frame. Defaults to 4096. */
  terrainSampleBudget?: number;
  /** Wait for a terrain loading burst to settle before starting a new pass. */
  terrainRefreshDelayMs?: number;
  /** Densifies long chords so they do not pass below the globe. Defaults to 0.1 degree. */
  maximumSegmentDegrees?: number;
}>;

type DrapeGeometry = {
  geometry: THREE.BufferGeometry;
  coordinates: Float64Array;
  heights: THREE.BufferAttribute;
  cursor: number;
};

type CoordinateBuilder = {
  coordinates: number[];
  positions: number[];
  lookup: Map<string, number>;
};

/** Camera-relative GeoJSON points and boundaries with incremental terrain draping. */
export class GeoJsonLayer {
  readonly object3d = new THREE.Group();
  readonly featureCount: number;
  readonly coordinateCount: number;
  private readonly materials: THREE.ShaderMaterial[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly drapeGeometries: DrapeGeometry[] = [];
  private readonly terrain?: TerrainHeightSource;
  private readonly terrainSampleBudget: number;
  private readonly terrainRefreshDelayMs: number;
  private readonly cameraHigh = new THREE.Vector3();
  private readonly cameraLow = new THREE.Vector3();
  private observedTerrainRevision = -1;
  private sampledTerrainRevision = -1;
  private samplingTerrainRevision = -1;
  private terrainRefreshAt = 0;
  private drapeGeometryCursor = 0;

  constructor(
    ellipsoid: Ellipsoid,
    collection: GeoJsonFeatureCollection,
    options: GeoJsonLayerOptions = {}
  ) {
    this.featureCount = collection.features.length;
    this.terrain = options.terrain;
    this.terrainSampleBudget = Math.max(128, Math.round(options.terrainSampleBudget ?? 4096));
    this.terrainRefreshDelayMs = Math.max(0, options.terrainRefreshDelayMs ?? 150);
    const heightOffset = Math.max(0, options.heightOffset ?? 3);
    const maximumSegmentDegrees = THREE.MathUtils.clamp(
      options.maximumSegmentDegrees ?? 0.1,
      0.01,
      10
    );
    const lines = createCoordinateBuilder();
    const points = createCoordinateBuilder();
    const lineIndices: number[] = [];
    const pointIndices: number[] = [];
    const appendPoint = (position: GeoJsonPosition): void => {
      if (validPosition(position)) pointIndices.push(addCoordinate(points, position));
    };
    const appendLine = (positions: readonly GeoJsonPosition[], close: boolean): void => {
      const valid = positions.filter(validPosition);
      for (let index = 1; index < valid.length; index += 1) {
        appendDensifiedSegment(
          lines,
          lineIndices,
          valid[index - 1]!,
          valid[index]!,
          maximumSegmentDegrees
        );
      }
      if (close && valid.length > 2 && !samePosition(valid[0]!, valid[valid.length - 1]!)) {
        appendDensifiedSegment(
          lines,
          lineIndices,
          valid[valid.length - 1]!,
          valid[0]!,
          maximumSegmentDegrees
        );
      }
    };
    for (const feature of collection.features) {
      if (feature.geometry) visitGeometry(feature.geometry, appendPoint, appendLine);
    }

    const opacity = THREE.MathUtils.clamp(options.opacity ?? 1, 0, 1);
    const order = options.order ?? 200;
    if (lineIndices.length > 0) {
      const state = createGeometry(lines, lineIndices);
      const material = this.createMaterial(
        ellipsoid,
        options.color ?? 0x32e6a1,
        opacity,
        heightOffset
      );
      const lineObject = new THREE.LineSegments(state.geometry, material);
      this.configureObject(lineObject, order);
      this.object3d.add(lineObject);
      this.registerGeometry(state, material);
    }
    if (pointIndices.length > 0) {
      const state = createGeometry(points, pointIndices);
      const material = this.createMaterial(
        ellipsoid,
        options.pointColor ?? options.color ?? 0xffd166,
        opacity,
        heightOffset,
        options.pointSize ?? 5
      );
      const pointObject = new THREE.Points(state.geometry, material);
      this.configureObject(pointObject, order);
      this.object3d.add(pointObject);
      this.registerGeometry(state, material);
    }
    this.coordinateCount = this.drapeGeometries.reduce(
      (sum, state) => sum + state.coordinates.length / 2,
      0
    );
    this.object3d.renderOrder = order;
  }

  /** Advances a bounded terrain-clamping pass without blocking the frame. */
  update(cameraPosition?: THREE.Vector3, now = performance.now()): boolean {
    if (cameraPosition) splitVector3(cameraPosition, this.cameraHigh, this.cameraLow);
    if (!this.terrain || this.drapeGeometries.length === 0) return false;
    const revision = this.terrain.revision;
    if (revision !== this.observedTerrainRevision) {
      this.observedTerrainRevision = revision;
      this.terrainRefreshAt = now + this.terrainRefreshDelayMs;
    }
    if (
      this.samplingTerrainRevision < 0 &&
      revision !== this.sampledTerrainRevision &&
      now >= this.terrainRefreshAt
    ) this.startTerrainPass(revision);
    if (this.samplingTerrainRevision < 0) return false;

    let remaining = this.terrainSampleBudget;
    let changed = false;
    while (remaining > 0 && this.drapeGeometryCursor < this.drapeGeometries.length) {
      const state = this.drapeGeometries[this.drapeGeometryCursor]!;
      const vertexCount = state.coordinates.length / 2;
      const start = state.cursor;
      const end = Math.min(vertexCount, start + remaining);
      const heightValues = state.heights.array as Float32Array;
      for (let index = start; index < end; index += 1) {
        const longitude = state.coordinates[index * 2]!;
        const latitude = state.coordinates[index * 2 + 1]!;
        const sampled = this.terrain.enabled
          ? this.terrain.sampleHeight(longitude, latitude)
          : 0;
        if (sampled !== null && heightValues[index] !== sampled) {
          heightValues[index] = sampled;
          changed = true;
        }
      }
      if (end > start) {
        state.heights.clearUpdateRanges();
        state.heights.addUpdateRange(start, end - start);
        state.heights.needsUpdate = true;
      }
      remaining -= end - start;
      state.cursor = end;
      if (state.cursor >= vertexCount) this.drapeGeometryCursor += 1;
    }
    if (this.drapeGeometryCursor >= this.drapeGeometries.length) {
      this.sampledTerrainRevision = this.samplingTerrainRevision;
      this.samplingTerrainRevision = -1;
    }
    return changed;
  }

  setOpacity(opacity: number): void {
    const value = THREE.MathUtils.clamp(opacity, 0, 1);
    for (const material of this.materials) material.uniforms.opacity!.value = value;
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.drapeGeometries.length = 0;
    this.object3d.clear();
  }

  private createMaterial(
    ellipsoid: Ellipsoid,
    color: THREE.ColorRepresentation,
    opacity: number,
    heightOffset: number,
    pointSize = 1
  ): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms: {
        sag_ellipsoidRadii: {
          value: new THREE.Vector2(ellipsoid.equatorialRadius, ellipsoid.polarRadius)
        },
        sag_heightOffset: { value: heightOffset },
        sag_cameraHigh: { value: this.cameraHigh },
        sag_cameraLow: { value: this.cameraLow },
        color: { value: new THREE.Color(color) },
        opacity: { value: opacity },
        pointSize: { value: pointSize }
      },
      vertexShader: /* glsl */ `
        attribute float terrainHeight;
        uniform float pointSize;
        #include <common>
        #include <logdepthbuf_pars_vertex>
        ${globeCoordinateShader}
        void main() {
          gl_Position = sag_projectGeodetic(position.xy, terrainHeight);
          gl_PointSize = pointSize;
          #include <logdepthbuf_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 color;
        uniform float opacity;
        #include <logdepthbuf_pars_fragment>
        void main() {
          gl_FragColor = vec4(color, opacity);
          #include <logdepthbuf_fragment>
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      toneMapped: false
    });
  }

  private configureObject(object: THREE.Object3D, order: number): void {
    object.renderOrder = order;
    object.frustumCulled = false;
    object.onBeforeRender = (_renderer, _scene, camera) => {
      splitVector3(camera.position, this.cameraHigh, this.cameraLow);
    };
  }

  private registerGeometry(state: DrapeGeometry, material: THREE.ShaderMaterial): void {
    this.geometries.push(state.geometry);
    this.materials.push(material);
    this.drapeGeometries.push(state);
  }

  private startTerrainPass(revision: number): void {
    this.samplingTerrainRevision = revision;
    this.drapeGeometryCursor = 0;
    for (const state of this.drapeGeometries) state.cursor = 0;
  }
}

function createCoordinateBuilder(): CoordinateBuilder {
  return { coordinates: [], positions: [], lookup: new Map() };
}

function addCoordinate(builder: CoordinateBuilder, position: GeoJsonPosition): number {
  const key = `${position[0]},${position[1]}`;
  const existing = builder.lookup.get(key);
  if (existing !== undefined) return existing;
  const index = builder.coordinates.length / 2;
  builder.lookup.set(key, index);
  builder.coordinates.push(position[0], position[1]);
  builder.positions.push(
    THREE.MathUtils.degToRad(position[0]),
    THREE.MathUtils.degToRad(position[1]),
    0
  );
  return index;
}

function appendDensifiedSegment(
  builder: CoordinateBuilder,
  indices: number[],
  start: GeoJsonPosition,
  end: GeoJsonPosition,
  maximumDegrees: number
): void {
  if (samePosition(start, end)) return;
  const meanLatitude = THREE.MathUtils.degToRad((start[1] + end[1]) * 0.5);
  const longitudeDelta = shortestLongitudeDelta(start[0], end[0]);
  const longitudeDistance = Math.abs(longitudeDelta) * Math.max(0.05, Math.cos(meanLatitude));
  const latitudeDistance = Math.abs(end[1] - start[1]);
  const angularDistance = Math.hypot(longitudeDistance, latitudeDistance);
  const steps = Math.max(1, Math.ceil(angularDistance / maximumDegrees));
  let previous = addCoordinate(builder, start);
  for (let step = 1; step <= steps; step += 1) {
    const ratio = step / steps;
    const coordinate: GeoJsonPosition = [
      normalizeLongitude(start[0] + longitudeDelta * ratio),
      THREE.MathUtils.lerp(start[1], end[1], ratio)
    ];
    const next = addCoordinate(builder, coordinate);
    indices.push(previous, next);
    previous = next;
  }
}

function createGeometry(builder: CoordinateBuilder, indices: number[]): DrapeGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(builder.positions, 3));
  const heights = new THREE.BufferAttribute(new Float32Array(builder.coordinates.length / 2), 1);
  heights.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('terrainHeight', heights);
  geometry.setIndex(indices);
  return {
    geometry,
    coordinates: new Float64Array(builder.coordinates),
    heights,
    cursor: 0
  };
}

function visitGeometry(
  geometry: GeoJsonGeometry,
  point: (position: GeoJsonPosition) => void,
  line: (positions: readonly GeoJsonPosition[], close: boolean) => void
): void {
  const coordinates = geometry.coordinates as any;
  switch (geometry.type) {
    case 'Point': point(coordinates); break;
    case 'MultiPoint': for (const value of coordinates) point(value); break;
    case 'LineString': line(coordinates, false); break;
    case 'MultiLineString': for (const value of coordinates) line(value, false); break;
    case 'Polygon': for (const ring of coordinates) line(ring, true); break;
    case 'MultiPolygon': for (const polygon of coordinates) for (const ring of polygon) line(ring, true); break;
  }
}

function validPosition(value: unknown): value is GeoJsonPosition {
  return Array.isArray(value) && value.length >= 2 &&
    Number.isFinite(value[0]) && Number.isFinite(value[1]) &&
    value[0] >= -180 && value[0] <= 180 && value[1] >= -90 && value[1] <= 90;
}

function samePosition(a: GeoJsonPosition, b: GeoJsonPosition): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function shortestLongitudeDelta(start: number, end: number): number {
  const delta = end - start;
  return delta > 180 ? delta - 360 : delta < -180 ? delta + 360 : delta;
}

function normalizeLongitude(longitude: number): number {
  if (longitude === 180) return 180;
  return ((longitude + 180) % 360 + 360) % 360 - 180;
}

function splitVector3(value: THREE.Vector3, high: THREE.Vector3, low: THREE.Vector3): void {
  high.set(Math.fround(value.x), Math.fround(value.y), Math.fround(value.z));
  low.set(value.x - high.x, value.y - high.y, value.z - high.z);
}
