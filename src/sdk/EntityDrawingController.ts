import { EntityCollection, EntityError, validateEntity } from './EntityCollection';
import { EntityLayer } from '../render/EntityLayer';
import type { GlobeEngine } from '../engine/GlobeEngine';
import type { EntityDefinition, EntityPosition, EntitySnapshot, LabelSymbol, PointSymbol, LineSymbol, PolygonSymbol } from './EntityTypes';
import type { SurfacePickOptions } from '../core/geo/SurfacePicker';

export type EntityDrawOptions = { type: EntityDefinition['type']; id?: string; name?: string; properties?: Record<string,unknown>;
  symbol?: PointSymbol|LineSymbol|PolygonSymbol; label?: LabelSymbol; pick?: SurfacePickOptions; heightReference?:'absolute'|'clamp-to-ground';groundOffset?:number;
  /** Default allow: left click draws; right/middle drag and wheel still navigate. */
  navigation?: 'allow'|'lock' };
export type EntityDrawState = Readonly<{ active:boolean; type:EntityDefinition['type']|null; vertexCount:number;
  positions:readonly EntityPosition[]; lastEntityId:string|null; error:string|null;pickMs:number;previewMs:number;previewFrameMs:number }>;

/** Shared mouse expression system: preview, finish, undo, cancel, keyboard and navigation ownership. */
export class EntityDrawingController {
  private readonly events=new AbortController();
  private readonly preview=new EntityCollection();
  private readonly previewLayer:EntityLayer;
  private readonly listeners=new Set<(state:EntityDrawState)=>void>();
  private options:EntityDrawOptions|undefined;
  private positions:EntityPosition[]=[];
  private navigation=true;
  private pointer:{x:number;y:number;id:number}|undefined;
  private lastPreview=0;
  private lastId:string|null=null;
  private error:string|null=null;
  private serial=0;
  private previousCursor='';
  private pickMs=0;
  private previewMs=0;
  private previewFrameMs=0;
  private previewQueuedAt=0;
  private previewProbe:number|undefined;
  private destroyed=false;
  constructor(private readonly engine:GlobeEngine,private readonly entities:EntityCollection,private readonly layerId='__entity_draw_preview') {
    this.previewLayer=new EntityLayer(engine.ellipsoid,this.preview,engine.entityGroundSurface);engine.addSceneLayer(layerId,this.previewLayer);this.preview.setVisible(false);
    const canvas=engine.renderer.domElement;
    canvas.addEventListener('pointerdown',event=>{if(!this.isActive||event.button!==0)return;
      event.preventDefault();event.stopImmediatePropagation();this.pointer={x:event.clientX,y:event.clientY,id:event.pointerId};
      if(event.isTrusted)canvas.setPointerCapture(event.pointerId);
    },{signal:this.events.signal,capture:true});
    canvas.addEventListener('pointercancel',()=>{this.pointer=undefined;},{signal:this.events.signal});
    canvas.addEventListener('pointermove',event=>{
      if(!this.isActive||this.pointer||event.buttons||performance.now()-this.lastPreview<40)return;this.lastPreview=performance.now();
      const started=performance.now(),p=this.pick(event);this.showPreview(p??undefined);this.previewMs=performance.now()-started;this.emit();
    },{signal:this.events.signal});
    canvas.addEventListener('pointerup',event=>{
      if(!this.isActive||event.button!==0)return;event.preventDefault();event.stopImmediatePropagation();const start=this.pointer;this.pointer=undefined;
      if(canvas.hasPointerCapture(event.pointerId))canvas.releasePointerCapture(event.pointerId);
      if(!start||start.id!==event.pointerId||Math.hypot(event.clientX-start.x,event.clientY-start.y)>4)return;
      try{const p=this.pick(event);if(!p){this.error='天空／无显示地表交点，未加入顶点。';this.emit();return;}
        if(this.positions.length>=1000)throw new EntityError('INVALID_ENTITY','Mouse drawing supports at most 1000 vertices.');
        this.positions.push(p);this.error=null;this.showPreview();this.emit();
        if(this.options?.type==='point'||this.options?.type==='label')this.finish();
      }catch(error){this.error=error instanceof Error?error.message:'绘制失败';this.emit();}
    },{signal:this.events.signal,capture:true});
    canvas.ownerDocument.addEventListener('keydown',event=>{
      if(!this.isActive)return;const target=event.target as Element|null,editing=typeof target?.closest==='function'&&!!target.closest('input,textarea,select,[contenteditable="true"]');
      try{if(event.key==='Escape'){event.preventDefault();this.cancel();}
        else if(!editing&&event.key==='Enter'){event.preventDefault();this.finish();}
        else if(!editing&&(event.key==='Backspace'||(event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z')){event.preventDefault();this.undo();}}
      catch(error){this.error=error instanceof Error?error.message:'绘制失败';this.emit();}
    },{signal:this.events.signal});
  }
  get isActive():boolean{return !!this.options;}
  get state():EntityDrawState{return Object.freeze({active:this.isActive,type:this.options?.type??null,vertexCount:this.positions.length,
    positions:Object.freeze(this.positions.map(p=>Object.freeze([...p]) as EntityPosition)),lastEntityId:this.lastId,error:this.error,pickMs:this.pickMs,previewMs:this.previewMs,previewFrameMs:this.previewFrameMs});}
  start(options:EntityDrawOptions):EntityDrawState {
    this.assertAlive();
    if(!options||!['point','polyline','polygon','label'].includes(options.type))throw new EntityError('INVALID_ENTITY','Invalid drawing type.');
    if(options.navigation&&!['allow','lock'].includes(options.navigation))throw new EntityError('INVALID_ENTITY','Invalid drawing navigation policy.');
    if(options.id&&this.entities.has(options.id))throw new EntityError('DUPLICATE_ID','Drawing id already exists.');
    const candidate=this.definition(options,[[0,0,0],[.001,0,0],[.001,.001,0]],options.id??'__draw_validation');validateEntity(candidate);
    if(options.pick?.mode==='absolute-height'&&!Number.isFinite(options.pick.height))throw new EntityError('INVALID_ENTITY','Fixed-height drawing requires a height.');
    if(options.pick?.mode&&!['surface','ellipsoid','absolute-height'].includes(options.pick.mode))throw new EntityError('INVALID_ENTITY','Invalid drawing pick mode.');
    this.cancel();this.options=structuredClone(options);this.positions=[];this.lastId=null;this.error=null;this.pointer=undefined;
    this.navigation=this.engine.controls.enabled;this.previousCursor=this.engine.renderer.domElement.style.cursor;this.engine.renderer.domElement.style.cursor='crosshair';
    this.engine.controls.cancelAnimation();this.engine.controls.enabled=options.navigation==='lock'?false:this.navigation;this.preview.setVisible(true);
    if(options.type==='polyline'||options.type==='polygon'){
      const target=this.engine.controls.target.lengthSq()>1?this.engine.controls.target:this.engine.camera.position;
      const anchor=this.engine.coordinates.worldToGeodetic(target),lon=Math.max(-179.999,Math.min(179.999,anchor.longitude));
      const height=Math.min(10000000,Math.max(-10000,anchor.height));
      this.preview.add({id:'__warm_line',type:'polyline',positions:[[lon,anchor.latitude,height],[lon+.000001,anchor.latitude,height]],symbol:{width:2,opacity:0,occlusion:'overlay'}});
      const canvas=this.engine.renderer.domElement;this.previewLayer.update(this.engine.camera,canvas.clientWidth,canvas.clientHeight);
      // Finite explicit warm-up at mode activation, not a shader compilation on every mouse move.
      void this.engine.renderer.compileAsync(this.previewLayer.object3d,this.engine.camera).catch(()=>{});
    }
    this.emit();return this.state;
  }
  finish():EntitySnapshot {
    this.assertAlive();if(!this.options)throw new EntityError('INVALID_ENTITY','No active drawing.');
    const required=this.options.type==='polyline'?2:this.options.type==='polygon'?3:1;
    if(this.positions.length<required)throw new EntityError('INVALID_ENTITY',`Drawing requires at least ${required} vertices.`);
    let id=this.options.id;while(!id||this.entities.has(id)){
      if(this.options.id)throw new EntityError('DUPLICATE_ID','Drawing id already exists.');id=`draw-${this.options.type}-${++this.serial}`;
    }
    const entity=this.entities.add(this.definition(this.options,this.positions,id));this.lastId=entity.id;this.end();this.emit();return entity;
  }
  undo():EntityDrawState {this.assertAlive();if(this.options){this.positions.pop();this.error=null;this.showPreview();this.emit();}return this.state;}
  cancel():void {if(this.destroyed)return;if(this.options){this.end();this.error=null;this.lastId=null;this.emit();}}
  onChange(listener:(state:EntityDrawState)=>void):()=>void {this.assertAlive();this.listeners.add(listener);return()=>this.listeners.delete(listener);}
  dispose():void {if(this.destroyed)return;this.cancel();this.destroyed=true;this.events.abort();this.listeners.clear();this.engine.removeSceneLayer(this.layerId);this.preview.dispose();}
  private end():void {if(this.previewProbe!==undefined)cancelAnimationFrame(this.previewProbe);this.previewProbe=undefined;this.engine.controls.enabled=this.navigation;this.engine.renderer.domElement.style.cursor=this.previousCursor;this.options=undefined;this.pointer=undefined;this.preview.clear();this.preview.setVisible(false);this.positions=[];}
  private pick(event:PointerEvent):EntityPosition|null {
    const started=performance.now();
    const rect=this.engine.renderer.domElement.getBoundingClientRect(),result=this.engine.pickPositionDetailed({x:event.clientX-rect.left,y:event.clientY-rect.top},this.options?.pick);
    this.pickMs=performance.now()-started;
    return result?[result.position.longitude,result.position.latitude,result.position.height]:null;
  }
  private definition(options:EntityDrawOptions,positions:readonly EntityPosition[],id:string):EntityDefinition {
    const common={id,name:options.name,properties:options.properties,label:options.label,heightReference:options.heightReference,groundOffset:options.groundOffset};
    if(options.type==='point')return {...common,type:'point',position:positions[0]!,symbol:options.symbol as PointSymbol|undefined};
    if(options.type==='polyline')return {...common,type:'polyline',positions,symbol:options.symbol as LineSymbol|undefined};
    if(options.type==='polygon')return {...common,type:'polygon',positions,holes:[],symbol:options.symbol as PolygonSymbol|undefined};
    return {...common,type:'label',position:positions[0]!,label:options.label??{text:options.name??'标注'}};
  }
  private showPreview(cursor?:EntityPosition):void {
    if(!this.options)return;const wanted=new Set<string>();if(this.preview.has('__warm_line'))wanted.add('__warm_line');
    for(const [i,p] of this.positions.entries()){const id=`vertex-${i}`;wanted.add(id);if(!this.preview.has(id))this.preview.add({id,type:'point',position:p,symbol:{color:'#ffcc66',size:8,occlusion:'overlay'}});}
    const points=[...this.positions,...(cursor?[cursor]:[])];
    if(points.length>=2){wanted.add('preview-line');const positions=this.options.type==='polygon'&&points.length>=3?[...points,points[0]!]:points;
      // Immediate rubber-band expression: no ground clipping jobs are restarted for every cursor move.
      // Final entities still commit to the selected live-clamp mode.
      if(this.preview.has('preview-line'))this.preview.update('preview-line',{positions});else this.preview.add({id:'preview-line',type:'polyline',positions,heightReference:'absolute',symbol:{color:'#ffcc66',width:2,occlusion:'overlay'}});}
    for(const value of this.preview.values)if(!wanted.has(value.id))this.preview.remove(value.id);
    if(cursor&&wanted.has('preview-line')){
      this.previewQueuedAt=performance.now();
      if(this.previewProbe===undefined){const probe=()=>{this.previewProbe=undefined;if(!this.isActive)return;
        if(this.previewLayer.getResourceState('preview-line')?.state==='pending'&&performance.now()-this.previewQueuedAt<1000){this.previewProbe=requestAnimationFrame(probe);return;}
        this.previewFrameMs=performance.now()-this.previewQueuedAt;this.emit();};this.previewProbe=requestAnimationFrame(probe);}
    }
  }
  private emit():void {const state=this.state;for(const listener of [...this.listeners])try{listener(state);}catch{console.warn('[Drawing] A state listener failed.');}}
  private assertAlive():void {if(this.destroyed)throw new EntityError('DESTROYED','Drawing controller has been destroyed.');}
}
