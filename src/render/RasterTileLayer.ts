import * as THREE from 'three';
import { Ellipsoid } from '../core/geo/Ellipsoid';
import type { SelectedTile } from '../core/lod/GlobeLodSelector';
import type { RasterTileProvider } from '../core/tiles/RasterTileProvider';
import { tileKey, type TileId } from '../core/tiling/GeographicTilingScheme';
import { globeCoordinateShader } from './shaders/coordinates';
import type { TerrainHeightSource } from './TerrainTileLayer';

export type RasterTileLayerOptions = {
  segments?: number;
  maxConcurrentRequests?: number;
  maxCachedTiles?: number;
  /** Hard resident texture budget. Defaults to 192 MiB. */
  maxTextureBytes?: number;
  surfaceOffset?: number;
  maxAnisotropy?: number;
  terrain?: TerrainHeightSource;
};

export type RasterTileLayerStats = Readonly<{
  ready: number;
  loading: number;
  queued: number;
  errors: number;
  fallbacks: number;
  textureBytes: number;
  desiredMinimumLevel: number | null;
  desiredMaximumLevel: number | null;
  displayedMinimumLevel: number | null;
  displayedMaximumLevel: number | null;
}>;

type TextureState = 'queued' | 'loading' | 'ready' | 'error';
type TextureRecord = {
  id: TileId;
  key: string;
  state: TextureState;
  priority: number;
  lastUsedFrame: number;
  texture: THREE.Texture | null;
  byteSize: number;
  attempts: number;
  retryAt: number;
};
type RenderTile = {
  id: TileId;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  textureKey: string;
  terrainKey: string;
};

/** Visible-leaf raster consumer. Selection remains owned by GlobeLodSelector. */
export class RasterTileLayer {
  readonly object3d = new THREE.Group();
  provider: RasterTileProvider;

  private readonly ellipsoid: Ellipsoid;
  private readonly geometries = new Map<number, THREE.BufferGeometry>();
  private readonly baseSegments: number;
  private readonly loader = new THREE.TextureLoader();
  private readonly renderTiles = new Map<string, RenderTile>();
  private readonly textures = new Map<string, TextureRecord>();
  private readonly visibleTextureKeys = new Set<string>();
  private readonly maxConcurrentRequests: number;
  private readonly maxCachedTiles: number;
  private readonly maxTextureBytes: number;
  private readonly surfaceOffset: number;
  private readonly maxAnisotropy: number;
  private readonly terrain?: TerrainHeightSource;
  private readonly cameraHigh = new THREE.Vector3();
  private readonly cameraLow = new THREE.Vector3();
  private readonly tileOrigin = new THREE.Vector3();
  private frame = 0;
  private activeRequests = 0;
  private disposed = false;
  private fallbackCount = 0;
  private suspended = false;
  private lastSelection: readonly SelectedTile[] | null = null;
  private materialsDirty = true;
  private observedTerrainRevision = -1;
  private observedProviderRevision = -1;
  private desiredMinimumLevel: number | null = null;
  private desiredMaximumLevel: number | null = null;
  private displayedMinimumLevel: number | null = null;
  private displayedMaximumLevel: number | null = null;

  constructor(
    ellipsoid: Ellipsoid,
    provider: RasterTileProvider,
    options: RasterTileLayerOptions = {}
  ) {
    this.ellipsoid = ellipsoid;
    this.provider = provider;
    this.baseSegments = Math.max(2, Math.round(options.segments ?? 16));
    this.maxConcurrentRequests = Math.max(1, Math.round(options.maxConcurrentRequests ?? 8));
    this.maxCachedTiles = Math.max(16, Math.round(options.maxCachedTiles ?? 512));
    this.maxTextureBytes = Math.max(
      16 * 1024 * 1024,
      Math.round(options.maxTextureBytes ?? 192 * 1024 * 1024)
    );
    this.surfaceOffset = Math.max(0, options.surfaceOffset ?? 0.1);
    this.maxAnisotropy = Math.max(1, options.maxAnisotropy ?? 1);
    this.terrain = options.terrain;
    this.loader.setCrossOrigin('anonymous');
    this.object3d.renderOrder = 1;
  }

