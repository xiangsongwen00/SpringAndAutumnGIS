import assert from 'node:assert/strict';
import * as THREE from 'three';
import {PolarAppearance,UrlTemplateRasterProvider,polarPaletteFromStyle} from '../dist/spring-and-autumn-gis.es.js';

const style=(ocean,snow)=>({version:8,sources:{test:{type:'vector',tiles:['https://example.invalid/{z}/{x}/{y}']}},layers:[
 {id:'background',type:'background',paint:{'background-color':'#121212'}},
 {id:'water',type:'fill',source:'test','source-layer':'water',paint:{'fill-color':ocean}},
 {id:'glacier-ice',type:'fill',source:'test','source-layer':'landcover',paint:{'fill-color':snow}}
]});
assert.equal(polarPaletteFromStyle(style('#204080','#f4e8d0')).north,'#204080');
assert.equal(polarPaletteFromStyle(style('#204080','#f4e8d0')).south,'#f4e8d0');
assert.notEqual(polarPaletteFromStyle(style('#204080','#f4e8d0')).key,polarPaletteFromStyle(style('#111133','#ccccdd')).key);
const a=new UrlTemplateRasterProvider({id:'same-id',urlTemplate:'https://a.invalid/{z}/{x}/{y}'}),b=new UrlTemplateRasterProvider({id:'same-id',urlTemplate:'https://b.invalid/{z}/{x}/{y}'});
assert.notEqual(a.polarAppearanceKey,b.polarAppearanceKey);const key=a.polarAppearanceKey;a.setViewLevel(20);assert.equal(a.polarAppearanceKey,key,'Ordinary LOD must not rebake a map');

function image(north,south,flipY=true){const data=new Uint8Array(8*32*4);for(let y=0;y<32;y++)for(let x=0;x<8;x++){
 const colour=(flipY?y<16:y>=16)?north:south,k=(y*8+x)*4;data.set([...colour,255],k);
}const tex=new THREE.DataTexture(data,8,32);tex.flipY=flipY;tex.colorSpace=THREE.SRGBColorSpace;tex.needsUpdate=true;return tex;}
const atlas=new PolarAppearance(new THREE.Color('#244d66'),new THREE.Color('#edf2f6'),{warmup:false,maxCachedMaps:4});
const cases=[['google', [20,70,120],[230,235,240]],['tianditu',[35,90,150],[245,243,239]],['esri',[120,155,190],[212,218,225]],['osm',[165,210,225],[225,234,213]]];
const textures=[];
for(const [id,north,south] of cases){
 const texture=image(north,south,id!=='tianditu');textures.push(texture);
 const raster={provider:{id,minLevel:0,maxLevel:20,polarAppearanceKey:id},polarTextureSources:()=>[{id:{level:0,x:0,y:0},texture}],stats:{loading:0,queued:0}};
 for(let i=0;i<3;i++){atlas.lastSample=-Infinity;atlas.update(raster);}
 assert.equal(atlas.state.mapId,id);assert.equal(atlas.state.north.mode,'sampled');assert.equal(atlas.state.south.mode,'sampled');assert.equal(atlas.state.north.coverage,1);assert.equal(atlas.state.south.coverage,1);
 for(const pole of [true,false]){const data=atlas.texture(pole).image.data,expected=pole?north:south;
   // Centre AND intermediate rows come from THIS map, not a fixed colour.
   for(const row of [10,31])for(const column of [0,80,200])assert.deepEqual([...data.slice((row*256+column)*4,(row*256+column)*4+3)],expected);}
}
const firstNorth=atlas.cache.get('google').north.atlas;atlas.update({provider:{id:'google',minLevel:0,maxLevel:20,polarAppearanceKey:'google'},polarTextureSources:()=>[],stats:{loading:0,queued:0}});assert.equal(atlas.texture(true),firstNorth,'Prepared per-map atlas must survive switching');
const palette=polarPaletteFromStyle(style('#172b46','#e0e8ef'));atlas.update({provider:{id:'native-vector',minLevel:0,maxLevel:20,polarAppearanceKey:palette.key,polarStylePalette:palette},polarTextureSources:()=>[],stats:{loading:0,queued:0}});
assert.equal(atlas.state.north.mode,'style');assert.deepEqual([...atlas.texture(true).image.data.slice(0,3)],[23,43,70]);assert.deepEqual([...atlas.texture(false).image.data.slice(0,3)],[224,232,239]);assert.equal(atlas.state.cachedMaps,4);
// Transparent pixels are absent data, not a black atlas.
const blank=image([0,0,0],[0,0,0]);for(let i=3;i<blank.image.data.length;i+=4)blank.image.data[i]=0;textures.push(blank);
const empty={provider:{id:'no-data',minLevel:0,maxLevel:20,polarAppearanceKey:'empty'},polarTextureSources:()=>[{id:{level:0,x:0,y:0},texture:blank}],stats:{loading:0,queued:0}};
for(let i=0;i<2;i++){atlas.lastSample=-Infinity;atlas.update(empty);}assert.equal(atlas.state.north.mode,'fallback');assert.equal(atlas.state.north.coverage,0);
let disposed=0;for(const texture of textures)texture.addEventListener('dispose',()=>disposed++);atlas.dispose();assert.equal(disposed,0,'Borrowed base pixels are not atlas-owned');for(const texture of textures)texture.dispose();
console.log('All raster-provider identities, native style palettes, whole-cap map-derived pixels, XYZ/flipY sampling, cache isolation, alpha/no-data and borrowed lifecycle passed.');

// Bounded low-priority warmup: foreground gets precedence; cancellation and late
// provider results cannot leak textures or overwrite a new map's prepared atlas.
let finishLate,calls=0;const late=new Promise(resolve=>{finishLate=resolve;});
const warmer=new PolarAppearance(new THREE.Color('#123456'),new THREE.Color('#abcdef'),{requestTimeoutMs:1000,maxCachedMaps:2});warmer.setRenderer({getContext:()=>({isContextLost:()=>false})});
const slow={provider:{id:'slow',minLevel:0,maxLevel:20,polarAppearanceKey:'slow',loadTexture:()=>{calls++;return late;}},polarTextureSources:()=>[],stats:{loading:10,queued:20}};
warmer.update(slow);warmer.active.created-=2000;warmer.lastWarm=-Infinity;warmer.update(slow);assert.equal(calls,0,'Foreground must suppress extra low-zoom requests');
slow.stats={loading:0,queued:0};warmer.update(slow);await new Promise(resolve=>setTimeout(resolve,10));assert.equal(calls,1);assert.equal(warmer.state.warming,true);
await new Promise(resolve=>setTimeout(resolve,1100));assert.equal(warmer.state.warming,false);assert.equal(warmer.state.failures,1,'Timeout must release the warmup slot');
const after={provider:{id:'after',minLevel:0,maxLevel:20,polarAppearanceKey:'after',polarStylePalette:palette},polarTextureSources:()=>[],stats:{loading:0,queued:0}};warmer.update(after);
const stale=image([255,0,0],[255,0,0]);let lateDisposals=0;stale.addEventListener('dispose',()=>lateDisposals++);finishLate(stale);await new Promise(resolve=>setTimeout(resolve,10));
assert.equal(lateDisposals,1);assert.equal(warmer.state.mapId,'after');assert.equal(warmer.state.north.mode,'style');warmer.dispose();
console.log('Foreground precedence, low-zoom slot timeout, late-result disposal and map-switch isolation passed.');
