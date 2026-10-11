import * as THREE from 'three';
import {VectorStyleRuntime} from '../vector/style/VectorStyleRuntime';
import type {MapStyle,DecodedFeature} from '../vector/style/VectorStyleTypes';

export type PolarStylePalette=Readonly<{north:string;south:string;key:string}>;
/** Opaque configuration fingerprint for cache isolation; never exposes URLs/keys. */
export function polarConfigurationKey(value:string):string{
  let a=2166136261,b=5381;for(let i=0;i<value.length;i++){a=Math.imul(a^value.charCodeAt(i),16777619);b=Math.imul(b,33)^value.charCodeAt(i);}return `${(a>>>0).toString(16)}-${(b>>>0).toString(16)}`;
}
/** Style-specific fallback before pixels are available. No vendor-name colour table. */
export function polarPaletteFromStyle(style:MapStyle):PolarStylePalette|null{
  const runtime=new VectorStyleRuntime(style,new Set(['background','fill']));let background:string|null=null,water:string|null=null,ice:string|null=null,land:string|null=null;
  for(const layer of runtime.layers){
    if(layer.minzoom!==undefined&&layer.minzoom>2)continue;
    const text=`${layer.id} ${layer['source-layer']??''} ${JSON.stringify(layer.filter??[])}`.toLowerCase();
    const kind=/ice|snow|glacier/.test(text)?'ice':/water|ocean|sea/.test(text)?'water':'land';
    const feature:DecodedFeature={type:3,extent:4096,geometry:[],properties:{class:kind,type:kind,subclass:kind}};
    try{const evaluated=runtime.evaluate(layer,2,feature);if(evaluated.layout?.visibility==='none')continue;
      const paint=evaluated.paint??{},raw=paint[layer.type==='background'?'background-color':'fill-color'];
      if(typeof raw!=='string'||Number(paint[layer.type==='background'?'background-opacity':'fill-opacity']??1)<=0)continue;
      // Ignore alpha for the opaque completion; alpha=0 is no data, not black.
      const match=/rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\s*\)/.exec(raw);if(match&&Number(match[1])===0)continue;
      const colour=new THREE.Color(raw.replace(/rgba\(([^,]+),([^,]+),([^,]+),[^)]+\)/,'rgb($1,$2,$3)'));
      const value=`#${colour.getHexString()}`;
      if(layer.type==='background')background=value;else if(kind==='water')water=value;else if(kind==='ice')ice=value;else if(/land|earth|ground/.test(text))land=value;
    }catch{/* Unsupported/data-dependent paint keeps other usable style layers. */}
  }
  if(!background&&!water&&!ice&&!land)return null;
  return Object.freeze({north:water??background??land??ice!,south:ice??land??background??water!,key:polarConfigurationKey(JSON.stringify(style))});
}
