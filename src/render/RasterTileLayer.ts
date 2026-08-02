import * as THREE from 'three';
import { Ellipsoid } from '../core/geo/Ellipsoid';
import type { SelectedTile } from '../core/lod/GlobeLodSelector';
import type { RasterTileProvider } from '../core/tiles/RasterTileProvider';
import { tileKey, type TileId } from '../core/tiling/GeographicTilingScheme';
import { globeCoordinateShader } from './shaders/coordinates';

export type RasterTileLayerOptions = {
  segments?: number;
  maxConcurrentRequests?: number;
  maxCachedTiles?: number;
  surfaceOffset?: number;
  maxAnisotropy?: number;
};

export type RasterTileLayerStats = Readonly<{
  ready: number;
  loading: number;
  queued: number;
  errors: number;
  fallbacks: number;
}>;

type TextureState = 'queued' | 'loading' | 'ready' | 'error';
type TextureRecord = {
  id: TileId;
  key: string;
  state: TextureState;
  priority: number;
  lastUsedFrame: number;
  texture: THREE.Texture | null;
};
type RenderTile = {
  id: TileId;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  textureKey: string;
};

/** Visible-leaf raster consumer. Selection remains owned by GlobeLodSelector. */
export class RasterTileLayer {
  readonly object3d = new THREE.Group();
  provider: RasterTileProvider;

  private readonly ellipsoid: Ellipsoid;
  private readonly geometry: THREE.BufferGeometry;
  private readonly loader = new THREE.TextureLoader();
  private readonly renderTiles = new Map<string, RenderTile>();
  private readonly textures = new Map<string, TextureRecord>();
  private readonly visibleTextureKeys = new Set<string>();
  private readonly maxConcurrentRequests: number;
  private readonly maxCachedTiles: number;
  private readonly surfaceOffset: number;
  private readonly maxAnisotropy: number;
  private readonly cameraHigh = new THREE.Vector3();
  private readonly cameraLow = new THREE.Vector3();
  private readonly tileOrigin = new THREE.Vector3();
  private frame = 0;
  private activeRequests = 0;
  private disposed = false;
  private fallbackCount = 0;

  constructor(
    ellipsoid: Ellipsoid,
    provider: RasterTileProvider,
    options: RasterTileLayerOptions = {}
  ) {
    this.ellipsoid = ellipsoid;
    this.provider = provider;
    this.geometry = createGridGeometry(options.segments ?? 16);
    this.maxConcurrentRequests = Math.max(1, Math.round(options.maxConcurrentRequests ?? 8));
    this.maxCachedTiles = Math.max(16, Math.round(options.maxCachedTiles ?? 512));
    this.surfaceOffset = Math.max(0, options.surfaceOffset ?? 0.1);
    this.maxAnisotropy = Math.max(1, options.maxAnisotropy ?? 1);
    this.loader.setCrossOrigin('anonymous');
    this.object3d.renderOrder = 1;
  }

  update(
    selection: readonly SelectedTile[],
    cameraPosition?: THREE.Vector3
  ): RasterTileLayerStats {
    if (this.disposed) return this.stats;
    if (cameraPosition) splitVector3(cameraPosition, this.cameraHigh, this.cameraLow);
    this.frame += 1;
    this.syncRenderTiles(selection);
    this.queueVisibleTextures(selection);
    this.pumpQueue();
    this.syncMaterials(selection);
    this.evictTextures();
    return this.stats;
  }

