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
  readonly provider: RasterTileProvider;

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
    this.surfaceOffset = Math.max(0, options.surfaceOffset ?? 120);
    this.maxAnisotropy = Math.max(1, options.maxAnisotropy ?? 1);
    this.loader.setCrossOrigin('anonymous');
    this.object3d.renderOrder = 1;
  }

  update(selection: readonly SelectedTile[]): RasterTileLayerStats {
    if (this.disposed) return this.stats;
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
    return new THREE.ShaderMaterial({
      uniforms: {
        sag_ellipsoidRadii: {
          value: new THREE.Vector2(
            this.ellipsoid.equatorialRadius,
            this.ellipsoid.polarRadius
          )
        },
        sag_heightOffset: { value: this.surfaceOffset },
        tileLongitude: { value: new THREE.Vector2(west, east) },
        tileMercator: { value: new THREE.Vector2(northMercator, southMercator) },
        tileTexture: { value: null },
        uvScale: { value: new THREE.Vector2(1, 1) },
        uvOffset: { value: new THREE.Vector2(0, 0) },
        hasTexture: { value: false },
        placeholder: { value: placeholderColor(tile.level) }
      },
      vertexShader: /* glsl */ `
        varying vec2 v_uv;
        varying vec3 v_globeNormal;
        uniform vec2 tileLongitude;
        uniform vec2 tileMercator;
        uniform vec2 uvScale;
        uniform vec2 uvOffset;
        #include <common>
        #include <logdepthbuf_pars_vertex>
        ${globeCoordinateShader}
        void main() {
          float longitude = mix(tileLongitude.x, tileLongitude.y, position.x);
          float mercatorLatitude = mix(tileMercator.x, tileMercator.y, position.y);
          float hyperbolicSine = 0.5 * (exp(mercatorLatitude) - exp(-mercatorLatitude));
          float latitude = atan(hyperbolicSine);
          // XYZ rows grow from north to south, while Three.js image textures
          // use v=1 at the visual top. Flip only V after applying the ancestor
          // sub-rectangle so exact tiles and fallback tiles share one convention.
          vec2 xyzUv = uvOffset + uv * uvScale;
          v_uv = vec2(xyzUv.x, 1.0 - xyzUv.y);
          v_globeNormal = normalize(vec3(
            cos(latitude) * sin(longitude),
            sin(latitude),
            cos(latitude) * cos(longitude)
          ));
          gl_Position = sag_projectGeodetic(vec2(longitude, latitude), 0.0);
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
    for (let rank = 0; rank < selection.length; rank += 1) {
      const tile = selection[rank];
      if (!tile) continue;
      if (tile.id.level < this.provider.minLevel) continue;
      for (
        let level = this.provider.minLevel;
        level <= Math.min(tile.id.level, this.provider.maxLevel);
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
    this.loader.load(
      this.provider.url(record.id),
      (texture) => {
        this.activeRequests = Math.max(0, this.activeRequests - 1);
        if (this.disposed || !this.textures.has(record.key)) {
          texture.dispose();
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
      },
      undefined,
      () => {
        this.activeRequests = Math.max(0, this.activeRequests - 1);
        if (!this.disposed && this.textures.has(record.key)) record.state = 'error';
        this.pumpQueue();
      }
    );
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
    for (let level = Math.min(id.level, this.provider.maxLevel); level >= this.provider.minLevel; level -= 1) {
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