  update(
    selection: readonly SelectedTile[],
    cameraPosition?: THREE.Vector3
  ): RasterTileLayerStats {
    if (this.disposed) return this.stats;
    if (cameraPosition) splitVector3(cameraPosition, this.cameraHigh, this.cameraLow);
    const selectionChanged = selection !== this.lastSelection;
    const terrainRevision = this.terrain?.revision ?? -1;
    const terrainChanged = terrainRevision !== this.observedTerrainRevision;
    const providerRevision = this.provider.revision ?? 0;
    const sourceLevelsChanged = providerRevision !== this.observedProviderRevision;
    if (selectionChanged || sourceLevelsChanged) {
      this.frame += 1;
      this.lastSelection = selection;
      this.observedProviderRevision = providerRevision;
      if (selectionChanged) this.syncRenderTiles(selection);
      this.queueVisibleTextures(selection);
    }
    if (selectionChanged || sourceLevelsChanged || terrainChanged || this.materialsDirty) {
      this.observedTerrainRevision = terrainRevision;
      this.syncMaterials(selection);
      this.evictTextures();
      this.materialsDirty = false;
    }
    this.pumpQueue();
    return this.stats;
  }

  get stats(): RasterTileLayerStats {
    const counts = { ready: 0, loading: 0, queued: 0, errors: 0 };
    for (const record of this.textures.values()) {
      if (record.state === 'error') counts.errors += 1;
      else counts[record.state] += 1;
    }
    return {
      ...counts,
      fallbacks: this.fallbackCount,
      textureBytes: this.residentTextureBytes(),
      desiredMinimumLevel: this.desiredMinimumLevel,
      desiredMaximumLevel: this.desiredMaximumLevel,
      displayedMinimumLevel: this.displayedMinimumLevel,
      displayedMaximumLevel: this.displayedMaximumLevel
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const renderTile of this.renderTiles.values()) renderTile.mesh.material.dispose();
    for (const record of this.textures.values()) this.releaseTexture(record.texture);
    this.renderTiles.clear();
    this.textures.clear();
    for (const geometry of this.geometries.values()) geometry.dispose();
    this.geometries.clear();
    this.object3d.clear();
  }

  setProvider(provider: RasterTileProvider): void {
    if (provider.id === this.provider.id) return;
    this.provider = provider;
    for (const record of this.textures.values()) this.releaseTexture(record.texture);
    this.textures.clear();
    this.visibleTextureKeys.clear();
    this.fallbackCount = 0;
    this.lastSelection = null;
    this.observedProviderRevision = -1;
    this.materialsDirty = true;
    for (const renderTile of this.renderTiles.values()) {
      renderTile.textureKey = '';
      const uniforms = renderTile.mesh.material.uniforms;
      if (!uniforms) continue;
      uniforms.tileTexture!.value = null;
      uniforms.hasTexture!.value = false;
    }
  }

  handleContextLost(): void {
    this.suspended = true;
  }

