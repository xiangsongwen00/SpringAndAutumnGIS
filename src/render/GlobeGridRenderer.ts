import * as THREE from 'three';
import { Ellipsoid } from '../core/geo/Ellipsoid';
import { tileKey } from '../core/tiling/GeographicTilingScheme';
import type { SelectedTile } from '../core/lod/GlobeLodSelector';
import { globeCoordinateShader } from './shaders/coordinates';

export type GlobeGridRendererOptions = {
  subdivisions?: number;
  heightOffset?: number;
};

/** Converts an LOD leaf set into one draw call of coloured latitude/longitude lines. */
export class GlobeGridRenderer {
  readonly object3d: THREE.LineSegments;

  private readonly ellipsoid: Ellipsoid;
  private readonly subdivisions: number;
  private readonly heightOffset: number;
  private readonly geometry: THREE.BufferGeometry;
  private signature = '';

  constructor(ellipsoid: Ellipsoid, options: GlobeGridRendererOptions = {}) {
    this.ellipsoid = ellipsoid;
    this.subdivisions = Math.max(1, Math.round(options.subdivisions ?? 8));
    this.heightOffset = Math.max(0, options.heightOffset ?? 1_200);
    this.geometry = new THREE.BufferGeometry();
    const material = new THREE.ShaderMaterial({
      uniforms: {
        sag_ellipsoidRadii: {
          value: new THREE.Vector2(ellipsoid.equatorialRadius, ellipsoid.polarRadius)
        },
        sag_heightOffset: { value: this.heightOffset },
        opacity: { value: 0.66 }
      },
      vertexShader: /* glsl */ `
        varying vec3 v_color;
        #include <common>
        #include <logdepthbuf_pars_vertex>
        ${globeCoordinateShader}
        void main() {
          v_color = color;
          gl_Position = sag_projectGeodetic(radians(position.xy), position.z);
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
    this.object3d = new THREE.LineSegments(this.geometry, material);
    this.object3d.frustumCulled = false;
    this.object3d.renderOrder = 2;
  }

  update(tiles: readonly SelectedTile[]): boolean {
    const signature = tiles.map((tile) => tileKey(tile.id)).join('|');
    if (signature === this.signature) return false;
    this.signature = signature;

    const positions: number[] = [];
    const colors: number[] = [];
    for (const tile of tiles) this.appendTile(tile, positions, colors);
    this.geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    this.geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
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

  private appendTile(tile: SelectedTile, positions: number[], colors: number[]): void {
    const { west, east, south, north } = tile.rectangle;
    const color = levelColor(tile.id.level);
    this.appendEdge(west, north, east, north, color, positions, colors);
    this.appendEdge(east, north, east, south, color, positions, colors);
    this.appendEdge(east, south, west, south, color, positions, colors);
    this.appendEdge(west, south, west, north, color, positions, colors);
  }

  private appendEdge(
    longitudeStart: number,
    latitudeStart: number,
    longitudeEnd: number,
    latitudeEnd: number,
    color: THREE.Color,
    positions: number[],
    colors: number[]
  ): void {
    for (let segment = 0; segment < this.subdivisions; segment += 1) {
      this.appendVertex(
        THREE.MathUtils.lerp(longitudeStart, longitudeEnd, segment / this.subdivisions),
        THREE.MathUtils.lerp(latitudeStart, latitudeEnd, segment / this.subdivisions),
        color,
        positions,
        colors
      );
      this.appendVertex(
        THREE.MathUtils.lerp(longitudeStart, longitudeEnd, (segment + 1) / this.subdivisions),
        THREE.MathUtils.lerp(latitudeStart, latitudeEnd, (segment + 1) / this.subdivisions),
        color,
        positions,
        colors
      );
    }
  }

  private appendVertex(
    longitude: number,
    latitude: number,
    color: THREE.Color,
    positions: number[],
    colors: number[]
  ): void {
    positions.push(longitude, latitude, 0);
    colors.push(color.r, color.g, color.b);
  }
}

function levelColor(level: number): THREE.Color {
  const hue = (0.52 + level * 0.055) % 1;
  return new THREE.Color().setHSL(hue, 0.94, Math.min(0.86, 0.66 + level * 0.025));
}

