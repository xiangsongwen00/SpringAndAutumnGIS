import * as THREE from 'three';
import { WEB_MERCATOR_MAX_LATITUDE } from '../core/coordinates/CoordinateTransform';
import { Ellipsoid } from '../core/geo/Ellipsoid';
import type { SelectedTile } from '../core/lod/GlobeLodSelector';
import {
  sampleTerrainTile,
  type TerrainProvider,
  type TerrainTileData
} from '../core/terrain/TerrainProvider';
import { tileKey, type TileId } from '../core/tiling/GeographicTilingScheme';
import { globeCoordinateShader } from './shaders/coordinates';

export type TerrainTileLayerOptions = {
  segments?: number;
  maxConcurrentRequests?: number;
  maxCachedTiles?: number;
  exaggeration?: number;
};

export type TerrainTileLayerStats = Readonly<{
  ready: number;
  loading: number;
  queued: number;
  errors: number;
  fallbacks: number;
}>;

export type TerrainTextureBinding = Readonly<{
  key: string;
  texture: THREE.Texture;
  scale: number;
  offsetX: number;
  offsetY: number;
  sourceLevel: number;
  width: number;
  height: number;
}>;

export interface TerrainHeightSource {
  readonly revision: number;
  readonly exaggeration: number;
  resolveTexture(id: TileId): TerrainTextureBinding | undefined;
  sampleHeight(longitude: number, latitude: number): number | null;
}

type TerrainState = 'queued' | 'loading' | 'ready' | 'error';
type TerrainRecord = {
  id: TileId;
  key: string;
  state: TerrainState;
  priority: number;
  lastUsedFrame: number;
  data: TerrainTileData | null;
};
type RenderTile = {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  terrainKey: string;
};

/** Read-only terrain surface with CPU heightfields and GPU vertex displacement. */
export class TerrainTileLayer implements TerrainHeightSource {
  readonly object3d = new THREE.Group();
  readonly provider: TerrainProvider;
  readonly exaggeration: number;

  private readonly ellipsoid: Ellipsoid;
  private readonly baseSegments: number;
  private readonly maxConcurrentRequests: number;
  private readonly maxCachedTiles: number;
  private readonly geometries = new Map<number, THREE.BufferGeometry>();
  private readonly records = new Map<string, TerrainRecord>();
  private readonly renderTiles = new Map<string, RenderTile>();
  private readonly visibleKeys = new Set<string>();
  private readonly cameraHigh = new THREE.Vector3();
  private readonly cameraLow = new THREE.Vector3();
  private frame = 0;
  private activeRequests = 0;
  private fallbackCount = 0;
  private disposed = false;
  private enabled = true;
  private _revision = 0;

  constructor(
    ellipsoid: Ellipsoid,
    provider: TerrainProvider,
    options: TerrainTileLayerOptions = {}
  ) {
    this.ellipsoid = ellipsoid;
    this.provider = provider;
    this.baseSegments = Math.max(16, Math.round(options.segments ?? 64));
    this.maxConcurrentRequests = Math.max(1, Math.round(options.maxConcurrentRequests ?? 6));
    this.maxCachedTiles = Math.max(32, Math.round(options.maxCachedTiles ?? 384));
    this.exaggeration = Math.max(0, options.exaggeration ?? 1);
    this.object3d.renderOrder = 0;
  }

  get revision(): number {
    return this._revision;
  }

  get stats(): TerrainTileLayerStats {
    const counts = { ready: 0, loading: 0, queued: 0, errors: 0 };
    for (const record of this.records.values()) {
      if (record.state === 'error') counts.errors += 1;
      else counts[record.state] += 1;
    }
    return { ...counts, fallbacks: this.fallbackCount };
  }

  update(
    selection: readonly SelectedTile[],
    cameraPosition?: THREE.Vector3
  ): TerrainTileLayerStats {
    if (this.disposed) return this.stats;
    if (cameraPosition) splitVector3(cameraPosition, this.cameraHigh, this.cameraLow);
    this.frame += 1;
    this.syncRenderTiles(selection);
    this.queueVisibleTiles(selection);
    this.pumpQueue();
    this.syncMaterials(selection);
    this.evictTiles();
    return this.stats;
  }