  handleContextRestored(): void {
    this.suspended = false;
    for (const record of this.textures.values()) {
      if (record.texture) record.texture.needsUpdate = true;
    }
    for (const renderTile of this.renderTiles.values()) {
      renderTile.mesh.material.needsUpdate = true;
    }
    this.materialsDirty = true;
    this.pumpQueue();
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
      const mesh = new THREE.Mesh(this.geometryForLevel(tile.id.level), material);
      mesh.frustumCulled = false;
      mesh.renderOrder = 1;
      mesh.onBeforeRender = (_renderer, _scene, camera) => {
        splitVector3(camera.position, this.cameraHigh, this.cameraLow);
      };
      this.renderTiles.set(key, { id: tile.id, mesh, textureKey: '', terrainKey: '' });
      this.object3d.add(mesh);
    }
  }

  /**
   * Keep the angular size of a raster triangle approximately constant through
   * the coarse globe levels. The powers of two also make every parent edge
   * sample coincide with its two children, preventing T-junction cracks.
   */
  private geometryForLevel(level: number): THREE.BufferGeometry {
    const segments = Math.max(this.baseSegments, Math.round(1024 / 2 ** level));
    let geometry = this.geometries.get(segments);
    if (!geometry) {
      geometry = createGridGeometry(segments);
      this.geometries.set(segments, geometry);
    }
    return geometry;
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
    // Terrain edges are reconciled by height and slope. A vertical skirt turns
    // any transient mismatch into a conspicuous wall at grazing angles, so the
    // regular imagery surface keeps its perimeter on the reconciled edge.
    const terrainSkirtDepth = 0;
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
        terrainTexture: { value: null },
        terrainParentTexture: { value: null },
        terrainUvScale: { value: new THREE.Vector2(1, 1) },
        terrainUvOffset: { value: new THREE.Vector2(0, 0) },
        terrainParentUvScale: { value: new THREE.Vector2(1, 1) },
        terrainParentUvOffset: { value: new THREE.Vector2(0, 0) },
        terrainTexelSize: { value: new THREE.Vector2(1, 1) },
        terrainMetersPerTexel: { value: new THREE.Vector2(1, 1) },
        hasTerrain: { value: false },
        hasTerrainParent: { value: false },
        terrainExaggeration: { value: this.terrain?.exaggeration ?? 1 },
        terrainSkirtDepth: { value: terrainSkirtDepth },
        placeholder: { value: placeholderColor(tile.level) }
      },
      vertexShader: /* glsl */ `
        varying vec2 v_uv;
        varying vec3 v_globeNormal;
        varying vec2 v_terrainUv;
        attribute float skirt;
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
        uniform sampler2D terrainTexture;
        uniform sampler2D terrainParentTexture;
        uniform vec2 terrainUvScale;
        uniform vec2 terrainUvOffset;
        uniform vec2 terrainParentUvScale;
        uniform vec2 terrainParentUvOffset;
        uniform vec2 terrainTexelSize;
        uniform bool hasTerrain;
        uniform bool hasTerrainParent;
        uniform float terrainExaggeration;
        uniform float terrainSkirtDepth;
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
          vec2 terrainUv = terrainUvOffset + uv * terrainUvScale;
          // Height arrays contain endpoint samples (257 samples / 256 cells).
          // Convert logical [0,1] coordinates to texel centres before linear
          // filtering; raw normalized UVs introduce a sub-texel parent/child
          // offset and can reopen a geometrically stitched edge.
          vec2 terrainSampleUv = 0.5 * terrainTexelSize +
            terrainUv * (vec2(1.0) - terrainTexelSize);
          v_terrainUv = terrainSampleUv;
          float fineHeight = hasTerrain
            ? texture2D(terrainTexture, terrainSampleUv).r * terrainExaggeration
            : 0.0;
          // CPU terrain stitching gives adjacent tiles one shared geographic
          // edge. Do not replace that edge with this tile's unrelated parent.
          float heightMeters = fineHeight;
          if (hasTerrain) heightMeters -= skirt * terrainSkirtDepth;
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
              sag_up * (upMeters + heightMeters);
            gl_Position = sag_projectLocalToEye(
              localWorld,
              sag_originHigh,
              sag_originLow
            );
          } else {
            gl_Position = sag_projectGeodeticTrig(
              longitudeSinCos,
              latitudeSinCos,
              heightMeters
            );
          }
          #include <logdepthbuf_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 v_uv;
        varying vec3 v_globeNormal;
        varying vec2 v_terrainUv;
        uniform sampler2D tileTexture;
        uniform sampler2D terrainTexture;
        uniform bool hasTexture;
        uniform bool hasTerrain;
        uniform float terrainExaggeration;
        uniform vec2 terrainTexelSize;
        uniform vec2 terrainMetersPerTexel;
        uniform vec3 placeholder;
        #include <logdepthbuf_pars_fragment>
        void main() {
          vec3 color = hasTexture ? texture2D(tileTexture, v_uv).rgb : placeholder;
          float daylight = 0.86 + 0.14 * max(
            dot(normalize(v_globeNormal), normalize(vec3(-0.35, 0.55, 1.0))),
            0.0
          );
          if (hasTerrain) {
            float westHeight = texture2D(terrainTexture, v_terrainUv - vec2(terrainTexelSize.x, 0.0)).r;
            float eastHeight = texture2D(terrainTexture, v_terrainUv + vec2(terrainTexelSize.x, 0.0)).r;
            float northHeight = texture2D(terrainTexture, v_terrainUv - vec2(0.0, terrainTexelSize.y)).r;
            float southHeight = texture2D(terrainTexture, v_terrainUv + vec2(0.0, terrainTexelSize.y)).r;
            float slopeEast = (eastHeight - westHeight) * terrainExaggeration /
              max(1.0, 2.0 * terrainMetersPerTexel.x);
            float slopeNorth = (northHeight - southHeight) * terrainExaggeration /
              max(1.0, 2.0 * terrainMetersPerTexel.y);
            vec3 terrainNormal = normalize(vec3(-slopeEast, -slopeNorth, 1.0));
            float relief = 0.78 + 0.30 * max(
              dot(terrainNormal, normalize(vec3(-0.45, 0.55, 0.78))),
              0.0
            );
            daylight *= relief;
          }
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
    this.desiredMinimumLevel = null;
    this.desiredMaximumLevel = null;
    for (const record of this.textures.values()) {
      if (record.state === 'queued') record.priority = Number.POSITIVE_INFINITY;
    }
    const prioritized = [...selection].sort(
      (a, b) => b.id.level - a.id.level || b.screenPixels - a.screenPixels
    );
    for (let rank = 0; rank < prioritized.length; rank += 1) {
      const tile = prioritized[rank];
      if (!tile) continue;
      const levelOffset = Math.min(0, Math.round(this.provider.levelOffset ?? 0));
      const maximumSourceLevel = Math.min(
        this.provider.maximumSourceLevel?.(tile.id.level) ??
          tile.id.level + levelOffset,
        this.provider.maxLevel,
        tile.id.level
      );
      if (maximumSourceLevel < this.provider.minLevel) continue;
      this.desiredMinimumLevel = this.desiredMinimumLevel === null
        ? maximumSourceLevel
        : Math.min(this.desiredMinimumLevel, maximumSourceLevel);
      this.desiredMaximumLevel = this.desiredMaximumLevel === null
        ? maximumSourceLevel
        : Math.max(this.desiredMaximumLevel, maximumSourceLevel);

      const desired = ancestorAtLevel(tile.id, maximumSourceLevel);
      this.visibleTextureKeys.add(tileKey(desired));
      this.queueTexture(desired, rank);
      const ready = this.findReadyAncestor(tile.id);
      if (ready) {
        this.visibleTextureKeys.add(ready.key);
      } else {
        const bridgeLevel = Math.max(this.provider.minLevel, maximumSourceLevel - 3);
        const bridge = ancestorAtLevel(tile.id, bridgeLevel);
        this.visibleTextureKeys.add(tileKey(bridge));
        // Missing coverage is more urgent than sharpening an already covered
        // tile. Deduplication makes these coarse bridge requests inexpensive.
        this.queueTexture(bridge, rank - prioritized.length * 2);
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
      texture: null,
      byteSize: 0,
      attempts: 0,
      retryAt: 0
    });
  }

  private pumpQueue(): void {
    if (this.suspended || this.disposed) return;
    const estimatedBytes = this.provider.estimatedTextureBytes ?? estimateSquareTextureBytes(256);
    // A target texture must coexist briefly with its currently displayed
    // ancestor. Without this transition allowance a full cache protects the
    // ancestor forever and the view can remain stuck several levels too low.
    const transitionBytes = this.maxConcurrentRequests * estimatedBytes;
    while (this.activeRequests < this.maxConcurrentRequests) {
      if (
        this.residentTextureBytes() +
        (this.activeRequests + 1) * estimatedBytes >
          this.maxTextureBytes + transitionBytes
      ) return;
      let next: TextureRecord | undefined;
      const now = performance.now();
      for (const record of this.textures.values()) {
        if (
          record.state === 'error' &&
          this.visibleTextureKeys.has(record.key) &&
          record.retryAt <= now
        ) record.state = 'queued';
        if (record.state !== 'queued' || record.retryAt > now) continue;
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
      this.releaseTexture(texture);
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
    record.byteSize = estimateTextureBytes(texture, this.provider.estimatedTextureBytes);
    record.state = 'ready';
    record.attempts = 0;
    record.retryAt = 0;
    record.lastUsedFrame = this.frame;
    this.materialsDirty = true;
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
      record.attempts += 1;
      record.retryAt = performance.now() + Math.min(30_000, 1_000 * 2 ** (record.attempts - 1));
    }
    this.pumpQueue();
  }

  private syncMaterials(selection: readonly SelectedTile[]): void {
    this.fallbackCount = 0;
    this.displayedMinimumLevel = null;
    this.displayedMaximumLevel = null;
    for (const tile of selection) {
      const renderTile = this.renderTiles.get(tileKey(tile.id));
      if (!renderTile) continue;
      const source = this.findReadyAncestor(tile.id);
      const sourceKey = source?.key ?? '';
      if (source && source.id.level < tile.id.level) this.fallbackCount += 1;
      if (source) {
        this.displayedMinimumLevel = this.displayedMinimumLevel === null
          ? source.id.level
          : Math.min(this.displayedMinimumLevel, source.id.level);
        this.displayedMaximumLevel = this.displayedMaximumLevel === null
          ? source.id.level
          : Math.max(this.displayedMaximumLevel, source.id.level);
      }
      const uniforms = renderTile.mesh.material.uniforms;
      if (!uniforms) continue;
      if (sourceKey !== renderTile.textureKey) {
        renderTile.textureKey = sourceKey;
        uniforms.tileTexture!.value = source?.texture ?? null;
        uniforms.hasTexture!.value = source !== undefined;
        const levels = source ? tile.id.level - source.id.level : 0;
        const scale = 1 / 2 ** levels;
        const localX = source ? tile.id.x - source.id.x * 2 ** levels : 0;
        const localY = source ? tile.id.y - source.id.y * 2 ** levels : 0;
        (uniforms.uvScale!.value as THREE.Vector2).set(scale, scale);
        (uniforms.uvOffset!.value as THREE.Vector2).set(localX * scale, localY * scale);
      }
      const terrain = this.terrain?.resolveTexture(tile.id);
      const terrainKey = terrain ? `${terrain.key}|${terrain.parentKey}` : '';
      if (terrainKey === renderTile.terrainKey) continue;
      renderTile.terrainKey = terrainKey;
      uniforms.terrainTexture!.value = terrain?.texture ?? null;
      uniforms.terrainParentTexture!.value = terrain?.parentTexture ?? null;
      uniforms.hasTerrain!.value = terrain !== undefined;
      uniforms.hasTerrainParent!.value = terrain?.parentTexture !== null &&
        terrain?.parentTexture !== undefined;
      (uniforms.terrainUvScale!.value as THREE.Vector2).setScalar(terrain?.scale ?? 1);
      (uniforms.terrainUvOffset!.value as THREE.Vector2).set(
        terrain?.offsetX ?? 0,
        terrain?.offsetY ?? 0
      );
      (uniforms.terrainParentUvScale!.value as THREE.Vector2).setScalar(
        terrain?.parentScale ?? 1
      );
      (uniforms.terrainParentUvOffset!.value as THREE.Vector2).set(
        terrain?.parentOffsetX ?? 0,
        terrain?.parentOffsetY ?? 0
      );
      (uniforms.terrainTexelSize!.value as THREE.Vector2).set(
        1 / (terrain?.width ?? 1),
        1 / (terrain?.height ?? 1)
      );
      const sourceLevel = terrain?.sourceLevel ?? tile.id.level;
      const sourceSize = 2 ** sourceLevel;
      const mercatorCenter = Math.PI - ((tile.id.y + 0.5) / 2 ** tile.id.level) * Math.PI * 2;
      const cosLatitude = 1 / Math.cosh(mercatorCenter);
      const circumference = Math.PI * 2 * this.ellipsoid.equatorialRadius;
      (uniforms.terrainMetersPerTexel!.value as THREE.Vector2).set(
        (circumference * cosLatitude) / (sourceSize * (terrain?.width ?? 1)),
        (circumference * cosLatitude) / (sourceSize * (terrain?.height ?? 1))
      );
    }
  }

  private findReadyAncestor(id: TileId): TextureRecord | undefined {
    const levelOffset = Math.min(0, Math.round(this.provider.levelOffset ?? 0));
    const maximumSourceLevel = Math.min(
      this.provider.maximumSourceLevel?.(id.level) ?? id.level + levelOffset,
      this.provider.maxLevel,
      id.level
    );
    for (
      let level = maximumSourceLevel;
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
    if (this.suspended) return;
    const residentBytes = this.residentTextureBytes();
    if (this.textures.size <= this.maxCachedTiles && residentBytes <= this.maxTextureBytes) return;
    const protectedKeys = new Set(
      [...this.renderTiles.values()].map((tile) => tile.textureKey).filter(Boolean)
    );
    const candidates = [...this.textures.values()]
      .filter((record) => record.state !== 'loading' && !protectedKeys.has(record.key))
      .sort((a, b) => a.lastUsedFrame - b.lastUsedFrame);
    let remainingBytes = residentBytes;
    while (
      this.textures.size > this.maxCachedTiles ||
      remainingBytes > this.maxTextureBytes
    ) {
      const record = candidates.shift();
      if (!record) break;
      this.releaseTexture(record.texture);
      remainingBytes -= record.byteSize;
      this.textures.delete(record.key);
    }
  }

  private residentTextureBytes(): number {
    let bytes = 0;
    for (const record of this.textures.values()) {
      if (record.state === 'ready') bytes += record.byteSize;
    }
    return bytes;
  }

  private releaseTexture(texture: THREE.Texture | null): void {
    if (texture && !this.suspended) texture.dispose();
  }
}

function ancestorAtLevel(id: TileId, level: number): TileId {
  const shift = Math.max(0, id.level - level);
  return {
    level,
    x: Math.floor(id.x / 2 ** shift),
    y: Math.floor(id.y / 2 ** shift)
  };
}

function createGridGeometry(segmentsInput: number): THREE.BufferGeometry {
  const segments = Math.max(2, Math.round(segmentsInput));
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const skirts: number[] = [];
  for (let y = 0; y <= segments; y += 1) {
    for (let x = 0; x <= segments; x += 1) {
      positions.push(x / segments, y / segments, 0);
      uvs.push(x / segments, y / segments);
      skirts.push(0);
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
  const perimeter: number[] = [];
  for (let x = 0; x <= segments; x += 1) perimeter.push(x);
  for (let y = 1; y <= segments; y += 1) perimeter.push(y * columns + segments);
  for (let x = segments - 1; x >= 0; x -= 1) perimeter.push(segments * columns + x);
  for (let y = segments - 1; y >= 1; y -= 1) perimeter.push(y * columns);
  const skirtStart = positions.length / 3;
  for (const surfaceIndex of perimeter) {
    positions.push(
      positions[surfaceIndex * 3] ?? 0,
      positions[surfaceIndex * 3 + 1] ?? 0,
      0
    );
    uvs.push(uvs[surfaceIndex * 2] ?? 0, uvs[surfaceIndex * 2 + 1] ?? 0);
    skirts.push(1);
  }
  for (let index = 0; index < perimeter.length; index += 1) {
    const next = (index + 1) % perimeter.length;
    const surface = perimeter[index]!;
    const nextSurface = perimeter[next]!;
    const lower = skirtStart + index;
    const nextLower = skirtStart + next;
    indices.push(surface, lower, nextSurface, nextSurface, lower, nextLower);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('skirt', new THREE.Float32BufferAttribute(skirts, 1));
  geometry.setIndex(indices);
  return geometry;
}

function placeholderColor(level: number): THREE.Color {
  return new THREE.Color().setHSL(0.53, 0.56, Math.min(0.3, 0.19 + level * 0.009));
}

function estimateSquareTextureBytes(size: number): number {
  return Math.ceil(size * size * 4 * 4 / 3);
}

function estimateTextureBytes(texture: THREE.Texture, fallback?: number): number {
  const image = texture.image as {
    width?: number;
    height?: number;
    naturalWidth?: number;
    naturalHeight?: number;
  } | undefined;
  const width = image?.naturalWidth ?? image?.width ?? 0;
  const height = image?.naturalHeight ?? image?.height ?? 0;
  if (width > 0 && height > 0) return Math.ceil(width * height * 4 * 4 / 3);
  return fallback ?? estimateSquareTextureBytes(256);
}

function splitVector3(value: THREE.Vector3, high: THREE.Vector3, low: THREE.Vector3): void {
  high.set(Math.fround(value.x), Math.fround(value.y), Math.fround(value.z));
  low.set(value.x - high.x, value.y - high.y, value.z - high.z);
}
