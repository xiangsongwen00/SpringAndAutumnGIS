import { EntityCollection, EntityError, validateEntity } from './EntityCollection';
import { EntityLayer } from '../render/EntityLayer';
import type { GlobeEngine } from '../engine/GlobeEngine';
import type { EntityDefinition, EntityPosition, EntitySnapshot, LabelSymbol, PointSymbol, LineSymbol, PolygonSymbol } from './EntityTypes';
import type { SurfacePickOptions } from '../core/geo/SurfacePicker';

export type EntityDrawOptions = { type: EntityDefinition['type']; id?: string; name?: string; properties?: Record<string,unknown>;
  symbol?: PointSymbol|LineSymbol|PolygonSymbol; label?: LabelSymbol; pick?: SurfacePickOptions };
export type EntityDrawState = Readonly<{ active:boolean; type:EntityDefinition['type']|null; vertexCount:number;
  positions:readonly EntityPosition[]; lastEntityId:string|null; error:string|null }>;

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
  private destroyed=false;
  constructor(private readonly engine:GlobeEngine,private readonly entities:EntityCollection,private readonly layerId='__entity_draw_preview') {
    this.previewLayer=new EntityLayer(engine.ellipsoid,this.preview);engine.addSceneLayer(layerId,this.previewLayer);this.preview.setVisible(false);
    const canvas=engine.renderer.domElement;
    canvas.addEventListener('pointerdown',event=>{if(!this.isActive||event.button!==0)return;
      event.preventDefault();event.stopImmediatePropagation();this.pointer={x:event.clientX,y:event.clientY,id:event.pointerId};},{signal:this.events.signal});
    canvas.addEventListener('pointercancel',()=>{this.pointer=undefined;},{signal:this.events.signal});
    canvas.addEventListener('pointermove',event=>{
      if(!this.isActive||this.pointer||performance.now()-this.lastPreview<40)return;this.lastPreview=performance.now();
      const p=this.pick(event);this.showPreview(p??undefined);
    },{signal:this.events.signal});
    canvas.addEventListener('pointerup',event=>{
      if(!this.isActive)return;event.preventDefault();event.stopImmediatePropagation();const start=this.pointer;this.pointer=undefined;
      if(!start||start.id!==event.pointerId||Math.hypot(event.clientX-start.x,event.clientY-start.y)>4)return;
      try{const p=this.pick(event);if(!p){this.error='天空／无显示地表交点，未加入顶点。';this.emit();return;}
        if(this.positions.length>=1000)throw new EntityError('INVALID_ENTITY','Mouse drawing supports at most 1000 vertices.');
        this.positions.push(p);this.error=null;this.showPreview();this.emit();
        if(this.options?.type==='point'||this.options?.type==='label')this.finish();
      }catch(error){this.error=error instanceof Error?error.message:'绘制失败';this.emit();}
    },{signal:this.events.signal});
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
    positions:Object.freeze(this.positions.map(p=>Object.freeze([...p]) as EntityPosition)),lastEntityId:this.lastId,error:this.error});}
  start(options:EntityDrawOptions):EntityDrawState {
    this.assertAlive();
    if(!options||!['point','polyline','polygon','label'].includes(options.type))throw new EntityError('INVALID_ENTITY','Invalid drawing type.');
    if(options.id&&this.entities.has(options.id))throw new EntityError('DUPLICATE_ID','Drawing id already exists.');
    const candidate=this.definition(options,[[0,0,0],[.001,0,0],[.001,.001,0]],options.id??'__draw_validation');validateEntity(candidate);
    if(options.pick?.mode==='absolute-height'&&!Number.isFinite(options.pick.height))throw new EntityError('INVALID_ENTITY','Fixed-height drawing requires a height.');
    if(options.pick?.mode&&!['surface','ellipsoid','absolute-height'].includes(options.pick.mode))throw new EntityError('INVALID_ENTITY','Invalid drawing pick mode.');
    this.cancel();this.options=structuredClone(options);this.positions=[];this.lastId=null;this.error=null;this.pointer=undefined;
    this.navigation=this.engine.controls.enabled;this.previousCursor=this.engine.renderer.domElement.style.cursor;this.engine.renderer.domElement.style.cursor='crosshair';
    this.engine.controls.cancelAnimation();this.engine.controls.enabled=false;this.preview.setVisible(true);this.emit();return this.state;
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
  private end():void {this.engine.controls.enabled=this.navigation;this.engine.renderer.domElement.style.cursor=this.previousCursor;this.options=undefined;this.pointer=undefined;this.preview.clear();this.preview.setVisible(false);this.positions=[];}
  private pick(event:PointerEvent):EntityPosition|null {
    const rect=this.engine.renderer.domElement.getBoundingClientRect(),result=this.engine.pickPositionDetailed({x:event.clientX-rect.left,y:event.clientY-rect.top},this.options?.pick);
    return result?[result.position.longitude,result.position.latitude,result.position.height]:null;
  }
  private definition(options:EntityDrawOptions,positions:readonly EntityPosition[],id:string):EntityDefinition {
    const common={id,name:options.name,properties:options.properties,label:options.label};
    if(options.type==='point')return {...common,type:'point',position:positions[0]!,symbol:options.symbol as PointSymbol|undefined};
    if(options.type==='polyline')return {...common,type:'polyline',positions,symbol:options.symbol as LineSymbol|undefined};
    if(options.type==='polygon')return {...common,type:'polygon',positions,holes:[],symbol:options.symbol as PolygonSymbol|undefined};
    return {...common,type:'label',position:positions[0]!,label:options.label??{text:options.name??'标注'}};
  }
  private showPreview(cursor?:EntityPosition):void {
    if(!this.options)return;const wanted=new Set<string>();
    for(const [i,p] of this.positions.entries()){const id=`vertex-${i}`;wanted.add(id);if(!this.preview.has(id))this.preview.add({id,type:'point',position:p,symbol:{color:'#ffcc66',size:8,occlusion:'overlay'}});}
    const points=[...this.positions,...(cursor?[cursor]:[])];
    if(points.length>=2){wanted.add('preview-line');const positions=this.options.type==='polygon'&&points.length>=3?[...points,points[0]!]:points;
      if(this.preview.has('preview-line'))this.preview.update('preview-line',{positions});else this.preview.add({id:'preview-line',type:'polyline',positions,symbol:{color:'#ffcc66',width:2}});}
    for(const value of this.preview.values)if(!wanted.has(value.id))this.preview.remove(value.id);
  }
  private emit():void {const state=this.state;for(const listener of [...this.listeners])try{listener(state);}catch{console.warn('[Drawing] A state listener failed.');}}
  private assertAlive():void {if(this.destroyed)throw new EntityError('DESTROYED','Drawing controller has been destroyed.');}
}
