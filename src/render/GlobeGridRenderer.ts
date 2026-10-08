import * as THREE from 'three';
import { Ellipsoid } from '../core/geo/Ellipsoid';
import { tileKey } from '../core/tiling/GeographicTilingScheme';
import type { SelectedTile } from '../core/lod/GlobeLodSelector';
import { globeCoordinateShader } from './shaders/coordinates';
import type { TerrainHeightSource } from './TerrainTileLayer';

export type GlobeGridRendererOptions = {
  visible?: boolean;
  subdivisions?: number;
  heightOffset?: number;
  terrain?: TerrainHeightSource;
};
type HeightProbe = { longitude: number; latitude: number; version: string };
type GridChunk = { revision: number; probes: Map<string, HeightProbe>; bytes: number;
  positions: Float32Array; colors: Float32Array; originsHigh: Float32Array; originsLow: Float32Array };

/** Converts an LOD leaf set into one draw call of coloured latitude/longitude lines. */
export class GlobeGridRenderer {
  readonly object3d: THREE.LineSegments;

  private readonly ellipsoid: Ellipsoid;
  private readonly subdivisions: number;
  private readonly heightOffset: number;
  private readonly terrain?: TerrainHeightSource;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly cameraHigh = new THREE.Vector3();
  private readonly cameraLow = new THREE.Vector3();
  private readonly tileOrigin = new THREE.Vector3();
  private readonly vertexWorld = new THREE.Vector3();
  private signature = '';
  private tileSignature = '';
  private observedTerrainRevision = -1;
  private renderedTerrainRevision = -1;
  private terrainRefreshAt = 0;
  private vertexCapacity = 0;
  private tilesReference: readonly SelectedTile[] | null = null;
  private readonly heightProbes = new Map<string, { longitude: number; latitude: number; version: string }>();
  private readonly heightPoints = new Map<string, { revision: number; version: string; world: THREE.Vector3 }>();
  private readonly tileChunks = new Map<string, GridChunk>();
  private chunkBytes = 0;
  private activeProbes: Map<string, HeightProbe> | null = null;

