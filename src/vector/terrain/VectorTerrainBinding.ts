import * as THREE from 'three';
import type { TileId } from '../../core/tiling/GeographicTilingScheme';
import type { TerrainHeightSource } from '../../render/TerrainTileLayer';

/** Shared tile-local DEM binding. Does not own/dispose terrain textures. */
export function vectorTerrainUniforms() {
  return {
    terrainTexture: { value: null as THREE.Texture | null },
    terrainUvScale: { value: new THREE.Vector2(1, 1) },
    terrainUvOffset: { value: new THREE.Vector2() },
    terrainTexelSize: { value: new THREE.Vector2(1, 1) },
    hasTerrain: { value: false },
    terrainExaggeration: { value: 1 }
  };
}

export function bindVectorTerrain(material: THREE.ShaderMaterial, id: TileId, terrain?: TerrainHeightSource): void {
  const binding = terrain?.enabled ? terrain.resolveTexture(id) : undefined;
  const uniforms = material.uniforms;
  uniforms.terrainTexture!.value = binding?.texture ?? null;
  uniforms.hasTerrain!.value = Boolean(binding);
  uniforms.terrainExaggeration!.value = terrain?.exaggeration ?? 1;
  uniforms.terrainUvScale!.value.setScalar(binding?.scale ?? 1);
  uniforms.terrainUvOffset!.value.set(binding?.offsetX ?? 0, binding?.offsetY ?? 0);
  uniforms.terrainTexelSize!.value.set(1 / (binding?.width ?? 1), 1 / (binding?.height ?? 1));
}

export const vectorTerrainShader = /* glsl */ `
  attribute vec2 terrainUv;
  uniform sampler2D terrainTexture;
  uniform vec2 terrainUvScale;
  uniform vec2 terrainUvOffset;
  uniform vec2 terrainTexelSize;
  uniform bool hasTerrain;
  uniform float terrainExaggeration;
  float vectorElevation() {
    vec2 uv = terrainUvOffset + terrainUv * terrainUvScale;
    uv = 0.5 * terrainTexelSize + uv * (vec2(1.0) - terrainTexelSize);
    return hasTerrain ? texture2D(terrainTexture, uv).r * terrainExaggeration : 0.0;
  }
`;
