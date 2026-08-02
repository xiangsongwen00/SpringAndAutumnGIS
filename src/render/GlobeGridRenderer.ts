import * as THREE from 'three';
import { Ellipsoid } from '../core/geo/Ellipsoid';
import { tileKey } from '../core/tiling/GeographicTilingScheme';
import type { SelectedTile } from '../core/lod/GlobeLodSelector';
import { globeCoordinateShader } from './shaders/coordinates';
import type { TerrainHeightSource } from './TerrainTileLayer';

export type GlobeGridRendererOptions = {
  subdivisions?: number;
  heightOffset?: number;
  terrain?: TerrainHeightSource;
};

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
    this.object3d.frustumCulled = false;
    this.object3d.renderOrder = 2;
    this.object3d.onBeforeRender = (_renderer, _scene, camera) => {
      splitVector3(camera.position, this.cameraHigh, this.cameraLow);
    };
  }

  update(tiles: readonly SelectedTile[], cameraPosition?: THREE.Vector3): boolean {
    if (cameraPosition) splitVector3(cameraPosition, this.cameraHigh, this.cameraLow);
    const signature = `${this.terrain?.revision ?? 0}|${tiles.map((tile) => tileKey(tile.id)).join('|')}`;
    if (signature === this.signature) return false;
    this.signature = signature;

    const positions: number[] = [];
    const colors: number[] = [];
    const originsHigh: number[] = [];
    const originsLow: number[] = [];
    for (const tile of tiles) {
      this.appendTile(tile, positions, colors, originsHigh, originsLow);
    }
    this.geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    this.geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this.geometry.setAttribute('sag_originHigh', new THREE.Float32BufferAttribute(originsHigh, 3));
    this.geometry.setAttribute('sag_originLow', new THREE.Float32BufferAttribute(originsLow, 3));
    return true;
  }

  dispose(): void {
    this.geometry.dispose();
    const material = this.object3d.material;
    if (Array.isArray(material)) {
      for (const item of material) item.dispose();
    } else {
      material.dispose();
    }
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
    const terrainHeight = this.terrain?.sampleHeight(longitude, latitude) ?? 0;
    this.ellipsoid.cartographicToCartesian(
      { longitude, latitude, height: terrainHeight + this.heightOffset },
      this.vertexWorld
    );
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

function splitVector3(value: THREE.Vector3, high: THREE.Vector3, low: THREE.Vector3): void {
  high.set(Math.fround(value.x), Math.fround(value.y), Math.fround(value.z));
  low.set(value.x - high.x, value.y - high.y, value.z - high.z);
}

function levelColor(level: number): THREE.Color {
  const hue = (0.52 + level * 0.055) % 1;
  return new THREE.Color().setHSL(hue, 0.94, Math.min(0.86, 0.66 + level * 0.025));
}
