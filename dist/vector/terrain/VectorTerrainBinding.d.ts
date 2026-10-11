import * as THREE from 'three';
import type { TileId } from '../../core/tiling/GeographicTilingScheme';
import type { TerrainHeightSource } from '../../render/TerrainTileLayer';
/** Shared tile-local DEM binding. Does not own/dispose terrain textures. */
export declare function vectorTerrainUniforms(): {
    terrainTexture: {
        value: THREE.Texture | null;
    };
    terrainUvScale: {
        value: THREE.Vector2;
    };
    terrainUvOffset: {
        value: THREE.Vector2;
    };
    terrainTexelSize: {
        value: THREE.Vector2;
    };
    hasTerrain: {
        value: boolean;
    };
    terrainExaggeration: {
        value: number;
    };
};
export declare function bindVectorTerrain(material: THREE.ShaderMaterial, id: TileId, terrain?: TerrainHeightSource): void;
export declare const vectorTerrainShader = "\n  attribute vec2 terrainUv;\n  uniform sampler2D terrainTexture;\n  uniform vec2 terrainUvScale;\n  uniform vec2 terrainUvOffset;\n  uniform vec2 terrainTexelSize;\n  uniform bool hasTerrain;\n  uniform float terrainExaggeration;\n  float vectorElevation() {\n    vec2 uv = terrainUvOffset + terrainUv * terrainUvScale;\n    uv = 0.5 * terrainTexelSize + uv * (vec2(1.0) - terrainTexelSize);\n    return hasTerrain ? texture2D(terrainTexture, uv).r * terrainExaggeration : 0.0;\n  }\n";
//# sourceMappingURL=VectorTerrainBinding.d.ts.map