  get stats(): RasterTileLayerStats {
    const counts = { ready: 0, loading: 0, queued: 0, errors: 0 };
    for (const record of this.textures.values()) {
      if (record.state === 'error') counts.errors += 1;
      else counts[record.state] += 1;
    }
    return { ...counts, fallbacks: this.fallbackCount };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const renderTile of this.renderTiles.values()) renderTile.mesh.material.dispose();
    for (const record of this.textures.values()) record.texture?.dispose();
    this.renderTiles.clear();
    this.textures.clear();
    this.geometry.dispose();
    this.object3d.clear();
  }

  setProvider(provider: RasterTileProvider): void {
    if (provider.id === this.provider.id) return;
    this.provider = provider;
    for (const record of this.textures.values()) record.texture?.dispose();
    this.textures.clear();
    this.visibleTextureKeys.clear();
    this.fallbackCount = 0;
    for (const renderTile of this.renderTiles.values()) {
      renderTile.textureKey = '';
      const uniforms = renderTile.mesh.material.uniforms;
      if (!uniforms) continue;
      uniforms.tileTexture!.value = null;
      uniforms.hasTexture!.value = false;
    }
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
      const material = this.createMaterial(tile.id);
      const mesh = new THREE.Mesh(this.geometry, material);
      mesh.frustumCulled = false;
      mesh.renderOrder = 1;
      mesh.onBeforeRender = (_renderer, _scene, camera) => {
        splitVector3(camera.position, this.cameraHigh, this.cameraLow);
      };
      this.renderTiles.set(key, { id: tile.id, mesh, textureKey: '' });
      this.object3d.add(mesh);
    }
  }

  private createMaterial(tile: TileId): THREE.ShaderMaterial {
    const size = 2 ** tile.level;
    const west = -Math.PI + (tile.x / size) * Math.PI * 2;
    const east = -Math.PI + ((tile.x + 1) / size) * Math.PI * 2;
    const northMercator = Math.PI - (tile.y / size) * Math.PI * 2;
    const southMercator = Math.PI - ((tile.y + 1) / size) * Math.PI * 2;
    const longitudeCenter = (west + east) * 0.5;
    const longitudeSpan = east - west;
    const mercatorCenter = (northMercator + southMercator) * 0.5;
    const mercatorSpan = southMercator - northMercator;
    const latitudeCenter = Math.atan(Math.sinh(mercatorCenter));
    const sinLongitude = Math.sin(longitudeCenter);
    const cosLongitude = Math.cos(longitudeCenter);
    const sinLatitude = Math.sin(latitudeCenter);
    const cosLatitude = Math.cos(latitudeCenter);
    this.ellipsoid.cartographicToCartesian(
      {
        longitude: THREE.MathUtils.radToDeg(longitudeCenter),
        latitude: THREE.MathUtils.radToDeg(latitudeCenter),
        height: this.surfaceOffset
      },
      this.tileOrigin
    );
    const originHigh = new THREE.Vector3();
    const originLow = new THREE.Vector3();
    splitVector3(this.tileOrigin, originHigh, originLow);
    const a = this.ellipsoid.equatorialRadius;
    const b = this.ellipsoid.polarRadius;
    const eccentricitySquared = 1 - (b * b) / (a * a);
    const latitudeTerm = 1 - eccentricitySquared * sinLatitude * sinLatitude;
    const primeVerticalRadius = a / Math.sqrt(latitudeTerm) + this.surfaceOffset;
    const meridionalRadius =
      (a * (1 - eccentricitySquared)) / latitudeTerm ** 1.5 + this.surfaceOffset;
    return new THREE.ShaderMaterial({
      uniforms: {
        sag_ellipsoidRadii: {
          value: new THREE.Vector2(
            this.ellipsoid.equatorialRadius,
            this.ellipsoid.polarRadius
          )
        },
        sag_heightOffset: { value: this.surfaceOffset },
        sag_cameraHigh: { value: this.cameraHigh },
        sag_cameraLow: { value: this.cameraLow },
        sag_originHigh: { value: originHigh },
        sag_originLow: { value: originLow },
        sag_east: { value: new THREE.Vector3(cosLongitude, 0, -sinLongitude) },
        sag_north: {
          value: new THREE.Vector3(
            -sinLatitude * sinLongitude,
            cosLatitude,
            -sinLatitude * cosLongitude
          )
        },
        sag_up: {
          value: new THREE.Vector3(
            cosLatitude * sinLongitude,
            sinLatitude,
            cosLatitude * cosLongitude
          )
        },
        sag_curvatureRadii: {
          value: new THREE.Vector2(primeVerticalRadius, meridionalRadius)
        },
        sag_useLocalCoordinates: { value: tile.level >= 18 },
        tileLongitudeSinCos: {
          value: new THREE.Vector2(sinLongitude, cosLongitude)
        },
        tileLongitudeSpan: { value: longitudeSpan },
        tileLatitudeSinCos: {
          value: new THREE.Vector2(sinLatitude, cosLatitude)
        },
        tileMercatorSinhCosh: {
          value: new THREE.Vector2(Math.sinh(mercatorCenter), Math.cosh(mercatorCenter))
        },
        tileMercatorSpan: { value: mercatorSpan },
        tileTexture: { value: null },
        uvScale: { value: new THREE.Vector2(1, 1) },
        uvOffset: { value: new THREE.Vector2(0, 0) },
        hasTexture: { value: false },
        placeholder: { value: placeholderColor(tile.level) }
      },
      vertexShader: /* glsl */ `
        varying vec2 v_uv;
        varying vec3 v_globeNormal;
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
        uniform vec2 uvScale;
        uniform vec2 uvOffset;
        #include <common>
        #include <logdepthbuf_pars_vertex>
        ${globeCoordinateShader}
        void main() {
          float deltaLongitude = (position.x - 0.5) * tileLongitudeSpan;
          float sinDeltaLongitude = sin(deltaLongitude);
          float cosDeltaLongitude = cos(deltaLongitude);
          vec2 longitudeSinCos = vec2(
            tileLongitudeSinCos.x * cosDeltaLongitude +
              tileLongitudeSinCos.y * sinDeltaLongitude,
            tileLongitudeSinCos.y * cosDeltaLongitude -
              tileLongitudeSinCos.x * sinDeltaLongitude
          );
          float deltaMercator = (position.y - 0.5) * tileMercatorSpan;
          float sinhDeltaMercator = 0.5 * (exp(deltaMercator) - exp(-deltaMercator));
          float coshDeltaMercator = 0.5 * (exp(deltaMercator) + exp(-deltaMercator));
          float sinhMercator =
            tileMercatorSinhCosh.x * coshDeltaMercator +
            tileMercatorSinhCosh.y * sinhDeltaMercator;
          float cosLatitude = inversesqrt(1.0 + sinhMercator * sinhMercator);
          float sinLatitude = sinhMercator * cosLatitude;
          vec2 latitudeSinCos = vec2(sinLatitude, cosLatitude);
          // XYZ rows grow from north to south, while Three.js image textures
          // use v=1 at the visual top. Flip only V after applying the ancestor
          // sub-rectangle so exact tiles and fallback tiles share one convention.
          vec2 xyzUv = uvOffset + uv * uvScale;
          v_uv = vec2(xyzUv.x, 1.0 - xyzUv.y);
          v_globeNormal = normalize(vec3(
            cosLatitude * longitudeSinCos.x,
            sinLatitude,
            cosLatitude * longitudeSinCos.y
          ));
          if (sag_useLocalCoordinates) {
            float deltaLatitude =
              tileLatitudeSinCos.y * deltaMercator -
              0.5 * tileLatitudeSinCos.x * tileLatitudeSinCos.y *
                deltaMercator * deltaMercator;
            float latitudeMidpoint = 0.5 * deltaLatitude;
            float midpointCosLatitude =
              tileLatitudeSinCos.y * cos(latitudeMidpoint) -
              tileLatitudeSinCos.x * sin(latitudeMidpoint);
            float eastMeters =
              sag_curvatureRadii.x * midpointCosLatitude * deltaLongitude;
            float northMeters = sag_curvatureRadii.y * deltaLatitude;
            float upMeters = -0.5 * (
              eastMeters * eastMeters / sag_curvatureRadii.x +
              northMeters * northMeters / sag_curvatureRadii.y
            );
            vec3 localWorld =
              sag_east * eastMeters +
              sag_north * northMeters +
              sag_up * upMeters;
            gl_Position = sag_projectLocalToEye(
              localWorld,
              sag_originHigh,
              sag_originLow
            );
          } else {
            gl_Position = sag_projectGeodeticTrig(
              longitudeSinCos,
              latitudeSinCos,
              0.0
            );
          }
          #include <logdepthbuf_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 v_uv;
        varying vec3 v_globeNormal;
        uniform sampler2D tileTexture;
        uniform bool hasTexture;
        uniform vec3 placeholder;
        #include <logdepthbuf_pars_fragment>
        void main() {
          vec3 color = hasTexture ? texture2D(tileTexture, v_uv).rgb : placeholder;
          float daylight = 0.86 + 0.14 * max(
            dot(normalize(v_globeNormal), normalize(vec3(-0.35, 0.55, 1.0))),
            0.0
          );
          color = min(color * 1.24 * daylight + vec3(0.025, 0.04, 0.055), vec3(1.0));
          gl_FragColor = vec4(color, 1.0);
          #include <logdepthbuf_fragment>
          #include <colorspace_fragment>
        }
      `,
      depthWrite: true,
      depthTest: true,
      toneMapped: false
    });
  }

  private queueVisibleTextures(selection: readonly SelectedTile[]): void {
    this.visibleTextureKeys.clear();
    const levelOffset = Math.min(0, Math.round(this.provider.levelOffset ?? 0));
    for (let rank = 0; rank < selection.length; rank += 1) {
      const tile = selection[rank];
      if (!tile) continue;
      const maximumSourceLevel = Math.min(
        tile.id.level + levelOffset,
        this.provider.maxLevel
      );
      if (maximumSourceLevel < this.provider.minLevel) continue;
      for (
        let level = this.provider.minLevel;
        level <= maximumSourceLevel;
        level += 1
      ) {
        const shift = tile.id.level - level;
        const ancestor: TileId = {
          level,
          x: Math.floor(tile.id.x / 2 ** shift),
          y: Math.floor(tile.id.y / 2 ** shift)
        };
        this.visibleTextureKeys.add(tileKey(ancestor));
        this.queueTexture(ancestor, level * 10_000 + rank);
      }
    }
    for (const [key, record] of this.textures) {
      if (this.visibleTextureKeys.has(key) || record.state === 'loading' || record.state === 'ready') continue;
      this.textures.delete(key);
    }
  }

  private queueTexture(id: TileId, priority: number): void {
    const key = tileKey(id);
    const existing = this.textures.get(key);
    if (existing) {
      existing.lastUsedFrame = this.frame;
      if (existing.state === 'queued') existing.priority = Math.min(existing.priority, priority);
      return;
    }
    this.textures.set(key, {
      id,
      key,
      state: 'queued',
      priority,
      lastUsedFrame: this.frame,
      texture: null
    });
  }

  private pumpQueue(): void {
    while (this.activeRequests < this.maxConcurrentRequests) {
      let next: TextureRecord | undefined;
      for (const record of this.textures.values()) {
        if (record.state !== 'queued') continue;
        if (!next || record.priority < next.priority) next = record;
      }
      if (!next) return;
      this.load(next);
    }
  }

  private load(record: TextureRecord): void {
    record.state = 'loading';
    this.activeRequests += 1;
    const provider = this.provider;
    if (provider.loadTexture) {
      void provider.loadTexture(record.id).then(
        (texture) => this.completeTextureLoad(record, provider, texture),
        () => this.failTextureLoad(record, provider)
      );
      return;
    }
    this.loader.load(
      provider.url(record.id),
      (texture) => this.completeTextureLoad(record, provider, texture),
      undefined,
      () => this.failTextureLoad(record, provider)
    );
  }

  private completeTextureLoad(
    record: TextureRecord,
    provider: RasterTileProvider,
    texture: THREE.Texture
  ): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    if (
      this.disposed ||
      this.provider !== provider ||
      this.textures.get(record.key) !== record
    ) {
      texture.dispose();
      this.pumpQueue();
      return;
    }
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = this.maxAnisotropy;
    record.texture = texture;
    record.state = 'ready';
    record.lastUsedFrame = this.frame;
    this.pumpQueue();
  }

  private failTextureLoad(record: TextureRecord, provider: RasterTileProvider): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    if (
      !this.disposed &&
      this.provider === provider &&
      this.textures.get(record.key) === record
    ) {
      record.state = 'error';
    }
    this.pumpQueue();
  }

  private syncMaterials(selection: readonly SelectedTile[]): void {
    this.fallbackCount = 0;
    for (const tile of selection) {
      const renderTile = this.renderTiles.get(tileKey(tile.id));
      if (!renderTile) continue;
      const source = this.findReadyAncestor(tile.id);
      const sourceKey = source?.key ?? '';
      if (source && source.id.level < tile.id.level) this.fallbackCount += 1;
      if (sourceKey === renderTile.textureKey) continue;
      renderTile.textureKey = sourceKey;
      const uniforms = renderTile.mesh.material.uniforms;
      if (!uniforms) continue;
      uniforms.tileTexture!.value = source?.texture ?? null;
      uniforms.hasTexture!.value = source !== undefined;
      const levels = source ? tile.id.level - source.id.level : 0;
      const scale = 1 / 2 ** levels;
      const localX = source ? tile.id.x - source.id.x * 2 ** levels : 0;
      const localY = source ? tile.id.y - source.id.y * 2 ** levels : 0;
      (uniforms.uvScale!.value as THREE.Vector2).set(scale, scale);
      (uniforms.uvOffset!.value as THREE.Vector2).set(localX * scale, localY * scale);
    }
  }

  private findReadyAncestor(id: TileId): TextureRecord | undefined {
    const levelOffset = Math.min(0, Math.round(this.provider.levelOffset ?? 0));
    for (
      let level = Math.min(id.level + levelOffset, this.provider.maxLevel);
      level >= this.provider.minLevel;
      level -= 1
    ) {
      const shift = id.level - level;
      const record = this.textures.get(tileKey({
        level,
        x: Math.floor(id.x / 2 ** shift),
        y: Math.floor(id.y / 2 ** shift)
      }));
      if (record?.state === 'ready' && record.texture) {
        record.lastUsedFrame = this.frame;
        return record;
      }
    }
    return undefined;
  }

  private evictTextures(): void {
    if (this.textures.size <= this.maxCachedTiles) return;
    const protectedKeys = new Set(
      [...this.renderTiles.values()].map((tile) => tile.textureKey).filter(Boolean)
    );
    for (const key of this.visibleTextureKeys) protectedKeys.add(key);
    const candidates = [...this.textures.values()]
      .filter((record) => record.state !== 'loading' && !protectedKeys.has(record.key))
      .sort((a, b) => a.lastUsedFrame - b.lastUsedFrame);
    while (this.textures.size > this.maxCachedTiles) {
      const record = candidates.shift();
      if (!record) break;
      record.texture?.dispose();
      this.textures.delete(record.key);
    }
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

function placeholderColor(level: number): THREE.Color {
  return new THREE.Color().setHSL(0.53, 0.56, Math.min(0.3, 0.19 + level * 0.009));
}

function splitVector3(value: THREE.Vector3, high: THREE.Vector3, low: THREE.Vector3): void {
  high.set(Math.fround(value.x), Math.fround(value.y), Math.fround(value.z));
  low.set(value.x - high.x, value.y - high.y, value.z - high.z);
}