  resolveTexture(id: TileId): TerrainTextureBinding | undefined {
    if (!this.enabled) return undefined;
    const record = this.findReadyAncestor(id);
    if (!record?.data) return undefined;
    const levels = id.level - record.id.level;
    const scale = 1 / 2 ** levels;
    return {
      key: record.key,
      texture: record.data.texture,
      scale,
      offsetX: (id.x - record.id.x * 2 ** levels) * scale,
      offsetY: (id.y - record.id.y * 2 ** levels) * scale,
      sourceLevel: record.id.level,
      width: record.data.width,
      height: record.data.height
    };
  }

  sampleHeight(longitude: number, latitude: number): number | null {
    if (!this.enabled) return null;
    const clampedLatitude = THREE.MathUtils.clamp(
      latitude,
      -WEB_MERCATOR_MAX_LATITUDE,
      WEB_MERCATOR_MAX_LATITUDE
    );
    for (let level = this.provider.maxLevel; level >= this.provider.minLevel; level -= 1) {
      const size = 2 ** level;
      const tileX = ((((longitude + 180) / 360) * size) % size + size) % size;
      const tileY = (
        1 - Math.asinh(Math.tan(THREE.MathUtils.degToRad(clampedLatitude))) / Math.PI
      ) * 0.5 * size;
      const x = Math.min(size - 1, Math.floor(tileX));
      const y = Math.min(size - 1, Math.max(0, Math.floor(tileY)));
      const record = this.records.get(tileKey({ level, x, y }));
      if (record?.state !== 'ready' || !record.data) continue;
      record.lastUsedFrame = this.frame;
      return sampleTerrainTile(record.data, tileX - x, tileY - y) * this.exaggeration;
    }
    return null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const renderTile of this.renderTiles.values()) renderTile.mesh.material.dispose();
    for (const record of this.records.values()) record.data?.texture.dispose();
    for (const geometry of this.geometries.values()) geometry.dispose();
    this.renderTiles.clear();
    this.records.clear();
    this.geometries.clear();
    this.object3d.clear();
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.object3d.visible = enabled;
    this._revision += 1;
  }

  private syncRenderTiles(selection: readonly SelectedTile[]): void {
    const selectedKeys = new Set(selection.map((tile) => tileKey(tile.id)));
    for (const [key, renderTile] of this.renderTiles) {
      if (selectedKeys.has(key)) continue;
      this.object3d.remove(renderTile.mesh);
      renderTile.mesh.material.dispose();
      this.renderTiles.delete(key);
    }
    for (const tile of selection) {
      const key = tileKey(tile.id);
      if (this.renderTiles.has(key)) continue;
      const mesh = new THREE.Mesh(
        this.geometryForLevel(tile.id.level),
        this.createMaterial(tile.id)
      );
      mesh.frustumCulled = false;
      mesh.renderOrder = 0;
      mesh.onBeforeRender = (_renderer, _scene, camera) => {
        splitVector3(camera.position, this.cameraHigh, this.cameraLow);
      };
      this.renderTiles.set(key, { mesh, terrainKey: '' });
      this.object3d.add(mesh);
    }
  }

  private geometryForLevel(level: number): THREE.BufferGeometry {
    const segments = Math.max(this.baseSegments, Math.round(1024 / 2 ** level));
    let geometry = this.geometries.get(segments);
    if (!geometry) {
      geometry = createGridGeometry(segments);
      this.geometries.set(segments, geometry);
    }
    return geometry;
  }

  private queueVisibleTiles(selection: readonly SelectedTile[]): void {
    this.visibleKeys.clear();
    for (let rank = 0; rank < selection.length; rank += 1) {
      const selected = selection[rank];
      if (!selected) continue;
      const maximumLevel = Math.min(selected.id.level, this.provider.maxLevel);
      for (let level = this.provider.minLevel; level <= maximumLevel; level += 1) {
        const shift = selected.id.level - level;
        const id: TileId = {
          level,
          x: Math.floor(selected.id.x / 2 ** shift),
          y: Math.floor(selected.id.y / 2 ** shift)
        };
        const key = tileKey(id);
        this.visibleKeys.add(key);
        const existing = this.records.get(key);
        if (existing) {
          existing.lastUsedFrame = this.frame;
          if (existing.state === 'queued') existing.priority = Math.min(existing.priority, level * 10_000 + rank);
          continue;
        }
        this.records.set(key, {
          id,
          key,
          state: 'queued',
          priority: level * 10_000 + rank,
          lastUsedFrame: this.frame,
          data: null
        });
      }
    }
    for (const [key, record] of this.records) {
      if (this.visibleKeys.has(key) || record.state === 'ready' || record.state === 'loading') continue;
      this.records.delete(key);
    }
  }

  private pumpQueue(): void {
    while (this.activeRequests < this.maxConcurrentRequests) {
      let next: TerrainRecord | undefined;
      for (const record of this.records.values()) {
        if (record.state !== 'queued') continue;
        if (!next || record.priority < next.priority) next = record;
      }
      if (!next) return;
      this.load(next);
    }
  }

  private load(record: TerrainRecord): void {
    record.state = 'loading';
    this.activeRequests += 1;
    void this.provider.loadTile(record.id).then(
      (data) => {
        this.activeRequests = Math.max(0, this.activeRequests - 1);
        if (this.disposed || this.records.get(record.key) !== record) {
          data.texture.dispose();
        } else {
          record.data = data;
          record.state = 'ready';
          record.lastUsedFrame = this.frame;
          this._revision += 1;
        }
        this.pumpQueue();
      },
      () => {
        this.activeRequests = Math.max(0, this.activeRequests - 1);
        if (!this.disposed && this.records.get(record.key) === record) record.state = 'error';
        this.pumpQueue();
      }
    );
  }

  private syncMaterials(selection: readonly SelectedTile[]): void {
    this.fallbackCount = 0;
    for (const tile of selection) {
      const renderTile = this.renderTiles.get(tileKey(tile.id));
      if (!renderTile) continue;
      const binding = this.resolveTexture(tile.id);
      if (binding && binding.key.split('/')[0] !== String(tile.id.level)) this.fallbackCount += 1;
      const nextKey = binding?.key ?? '';
      if (nextKey === renderTile.terrainKey) continue;
      renderTile.terrainKey = nextKey;
      const uniforms = renderTile.mesh.material.uniforms;
      uniforms.terrainTexture!.value = binding?.texture ?? null;
      uniforms.hasTerrain!.value = binding !== undefined;
      (uniforms.terrainUvScale!.value as THREE.Vector2).setScalar(binding?.scale ?? 1);
      (uniforms.terrainUvOffset!.value as THREE.Vector2).set(
        binding?.offsetX ?? 0,
        binding?.offsetY ?? 0
      );
    }
  }

  private findReadyAncestor(id: TileId): TerrainRecord | undefined {
    const maximumLevel = Math.min(id.level, this.provider.maxLevel);
    for (let level = maximumLevel; level >= this.provider.minLevel; level -= 1) {
      const shift = id.level - level;
      const record = this.records.get(tileKey({
        level,
        x: Math.floor(id.x / 2 ** shift),
        y: Math.floor(id.y / 2 ** shift)
      }));
      if (record?.state === 'ready' && record.data) {
        record.lastUsedFrame = this.frame;
        return record;
      }
    }
    return undefined;
  }

  private evictTiles(): void {
    if (this.records.size <= this.maxCachedTiles) return;
    const protectedKeys = new Set(this.visibleKeys);
    for (const renderTile of this.renderTiles.values()) {
      if (renderTile.terrainKey) protectedKeys.add(renderTile.terrainKey);
    }
    const candidates = [...this.records.values()]
      .filter((record) => record.state !== 'loading' && !protectedKeys.has(record.key))
      .sort((a, b) => a.lastUsedFrame - b.lastUsedFrame);
    while (this.records.size > this.maxCachedTiles) {
      const record = candidates.shift();
      if (!record) break;
      record.data?.texture.dispose();
      this.records.delete(record.key);
    }
  }

  private createMaterial(tile: TileId): THREE.ShaderMaterial {
    const size = 2 ** tile.level;
    const longitudeCenter = -Math.PI + ((tile.x + 0.5) / size) * Math.PI * 2;
    const longitudeSpan = Math.PI * 2 / size;
    const mercatorCenter = Math.PI - ((tile.y + 0.5) / size) * Math.PI * 2;
    const mercatorSpan = -Math.PI * 2 / size;
    const latitudeCenter = Math.atan(Math.sinh(mercatorCenter));
    const sinLongitude = Math.sin(longitudeCenter);
    const cosLongitude = Math.cos(longitudeCenter);
    const sinLatitude = Math.sin(latitudeCenter);
    const cosLatitude = Math.cos(latitudeCenter);
    const tileOrigin = this.ellipsoid.cartographicToCartesian({
      longitude: THREE.MathUtils.radToDeg(longitudeCenter),
      latitude: THREE.MathUtils.radToDeg(latitudeCenter)
    });
    const originHigh = new THREE.Vector3();
    const originLow = new THREE.Vector3();
    splitVector3(tileOrigin, originHigh, originLow);
    const a = this.ellipsoid.equatorialRadius;
    const b = this.ellipsoid.polarRadius;
    const eccentricitySquared = 1 - (b * b) / (a * a);
    const latitudeTerm = 1 - eccentricitySquared * sinLatitude * sinLatitude;
    return new THREE.ShaderMaterial({
      uniforms: {
        sag_ellipsoidRadii: { value: new THREE.Vector2(this.ellipsoid.equatorialRadius, this.ellipsoid.polarRadius) },
        sag_heightOffset: { value: 0 },
        sag_cameraHigh: { value: this.cameraHigh },
        sag_cameraLow: { value: this.cameraLow },
        sag_originHigh: { value: originHigh },
        sag_originLow: { value: originLow },
        sag_east: { value: new THREE.Vector3(cosLongitude, 0, -sinLongitude) },
        sag_north: { value: new THREE.Vector3(-sinLatitude * sinLongitude, cosLatitude, -sinLatitude * cosLongitude) },
        sag_up: { value: new THREE.Vector3(cosLatitude * sinLongitude, sinLatitude, cosLatitude * cosLongitude) },
        sag_curvatureRadii: {
          value: new THREE.Vector2(
            a / Math.sqrt(latitudeTerm),
            (a * (1 - eccentricitySquared)) / latitudeTerm ** 1.5
          )
        },
        sag_useLocalCoordinates: { value: tile.level >= 18 },
        tileLongitudeSinCos: { value: new THREE.Vector2(sinLongitude, cosLongitude) },
        tileLongitudeSpan: { value: longitudeSpan },
        tileLatitudeSinCos: { value: new THREE.Vector2(sinLatitude, cosLatitude) },
        tileMercatorSinhCosh: { value: new THREE.Vector2(Math.sinh(mercatorCenter), Math.cosh(mercatorCenter)) },
        tileMercatorSpan: { value: mercatorSpan },
        terrainTexture: { value: null },
        terrainUvScale: { value: new THREE.Vector2(1, 1) },
        terrainUvOffset: { value: new THREE.Vector2(0, 0) },
        hasTerrain: { value: false },
        terrainExaggeration: { value: this.exaggeration }
      },
      vertexShader: /* glsl */ `
        varying vec3 v_globeNormal;
        varying float v_height;
        uniform vec3 sag_originHigh;
        uniform vec3 sag_originLow;
        uniform vec3 sag_east;
        uniform vec3 sag_north;
        uniform vec3 sag_up;
        uniform vec2 sag_curvatureRadii;
        uniform bool sag_useLocalCoordinates;
        uniform vec2 tileLongitudeSinCos;
        uniform float tileLongitudeSpan;
        uniform vec2 tileLatitudeSinCos;
        uniform vec2 tileMercatorSinhCosh;
        uniform float tileMercatorSpan;
        uniform sampler2D terrainTexture;
        uniform vec2 terrainUvScale;
        uniform vec2 terrainUvOffset;
        uniform bool hasTerrain;
        uniform float terrainExaggeration;
        #include <common>
        #include <logdepthbuf_pars_vertex>
        ${globeCoordinateShader}
        void main() {
          float deltaLongitude = (position.x - 0.5) * tileLongitudeSpan;
          vec2 longitudeSinCos = vec2(
            tileLongitudeSinCos.x * cos(deltaLongitude) + tileLongitudeSinCos.y * sin(deltaLongitude),
            tileLongitudeSinCos.y * cos(deltaLongitude) - tileLongitudeSinCos.x * sin(deltaLongitude)
          );
          float deltaMercator = (position.y - 0.5) * tileMercatorSpan;
          float sinhDelta = 0.5 * (exp(deltaMercator) - exp(-deltaMercator));
          float coshDelta = 0.5 * (exp(deltaMercator) + exp(-deltaMercator));
          float sinhMercator = tileMercatorSinhCosh.x * coshDelta + tileMercatorSinhCosh.y * sinhDelta;
          float cosLatitude = inversesqrt(1.0 + sinhMercator * sinhMercator);
          float sinLatitude = sinhMercator * cosLatitude;
          vec2 terrainUv = terrainUvOffset + uv * terrainUvScale;
          float heightMeters = hasTerrain ? texture2D(terrainTexture, terrainUv).r * terrainExaggeration : 0.0;
          v_height = heightMeters;
          v_globeNormal = normalize(vec3(cosLatitude * longitudeSinCos.x, sinLatitude, cosLatitude * longitudeSinCos.y));
          if (sag_useLocalCoordinates) {
            float deltaLatitude =
              tileLatitudeSinCos.y * deltaMercator -
              0.5 * tileLatitudeSinCos.x * tileLatitudeSinCos.y * deltaMercator * deltaMercator;
            float latitudeMidpoint = 0.5 * deltaLatitude;
            float midpointCosLatitude =
              tileLatitudeSinCos.y * cos(latitudeMidpoint) -
              tileLatitudeSinCos.x * sin(latitudeMidpoint);
            float eastMeters = sag_curvatureRadii.x * midpointCosLatitude * deltaLongitude;
            float northMeters = sag_curvatureRadii.y * deltaLatitude;
            float upMeters = -0.5 * (
              eastMeters * eastMeters / sag_curvatureRadii.x +
              northMeters * northMeters / sag_curvatureRadii.y
            );
            vec3 localWorld =
              sag_east * eastMeters +
              sag_north * northMeters +
              sag_up * (upMeters + heightMeters);
            gl_Position = sag_projectLocalToEye(localWorld, sag_originHigh, sag_originLow);
          } else {
            gl_Position = sag_projectGeodeticTrig(
              longitudeSinCos,
              vec2(sinLatitude, cosLatitude),
              heightMeters
            );
          }
          #include <logdepthbuf_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 v_globeNormal;
        varying float v_height;
        #include <logdepthbuf_pars_fragment>
        void main() {
          float light = 0.55 + 0.45 * max(dot(normalize(v_globeNormal), normalize(vec3(-0.35, 0.55, 1.0))), 0.0);
          float elevation = clamp((v_height + 500.0) / 5000.0, 0.0, 1.0);
          vec3 base = mix(vec3(0.08, 0.20, 0.16), vec3(0.42, 0.38, 0.29), elevation);
          gl_FragColor = vec4(base * light, 1.0);
          #include <logdepthbuf_fragment>
          #include <colorspace_fragment>
        }
      `,
      depthWrite: true,
      depthTest: true,
      toneMapped: false
    });
  }
}

function createGridGeometry(segmentsInput: number): THREE.BufferGeometry {
  const segments = Math.max(2, Math.round(segmentsInput));
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let y = 0; y <= segments; y += 1) {
    for (let x = 0; x <= segments; x += 1) {
      positions.push(x / segments, y / segments, 0);
      uvs.push(x / segments, y / segments);
    }
  }
  const columns = segments + 1;
  for (let y = 0; y < segments; y += 1) {
    for (let x = 0; x < segments; x += 1) {
      const a = y * columns + x;
      const b = a + 1;
      const c = a + columns;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

function splitVector3(value: THREE.Vector3, high: THREE.Vector3, low: THREE.Vector3): void {
  high.set(Math.fround(value.x), Math.fround(value.y), Math.fround(value.z));
  low.set(value.x - high.x, value.y - high.y, value.z - high.z);
}
