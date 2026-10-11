import * as THREE from 'three';
import type {RasterTileProvider} from '../core/tiles/RasterTileProvider';
import type {TileId} from '../core/tiling/GeographicTilingScheme';
import {loadTextureWithFetch,type RasterTileLayer} from './RasterTileLayer';

const WIDTH=256,ROWS=32,STRIPE_WIDTH=128,STRIPE_ROWS=4;
type Pole={rgb:Uint8Array;levels:Int16Array;atlas:THREE.DataTexture;coverage:number;mode:'fallback'|'style'|'sampled';dirty:boolean};
type Entry={key:string;mapId:string;north:Pole;south:Pole;queue:TileId[];failures:number;created:number};
export type PolarAppearanceOptions={warmup?:boolean;maxCachedMaps?:number;requestTimeoutMs?:number};
export type PolarAppearanceState=Readonly<{mapId:string|null;north:{mode:'fallback'|'style'|'sampled';coverage:number};south:{mode:'fallback'|'style'|'sampled';coverage:number};
  warming:boolean;queued:number;failures:number;cachedMaps:number;textureBytes:number}>;

/** Per-provider polar atlases. Real map edge pixels, never vendor-name colour constants. */
export class PolarAppearance {
  private readonly cache=new Map<string,Entry>();
  private active:Entry|null=null;
  private renderer:THREE.WebGLRenderer|undefined;
  private readonly identities=new WeakMap<object,number>();
  private serial=0;
  private readonly readCache=new WeakMap<THREE.Texture,Map<string,Uint8Array>>();
  private readonly processed=new WeakMap<Entry,Set<string>>();
  private lastSample=0;
  private lastWarm=0;
  private job:{controller:AbortController;entry:Entry}|null=null;
  private sampler:{target:THREE.WebGLRenderTarget;scene:THREE.Scene;camera:THREE.Camera;material:THREE.ShaderMaterial;geometry:THREE.PlaneGeometry}|null=null;
  private disposed=false;
  private readonly released=new WeakSet<THREE.Texture>();
  constructor(private readonly fallbackNorth:THREE.Color,private readonly fallbackSouth:THREE.Color,private readonly options:PolarAppearanceOptions={}){}
  setRenderer(renderer:THREE.WebGLRenderer):void{this.renderer=renderer;}
  get state():PolarAppearanceState{return {mapId:this.active?.mapId??null,north:{mode:this.active?.north.mode??'fallback',coverage:this.active?.north.coverage??0},
    south:{mode:this.active?.south.mode??'fallback',coverage:this.active?.south.coverage??0},warming:!!this.job,queued:this.active?.queue.length??0,failures:this.active?.failures??0,
    cachedMaps:this.cache.size,textureBytes:this.cache.size*WIDTH*ROWS*4*2};}
  texture(north:boolean):THREE.Texture|null{return this.active?(north?this.active.north:this.active.south).atlas:null;}
  update(raster:RasterTileLayer|null):void{
    if(this.disposed)return;
    if(!raster){this.job?.controller.abort();this.active=null;return;}
    const provider=raster.provider;let id=this.identities.get(provider);if(!id){id=++this.serial;this.identities.set(provider,id);}
    const identity=provider.polarAppearanceKey??`instance-${id}`,key=provider.polarStylePalette?`${identity}/${provider.polarStylePalette.key}`:identity;
    if(this.active?.key!==key){this.job?.controller.abort();this.active=this.cache.get(key)??this.create(provider,key);this.cache.delete(key);this.cache.set(key,this.active);this.lastSample=-Infinity;}
    const entry=this.active,now=performance.now();
    if(now-this.lastSample>=250){this.lastSample=now;
      // At most one new GPU read per update; cached/CPU stripes are inexpensive.
      const done=this.processed.get(entry)??new Set<string>();this.processed.set(entry,done);let reads=0;
      for(const source of raster.polarTextureSources())for(const north of [true,false]){
        const n=2**source.id.level;if(source.id.y!==(north?0:n-1))continue;
        const token=`${source.id.level}/${source.id.x}/${source.id.y}/${source.texture.uuid}/${source.texture.version}/${north}`;if(done.has(token))continue;
        if(reads>=1)continue;const stripe=this.read(source.texture,north);if(!stripe)continue;reads++;done.add(token);while(done.size>512)done.delete(done.values().next().value!);this.ingest(entry,source.id,north,stripe);
      }
      this.publish(entry);
    }
    this.warm(entry,raster,provider,now);
    const limit=Math.min(64,Math.max(1,Math.floor(this.options.maxCachedMaps??24)));
    while(this.cache.size>limit){const oldest=this.cache.keys().next().value!;if(oldest===entry.key)break;const old=this.cache.get(oldest)!;old.north.atlas.dispose();old.south.atlas.dispose();this.cache.delete(oldest);}
  }
  dispose():void{if(this.disposed)return;this.disposed=true;this.job?.controller.abort();for(const e of this.cache.values()){e.north.atlas.dispose();e.south.atlas.dispose();}this.cache.clear();this.active=null;
    if(this.sampler){this.sampler.target.dispose();this.sampler.material.dispose();this.sampler.geometry.dispose();this.sampler=null;}}
  private create(provider:RasterTileProvider,key:string):Entry{
    const palette=provider.polarStylePalette,make=(north:boolean):Pole=>{
      const colour=palette?new THREE.Color(north?palette.north:palette.south):north?this.fallbackNorth:this.fallbackSouth;
      const data=new Uint8Array(WIDTH*ROWS*4),encoded=colour.clone().convertLinearToSRGB();
      for(let i=0;i<data.length;i+=4){data[i]=Math.round(encoded.r*255);data[i+1]=Math.round(encoded.g*255);data[i+2]=Math.round(encoded.b*255);data[i+3]=255;}
      const texture=new THREE.DataTexture(data,WIDTH,ROWS,THREE.RGBAFormat);texture.colorSpace=THREE.SRGBColorSpace;texture.wrapS=THREE.RepeatWrapping;texture.minFilter=THREE.LinearFilter;texture.magFilter=THREE.LinearFilter;texture.generateMipmaps=false;texture.needsUpdate=true;
      return {rgb:new Uint8Array(WIDTH*3),levels:new Int16Array(WIDTH).fill(-1),atlas:texture,coverage:0,mode:palette?'style':'fallback',dirty:false};
    };
    const level=Math.max(provider.minLevel,Math.min(1,provider.maxLevel)),queue:TileId[]=[];
    if(this.options.warmup!==false&&level<=3)for(const y of new Set([0,2**level-1]))for(let x=0;x<2**level;x++){const tile={level,x,y};if(provider.hasTile?.(tile)!==false)queue.push(tile);}
    const entry={key,mapId:provider.id,north:make(true),south:make(false),queue,failures:0,created:performance.now()};this.cache.set(key,entry);return entry;
  }
  private ingest(entry:Entry,id:TileId,north:boolean,stripe:Uint8Array):void{
    const pole=north?entry.north:entry.south,n=2**id.level,west=id.x/n,east=(id.x+1)/n;
    for(let x=Math.max(0,Math.floor(west*WIDTH));x<Math.min(WIDTH,Math.ceil(east*WIDTH));x++){
      if(id.level<pole.levels[x]!)continue;const u=((x+.5)/WIDTH-west)/(east-west);if(u<0||u>1)continue;
      const sx=Math.min(STRIPE_WIDTH-1,Math.floor(u*STRIPE_WIDTH));let alpha=0;const sum=[0,0,0];
      for(let y=0;y<STRIPE_ROWS;y++){const k=(y*STRIPE_WIDTH+sx)*4,a=stripe[k+3]!/255;alpha+=a;for(let c=0;c<3;c++)sum[c]=sum[c]!+stripe[k+c]!*a;}
      if(alpha<.2)continue;
      for(let c=0;c<3;c++){const v=Math.round(sum[c]!/alpha);if(v!==pole.rgb[x*3+c])pole.dirty=true;pole.rgb[x*3+c]=v;}
      if(pole.levels[x]!==id.level)pole.dirty=true;pole.levels[x]=id.level;
    }
    pole.coverage=[...pole.levels].filter(level=>level>=0).length/WIDTH;if(pole.coverage>0&&pole.mode!=='sampled'){pole.mode='sampled';pole.dirty=true;}
  }
  private publish(entry:Entry):void{
    for(const pole of [entry.north,entry.south])if(pole.dirty){pole.dirty=false;
      const valid=[...pole.levels].map((l,i)=>l>=0?i:-1).filter(i=>i>=0),mean=[0,0,0];
      for(const i of valid)for(let c=0;c<3;c++)mean[c]=mean[c]!+pole.rgb[i*3+c]!/valid.length;
      const ring=new Float32Array(WIDTH*3);
      for(let x=0;x<WIDTH;x++)for(let c=0;c<3;c++)ring[x*3+c]=pole.levels[x]!>=0?pole.rgb[x*3+c]!:mean[c]!;
      const prefixes=[0,1,2].map(c=>{const prefix=new Float32Array(WIDTH*3+1);for(let i=0;i<WIDTH*3;i++)prefix[i+1]=prefix[i]!+ring[(i%WIDTH)*3+c]!;return prefix;});
      const data=pole.atlas.image.data as Uint8Array;
      for(let y=0;y<ROWS;y++){const t=y/(ROWS-1),radius=Math.min(32,1+Math.floor(t*32)),blend=t*t*(3-2*t);
        for(let x=0;x<WIDTH;x++){for(let c=0;c<3;c++){const prefix=prefixes[c]!,centre=x+WIDTH,sum=prefix[centre+radius+1]!-prefix[centre-radius]!;
          data[(y*WIDTH+x)*4+c]=Math.round(sum/(radius*2+1)*(1-blend)+mean[c]!*blend);}data[(y*WIDTH+x)*4+3]=255;}}
      // Every longitude converges to the SAME provider-derived centre colour.
      pole.atlas.needsUpdate=true;
    }
  }
  private read(texture:THREE.Texture,north:boolean):Uint8Array|null{
    const token=`${texture.version}/${north}`;let cache=this.readCache.get(texture);if(cache?.has(token))return cache.get(token)!;
    const image=texture.image as {width?:number;height?:number;data?:Uint8Array},width=image?.width??0,height=image?.height??0;let result:Uint8Array|null=null;
    if(image?.data instanceof Uint8Array&&image.data.length===width*height*4&&width>0){
      result=new Uint8Array(STRIPE_WIDTH*STRIPE_ROWS*4);
      for(let y=0;y<STRIPE_ROWS;y++)for(let x=0;x<STRIPE_WIDTH;x++){
        const v=north?1-(y+.5)/height:(y+.5)/height,sy=Math.max(0,Math.min(height-1,Math.floor((texture.flipY?1-v:v)*height))),sx=Math.min(width-1,Math.floor((x+.5)/STRIPE_WIDTH*width)),from=(sy*width+sx)*4,to=(y*STRIPE_WIDTH+x)*4;
        for(let c=0;c<4;c++)result[to+c]=image.data[from+c]!;
        if(texture.colorSpace!==THREE.SRGBColorSpace){const colour=new THREE.Color().setRGB(result[to]!/255,result[to+1]!/255,result[to+2]!/255).convertLinearToSRGB();result[to]=Math.round(colour.r*255);result[to+1]=Math.round(colour.g*255);result[to+2]=Math.round(colour.b*255);}
      }
    }else if(this.renderer&&!this.renderer.getContext().isContextLost()){
      const renderer=this.renderer;if(!this.sampler){const target=new THREE.WebGLRenderTarget(STRIPE_WIDTH,STRIPE_ROWS,{depthBuffer:false,stencilBuffer:false});target.texture.colorSpace=THREE.SRGBColorSpace;
        const geometry=new THREE.PlaneGeometry(2,2),material=new THREE.ShaderMaterial({depthTest:false,depthWrite:false,toneMapped:false,uniforms:{map:{value:null},north:{value:true},height:{value:256}},
          vertexShader:'varying vec2 q;void main(){q=uv;gl_Position=vec4(position.xy,0.,1.);}',fragmentShader:`uniform sampler2D map;uniform bool north;uniform float height;varying vec2 q;void main(){float row=(0.5+q.y*3.0)/max(height,4.0);gl_FragColor=texture2D(map,vec2(q.x,north?1.0-row:row));
          #include <colorspace_fragment>
          }`});const scene=new THREE.Scene();scene.add(new THREE.Mesh(geometry,material));this.sampler={target,geometry,material,scene,camera:new THREE.Camera()};}
      const old=renderer.getRenderTarget(),cube=renderer.getActiveCubeFace(),mip=renderer.getActiveMipmapLevel(),viewport=renderer.getViewport(new THREE.Vector4()),scissor=renderer.getScissor(new THREE.Vector4()),test=renderer.getScissorTest(),auto=renderer.autoClear;
      try{const s=this.sampler;s.material.uniforms.map!.value=texture;s.material.uniforms.north!.value=north;s.material.uniforms.height!.value=height||256;
        renderer.setRenderTarget(s.target);renderer.setScissorTest(false);renderer.autoClear=true;renderer.render(s.scene,s.camera);result=new Uint8Array(STRIPE_WIDTH*STRIPE_ROWS*4);renderer.readRenderTargetPixels(s.target,0,0,STRIPE_WIDTH,STRIPE_ROWS,result);
      }catch{result=null;}finally{this.sampler.material.uniforms.map!.value=null;renderer.setRenderTarget(old,cube,mip);renderer.setViewport(viewport);renderer.setScissor(scissor);renderer.setScissorTest(test);renderer.autoClear=auto;}
    }
    if(result){if(!cache){cache=new Map();this.readCache.set(texture,cache);}if(cache.size>=2&&!cache.has(token))cache.clear();cache.set(token,result);}return result;
  }
  private warm(entry:Entry,raster:RasterTileLayer,provider:RasterTileProvider,now:number):void{
    if(this.options.warmup===false||!this.renderer||this.job||now-entry.created<1500||now-this.lastWarm<250||!entry.queue.length)return;
    // Never compete with a busy foreground tile queue for native-vector worker
    // preparation slots or image fetches. Cached pixels still bake immediately.
    const foreground=raster.stats;if(foreground.loading>=2||foreground.queued>=8)return;
    const tile=entry.queue.shift()!;this.lastWarm=now;
    const existing=raster.polarTextureSources().find(s=>s.id.level===tile.level&&s.id.x===tile.x&&s.id.y===tile.y);
    if(existing){for(const north of [true,false])if(tile.y===(north?0:2**tile.level-1)){const data=this.read(existing.texture,north);if(data)this.ingest(entry,tile,north,data);}this.publish(entry);return;}
    const controller=new AbortController(),job={controller,entry};this.job=job;
    const timer=setTimeout(()=>controller.abort(),Math.max(1000,this.options.requestTimeoutMs??5000));
    let rejectAbort:()=>void=()=>{};const abort=new Promise<never>((_,reject)=>{rejectAbort=()=>reject(new Error('Polar warmup cancelled'));controller.signal.addEventListener('abort',rejectAbort,{once:true});});
    const loading=Promise.resolve().then(()=>provider.loadTexture?provider.loadTexture(tile,controller.signal):loadTextureWithFetch(provider.url(tile),controller.signal));
    const release=(texture:THREE.Texture)=>{if(!this.released.has(texture)){this.released.add(texture);texture.dispose();}};
    void loading.then(texture=>{if(controller.signal.aborted||this.disposed)release(texture);},()=>{});
    void Promise.race([loading,abort]).then(texture=>{try{if(this.disposed||controller.signal.aborted||this.active!==entry)return;texture.colorSpace=THREE.SRGBColorSpace;
        for(const north of [true,false])if(tile.y===(north?0:2**tile.level-1)){const stripe=this.read(texture,north);if(stripe)this.ingest(entry,tile,north,stripe);}this.publish(entry);
      }finally{release(texture);}
    },()=>{if(!this.disposed&&this.active===entry)entry.failures++;}).finally(()=>{clearTimeout(timer);controller.signal.removeEventListener('abort',rejectAbort);if(this.job===job)this.job=null;});
  }
}