  constructor(ellipsoid: Ellipsoid, options: GlobeGridRendererOptions = {}) {
    this.ellipsoid = ellipsoid;
    this.subdivisions = Math.max(1, Math.round(options.subdivisions ?? 8));
    this.heightOffset = Math.max(0, options.heightOffset ?? 0.3);
    this.terrain = options.terrain;
    this.geometry = new THREE.BufferGeometry();
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        sag_ellipsoidRadii: {
          value: new THREE.Vector2(ellipsoid.equatorialRadius, ellipsoid.polarRadius)
        },
        sag_heightOffset: { value: this.heightOffset },
        sag_cameraHigh: { value: this.cameraHigh },
        sag_cameraLow: { value: this.cameraLow },
        opacity: { value: 0.66 }
      },
      vertexShader: /* glsl */ `
        attribute vec3 sag_originHigh;
        attribute vec3 sag_originLow;
        varying vec3 v_color;
        #include <common>
        #include <logdepthbuf_pars_vertex>
        ${globeCoordinateShader}
        void main() {
          v_color = color;
          gl_Position = sag_projectLocalToEye(position, sag_originHigh, sag_originLow);
          #include <logdepthbuf_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 v_color;
        uniform float opacity;
        #include <logdepthbuf_pars_fragment>
        void main() {
          gl_FragColor = vec4(v_color, opacity);
          #include <logdepthbuf_fragment>
          #include <colorspace_fragment>
        }
      `,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      toneMapped: false
    });
    this.object3d = new THREE.LineSegments(this.geometry, this.material);
    this.object3d.visible = options.visible ?? true;
    this.object3d.frustumCulled = false;
    this.object3d.renderOrder = 2;
    this.object3d.onBeforeRender = (_renderer, _scene, camera) => {
      splitVector3(camera.position, this.cameraHigh, this.cameraLow);
    };
  }

  update(tiles: readonly SelectedTile[], cameraPosition?: THREE.Vector3): boolean {
    if (cameraPosition) splitVector3(cameraPosition, this.cameraHigh, this.cameraLow);
    const terrainRevision = this.terrain?.revision ?? 0;
    if (tiles === this.tilesReference && terrainRevision === this.renderedTerrainRevision) {
      return false;
    }
    const now = performance.now();
    if (terrainRevision !== this.observedTerrainRevision) {
      this.observedTerrainRevision = terrainRevision;
      this.terrainRefreshAt = now + 100;
    }
    const referenceChanged = tiles !== this.tilesReference;
    const nextTileSignature = referenceChanged
      ? tiles.map((tile) => tileKey(tile.id)).join('|')
      : this.tileSignature;
    const tilesChanged = nextTileSignature !== this.tileSignature;
    // Global terrain notifications may concern a different continent. Keep
    // the diagnostic grid when none of its actual sampled anchors changed.
    if (!tilesChanged && this.terrain?.heightVersionAt &&
        [...this.heightProbes.values()].every((probe) =>
          this.terrain!.heightVersionAt!(probe.longitude, probe.latitude) === probe.version)) {
      this.tilesReference = tiles;
      this.renderedTerrainRevision = terrainRevision;
      return false;
    }
    if (
      !tilesChanged &&
      terrainRevision !== this.renderedTerrainRevision &&
      now < this.terrainRefreshAt
    ) return false;
    const signature = `${terrainRevision}|${nextTileSignature}`;
    if (signature === this.signature) return false;
    this.signature = signature;
    this.tilesReference = tiles;
    this.tileSignature = nextTileSignature;
    this.renderedTerrainRevision = terrainRevision;
    this.heightProbes.clear();

    const chunks: GridChunk[] = [];
    for (const tile of tiles) {
      const key = tileKey(tile.id);
      let chunk = this.tileChunks.get(key);
      if (chunk && chunk.revision !== terrainRevision && this.terrain &&
          (!this.terrain.heightVersionAt || ![...chunk.probes.values()].every(probe =>
            this.terrain!.heightVersionAt!(probe.longitude, probe.latitude) === probe.version))) {
        this.chunkBytes -= chunk.bytes; this.tileChunks.delete(key); chunk = undefined;
      }
      if (!chunk) {
        const positions: number[] = [], colors: number[] = [], originsHigh: number[] = [], originsLow: number[] = [];
        const probes = new Map<string, HeightProbe>();
        this.activeProbes = probes;
        try { this.appendTile(tile, positions, colors, originsHigh, originsLow); }
        finally { this.activeProbes = null; }
        chunk = { revision: terrainRevision, probes, positions: new Float32Array(positions), colors: new Float32Array(colors),
          originsHigh: new Float32Array(originsHigh), originsLow: new Float32Array(originsLow), bytes: positions.length * 16 };
        this.chunkBytes += chunk.bytes;
      }
      chunk.revision = terrainRevision;
      this.tileChunks.delete(key); this.tileChunks.set(key, chunk);
      for (const [pointKey, probe] of chunk.probes) this.heightProbes.set(pointKey, probe);
      chunks.push(chunk);
      while (this.tileChunks.size > 512 || this.chunkBytes > 8 * 1024 * 1024) {
        const oldest = this.tileChunks.keys().next().value!;
        this.chunkBytes -= this.tileChunks.get(oldest)!.bytes; this.tileChunks.delete(oldest);
      }
    }
    this.updateAttributes(chunks);
    return true;
  }

  handleContextRestored(): void {
    for (const attribute of Object.values(this.geometry.attributes)) attribute.needsUpdate = true;
    this.material.needsUpdate = true;
    this.signature = '';
  }

  dispose(): void {
    this.heightProbes.clear();
    this.heightPoints.clear();
    this.tileChunks.clear(); this.chunkBytes = 0;
    this.geometry.dispose();
    const material = this.object3d.material;
    if (Array.isArray(material)) {
      for (const item of material) item.dispose();
    } else {
      material.dispose();
    }
  }

  private updateAttributes(chunks: readonly GridChunk[]): void {
    const vertexCount = chunks.reduce((sum, chunk) => sum + chunk.positions.length / 3, 0);
    if (vertexCount > this.vertexCapacity) {
      this.vertexCapacity = nextPowerOfTwo(Math.max(1, vertexCount));
      // Replacing attributes without disposing the geometry leaves their old
      // WebGLBuffer allocations registered in the renderer. Dispose before a
      // capacity growth, then keep the new attributes stable across updates.
      this.geometry.dispose();
      this.geometry.setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array(this.vertexCapacity * 3), 3)
      );
      this.geometry.setAttribute(
        'color',
        new THREE.BufferAttribute(new Float32Array(this.vertexCapacity * 3), 3)
      );
      this.geometry.setAttribute(
        'sag_originHigh',
        new THREE.BufferAttribute(new Float32Array(this.vertexCapacity * 3), 3)
      );
      this.geometry.setAttribute(
        'sag_originLow',
        new THREE.BufferAttribute(new Float32Array(this.vertexCapacity * 3), 3)
      );
    }
    for (const [name, property] of [['position', 'positions'], ['color', 'colors'],
      ['sag_originHigh', 'originsHigh'], ['sag_originLow', 'originsLow']] as const) {
      const attribute = this.geometry.getAttribute(name) as THREE.BufferAttribute;
      const array = attribute.array as Float32Array;
      let offset = 0;
      for (const chunk of chunks) { array.set(chunk[property], offset); offset += chunk[property].length; }
      attribute.clearUpdateRanges(); attribute.addUpdateRange(0, offset); attribute.needsUpdate = true;
    }
    this.geometry.setDrawRange(0, vertexCount);
  }

  private appendTile(
    tile: SelectedTile,
    positions: number[],
    colors: number[],
    originsHigh: number[],
    originsLow: number[]
  ): void {
    const { west, east, south, north } = tile.rectangle;
    const color = levelColor(tile.id.level);
    this.ellipsoid.cartographicToCartesian(
      {
        longitude: (west + east) * 0.5,
        latitude: (south + north) * 0.5,
        height: this.heightOffset
      },
      this.tileOrigin
    );
    const originHigh = new THREE.Vector3();
    const originLow = new THREE.Vector3();
    splitVector3(this.tileOrigin, originHigh, originLow);
    // Match the raster's low-level angular precision. Powers of two keep
    // neighbouring parent/child curves coincident at every shared sample.
    const subdivisions = Math.max(
      this.subdivisions,
      Math.round(512 / 2 ** tile.id.level)
    );
    this.appendEdge(west, north, east, north, subdivisions, color, originHigh, originLow, positions, colors, originsHigh, originsLow);
    this.appendEdge(east, north, east, south, subdivisions, color, originHigh, originLow, positions, colors, originsHigh, originsLow);
    this.appendEdge(east, south, west, south, subdivisions, color, originHigh, originLow, positions, colors, originsHigh, originsLow);
    this.appendEdge(west, south, west, north, subdivisions, color, originHigh, originLow, positions, colors, originsHigh, originsLow);
  }

  private appendEdge(
    longitudeStart: number,
    latitudeStart: number,
    longitudeEnd: number,
    latitudeEnd: number,
    subdivisions: number,
    color: THREE.Color,
    originHigh: THREE.Vector3,
    originLow: THREE.Vector3,
    positions: number[],
    colors: number[],
    originsHigh: number[],
    originsLow: number[]
  ): void {
    for (let segment = 0; segment < subdivisions; segment += 1) {
      this.appendVertex(
        THREE.MathUtils.lerp(longitudeStart, longitudeEnd, segment / subdivisions),
        THREE.MathUtils.lerp(latitudeStart, latitudeEnd, segment / subdivisions),
        color,
        originHigh,
        originLow,
        positions,
        colors,
        originsHigh,
        originsLow
      );
      this.appendVertex(
        THREE.MathUtils.lerp(longitudeStart, longitudeEnd, (segment + 1) / subdivisions),
        THREE.MathUtils.lerp(latitudeStart, latitudeEnd, (segment + 1) / subdivisions),
        color,
        originHigh,
        originLow,
        positions,
        colors,
        originsHigh,
        originsLow
      );
    }
  }

  private appendVertex(
    longitude: number,
    latitude: number,
    color: THREE.Color,
    originHigh: THREE.Vector3,
    originLow: THREE.Vector3,
    positions: number[],
    colors: number[],
    originsHigh: number[],
    originsLow: number[]
  ): void {
    const key = `${longitude}/${latitude}`;
    const revision = this.terrain?.revision ?? -1;
    let point = this.heightPoints.get(key);
    if (!point || point.revision !== revision) {
      const version = this.terrain?.heightVersionAt?.(longitude, latitude) ?? String(revision);
      if (!point || point.version !== version) {
        const terrainHeight = this.terrain?.sampleHeight(longitude, latitude) ?? 0;
        point = { revision, version, world: this.ellipsoid.cartographicToCartesian(
          { longitude, latitude, height: terrainHeight + this.heightOffset }) };
        if (!this.heightPoints.has(key) && this.heightPoints.size >= 32768) {
          this.heightPoints.delete(this.heightPoints.keys().next().value!);
        }
        this.heightPoints.set(key, point);
      } else point.revision = revision;
    }
    if (this.terrain?.heightVersionAt) {
      const probe = { longitude, latitude, version: point.version };
      this.heightProbes.set(key, probe); this.activeProbes?.set(key, probe);
    }
    this.vertexWorld.copy(point.world);
    positions.push(
      this.vertexWorld.x - this.tileOrigin.x,
      this.vertexWorld.y - this.tileOrigin.y,
      this.vertexWorld.z - this.tileOrigin.z
    );
    colors.push(color.r, color.g, color.b);
    originsHigh.push(originHigh.x, originHigh.y, originHigh.z);
    originsLow.push(originLow.x, originLow.y, originLow.z);
  }
}

function nextPowerOfTwo(value: number): number {
  return 2 ** Math.ceil(Math.log2(value));
}

function splitVector3(value: THREE.Vector3, high: THREE.Vector3, low: THREE.Vector3): void {
  high.set(Math.fround(value.x), Math.fround(value.y), Math.fround(value.z));
  low.set(value.x - high.x, value.y - high.y, value.z - high.z);
}

function levelColor(level: number): THREE.Color {
  const hue = (0.52 + level * 0.055) % 1;
  return new THREE.Color().setHSL(hue, 0.94, Math.min(0.86, 0.66 + level * 0.025));
}
