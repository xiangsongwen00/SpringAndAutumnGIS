import * as THREE from 'three';
import type { RasterTileProvider } from '../core/tiles/RasterTileProvider';
import type { TerrainProvider } from '../core/terrain/TerrainProvider';

/** Explicit entitySmoke=1 only; never a fallback for real credentials/services. */
export function entityTestRaster():RasterTileProvider {
  return {id:'entity-test-raster',minLevel:0,maxLevel:20,url:()=> 'entity-test://raster',
    async loadTexture(_id,signal){signal?.throwIfAborted();const texture=new THREE.DataTexture(new Uint8Array([15,55,85,255]),1,1,THREE.RGBAFormat);texture.colorSpace=THREE.SRGBColorSpace;texture.needsUpdate=true;return texture;}};
}
export function entityTestTerrain():TerrainProvider {
  return {id:'entity-test-dem',minLevel:0,maxLevel:14,
    async loadTile(id,signal){signal?.throwIfAborted();const n=2**id.level,width=33,heights=new Float32Array(width*width);let minimumHeight=Infinity,maximumHeight=-Infinity;
      for(let y=0;y<width;y++)for(let x=0;x<width;x++){
        const lon=((id.x+x/(width-1))/n*360-180)*Math.PI/180,lat=Math.atan(Math.sinh(Math.PI*(1-2*(id.y+y/(width-1))/n)));
        const h=1400+400*Math.sin(lon*24)*Math.cos(lat*18);heights[y*width+x]=h;minimumHeight=Math.min(minimumHeight,h);maximumHeight=Math.max(maximumHeight,h);
      }const texture=new THREE.DataTexture(heights,width,width,THREE.RedFormat,THREE.FloatType);texture.needsUpdate=true;
      return {id,width,height:width,heights,minimumHeight,maximumHeight,texture};}};
}
