import type { GlobeEngine } from '../engine/GlobeEngine';
import type { EntityDrawingController } from './EntityDrawingController';
import type { MeasurementController } from './Measurement';
import type { EntitySnapshot, EntityDefinition, ScreenPosition } from './EntityTypes';
import type { EntityCollection } from './EntityCollection';
import type { SurfacePickResult } from '../core/geo/SurfacePicker';
import { toolbarIcons } from './ToolbarIcons';

/** Also accepts a source-demo adapter, so no second engine/canvas is created. */
export interface ToolbarTarget {
  readonly engine:GlobeEngine; readonly draw:EntityDrawingController; readonly measure:MeasurementController;
  readonly entities:EntityCollection;
  readonly terrainEnabled:boolean;readonly tileLevelOffset:number|null;
  getBaseMaps():readonly {id:string}[];readonly baseMap:{id:string|null};
  setBaseMap(id:string|null):Promise<unknown>;setTerrainEnabled(enabled:boolean):void;setTileLevelOffset(value:number):void;
  orientNorthUp():void;resetView():void;
  inspectAt(screen:ScreenPosition):{surface:SurfacePickResult|null;entity:EntitySnapshot|null};
}
export type ViewerToolbarOptions={container?:HTMLElement; onEntities?:()=>void;onLayers?:()=>void;
  /** Optional existing source-demo form controls are moved, not cloned. */
  basemapContent?:HTMLElement;offsetContent?:HTMLElement;
  onDraw?:(type:EntityDefinition['type'])=>void;onPanelOpen?:()=>void;
  baseMapNames?:Readonly<Record<string,string>>};

const css=`
.sag-tools{position:absolute;left:12px;bottom:28px;display:flex;flex-direction:column;gap:3px;z-index:30;max-height:calc(100% - 50px);overflow:auto;padding:5px;border:1px solid #336477;border-radius:10px;background:#071d29eb;pointer-events:auto}
.sag-tools button{width:36px;height:34px;padding:5px;border:0;border-radius:5px;background:transparent;color:white;cursor:pointer;flex-shrink:0}
.sag-tools img{width:25px;height:25px;object-fit:contain}.sag-tools button:hover,.sag-tools button[aria-pressed=true]{background:#37758c}.sag-tools button:focus-visible{outline:2px solid #64d8ff}
.sag-tool-panel{position:absolute;right:12px;top:56px;z-index:40;width:min(330px,calc(100% - 76px));max-height:calc(100% - 90px);overflow:auto;box-sizing:border-box;padding:14px;background:#071d29f5;border:1px solid #336477;border-radius:10px;color:#dcf7ff;font:13px/1.6 sans-serif;pointer-events:auto}
.sag-tool-panel[hidden]{display:none}.sag-tool-panel button,.sag-tool-panel select,.sag-tool-panel input{font:inherit;margin:4px;padding:5px;border-radius:5px;max-width:100%;color:#dcf7ff;background:#133342;border:1px solid #336477}
.sag-tool-panel pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:45vh;overflow:auto}.sag-tool-panel label{display:block}.sag-tool-panel header{display:flex;justify-content:space-between;align-items:center}.sag-tool-panel header button{margin:0}.sag-tool-panel output{display:block}
`;
/** Optional library toolbar: one owner, one active drawing/measurement interaction. */
export class ViewerToolbar {
  readonly element:HTMLElement;
  readonly panel:HTMLElement;
  private readonly style:HTMLStyleElement;
  private readonly events=new AbortController();
  private readonly cleanup:(()=>void)[]=[];
  private readonly buttons=new Map<string,HTMLButtonElement>();
  private content:HTMLElement;
  private title:HTMLElement;
  private status:HTMLElement;
  private mode:string|null=null;
  private inspecting=false;
  private pointer:{x:number;y:number;id:number}|null=null;
  private destroyed=false;
  private managerUnsubscribe:(()=>void)|null=null;
  private previousPosition:string|null=null;
  private readonly host:HTMLElement;
  private readonly moved:{node:HTMLElement;parent:Node|null;next:Node|null}[]=[];
  constructor(private readonly target:ToolbarTarget,private readonly options:ViewerToolbarOptions={}){
    const canvas=target.engine.renderer.domElement,doc=canvas.ownerDocument;
    this.host=options.container??canvas.parentElement!;
    if(doc.defaultView!.getComputedStyle(this.host).position==='static'){this.previousPosition=this.host.style.position;this.host.style.position='relative';}
    this.style=doc.createElement('style');this.style.textContent=css;this.host.append(this.style);
    this.element=doc.createElement('nav');this.element.className='sag-tools';this.element.setAttribute('aria-label','地图工具栏');
    this.panel=doc.createElement('aside');this.panel.className='sag-tool-panel';this.panel.hidden=true;
    const header=doc.createElement('header');this.title=doc.createElement('strong');const close=doc.createElement('button');close.textContent='×';close.setAttribute('aria-label','关闭工具面板');
    close.addEventListener('click',()=>this.close(),{signal:this.events.signal});header.append(this.title,close);
    this.content=doc.createElement('div');this.status=doc.createElement('output');this.status.setAttribute('role','status');this.panel.append(header,this.content,this.status);this.host.append(this.element,this.panel);
    const add=(id:string,name:string,icon:string,action:()=>void|Promise<unknown>)=>{
      const button=doc.createElement('button'),img=doc.createElement('img');img.src=icon;img.alt='';button.append(img);button.type='button';button.title=name;button.setAttribute('aria-label',name);button.dataset.tool=id;
      button.addEventListener('click',()=>{Promise.resolve().then(action).catch(error=>{this.open('error','操作未完成');this.status.textContent=error instanceof Error?error.message:'操作失败';});},{signal:this.events.signal});this.element.append(button);this.buttons.set(id,button);
    };
    add('basemap','底图切换',toolbarIcons.basemap,()=>this.baseMaps());
    add('home','恢复初始视角',toolbarIcons.home,()=>target.resetView());
    add('compass','北向俯视（保持相机位置和高度）',toolbarIcons.compass,()=>target.orientNorthUp());
    add('offset','瓦片层级偏移',toolbarIcons.offset,()=>this.offset());
    add('terrain','地形开关',toolbarIcons.terrainOff,()=>{target.setTerrainEnabled(!target.terrainEnabled);this.terrainState();});this.terrainState();
    add('inspect','点坐标与对象属性查询',toolbarIcons.inspect,()=>{this.beginInteraction();this.open('inspect','点属性查询');this.inspecting=true;this.status.textContent='单击地表或业务对象查询；拖拽不会查询。';});
    add('distance','路程测量',toolbarIcons.distance,()=>this.measure('distance'));
    add('area','面积测量',toolbarIcons.area,()=>this.measure('area'));
    for(const [type,icon,name] of [['point',toolbarIcons.point,'绘制点'],['polyline',toolbarIcons.line,'绘制折线'],['polygon',toolbarIcons.polygon,'绘制面']] as const)
      add(`draw-${type}`,name,icon,()=>{this.beginInteraction();if(options.onDraw){this.close();options.onDraw(type);}else{this.open('draw',name);this.expressionButtons();target.draw.start({type,heightReference:'clamp-to-ground',groundOffset:.5,symbol:{color:'#64d8ff',occlusion:'overlay'}});this.status.textContent='左键落点；右键旋转、中键俯仰、滚轮缩放；Enter完成，Esc取消。';}});
    add('entities','绘图对象管理',toolbarIcons.entities,()=>{this.close();target.draw.cancel();options.onEntities?.();if(!options.onEntities)this.entityManager();});
    if(options.onLayers)add('layers','业务图层管理',toolbarIcons.layers,()=>{this.close();target.draw.cancel();options.onLayers!();});
    this.cleanup.push(target.measure.onChange(state=>{if(this.mode!=='measure')return;this.status.textContent=`${state.active?'测量中':'完成或取消'} · ${state.vertexCount} 顶点${state.error?' · '+state.error:''}`;let pre=this.content.querySelector('pre');if(!pre){pre=doc.createElement('pre');this.content.append(pre);}pre.textContent=JSON.stringify(state.result,null,2);}),
      target.draw.onChange(state=>{for(const [id,b] of this.buttons)b.setAttribute('aria-pressed',String(state.active&&id===`draw-${state.type}`));if(this.mode==='draw')this.status.textContent=state.error??`${state.active?'绘制中':'绘制结束'} · ${state.vertexCount} 顶点`;}));
    canvas.addEventListener('pointerdown',e=>{if(this.inspecting&&e.button===0)this.pointer={x:e.clientX,y:e.clientY,id:e.pointerId};},{signal:this.events.signal});
    canvas.addEventListener('pointercancel',()=>{this.pointer=null;},{signal:this.events.signal});
    canvas.addEventListener('pointerup',e=>{const p=this.pointer;this.pointer=null;if(!this.inspecting||!p||e.pointerId!==p.id||Math.hypot(p.x-e.clientX,p.y-e.clientY)>4)return;
      const r=canvas.getBoundingClientRect();try{const result=target.inspectAt({x:e.clientX-r.left,y:e.clientY-r.top});this.content.replaceChildren();const pre=doc.createElement('pre');pre.textContent=JSON.stringify(result,null,2);this.content.append(pre);this.status.textContent=result.surface||result.entity?'查询完成':'天空或未命中对象';}catch(error){this.status.textContent=String(error);}},{signal:this.events.signal});
  }
  close():void{this.managerUnsubscribe?.();this.managerUnsubscribe=null;this.inspecting=false;this.pointer=null;this.panel.hidden=true;if(this.mode==='measure')this.target.measure.cancel();if(this.mode==='draw')this.target.draw.cancel();this.mode=null;}
  destroy():void{if(this.destroyed)return;this.close();this.destroyed=true;this.events.abort();for(const fn of this.cleanup)fn();for(const {node,parent,next} of this.moved)if(parent)parent.insertBefore(node,next?.parentNode===parent?next:null);this.element.remove();this.panel.remove();this.style.remove();if(this.previousPosition!==null)this.host.style.position=this.previousPosition;}
  private beginInteraction():void{this.target.measure.cancel();this.target.draw.cancel();this.inspecting=false;}
  private open(mode:string,title:string):void{this.close();this.options.onPanelOpen?.();this.mode=mode;this.title.textContent=title;this.content.replaceChildren();this.status.textContent='';this.panel.hidden=false;}
  private mount(node:HTMLElement):void{if(!this.moved.some(v=>v.node===node))this.moved.push({node,parent:node.parentNode,next:node.nextSibling});this.content.append(node);}
  private baseMaps():void{this.open('basemap','底图切换');if(this.options.basemapContent){this.mount(this.options.basemapContent);return;}
    const select=this.panel.ownerDocument.createElement('select');select.setAttribute('aria-label','底图');select.append(new Option('无底图',''));for(const map of this.target.getBaseMaps())select.append(new Option(this.options.baseMapNames?.[map.id]??map.id,map.id));select.value=this.target.baseMap.id??'';
    select.addEventListener('change',async()=>{select.disabled=true;try{await this.target.setBaseMap(select.value||null);this.status.textContent='底图配置已切换，瓦片继续加载。';}catch{select.value=this.target.baseMap.id??'';this.status.textContent='切换失败，保留原底图。';}finally{select.disabled=false;}},{signal:this.events.signal});this.content.append(select);}
  private offset():void{this.open('offset','瓦片层级偏移');if(this.options.offsetContent){this.mount(this.options.offsetContent);return;}const input=this.panel.ownerDocument.createElement('input');input.type='range';input.min='-4';input.max='1';input.step='.1';input.value=String(this.target.tileLevelOffset??-1.7);const value=this.panel.ownerDocument.createElement('output');value.textContent=input.value;
    input.addEventListener('input',()=>{try{this.target.setTileLevelOffset(Number(input.value));value.textContent=input.value;}catch(error){this.status.textContent=String(error);}},{signal:this.events.signal});this.content.append(input,value);}
  private expressionButtons():void{for(const [name,action] of [['完成（Enter）',()=>this.target.draw.finish()],['撤销顶点',()=>this.target.draw.undo()],['取消（Esc）',()=>this.target.draw.cancel()]] as const){const b=this.panel.ownerDocument.createElement('button');b.textContent=name;b.addEventListener('click',()=>{try{action();}catch(error){this.status.textContent=String(error);}},{signal:this.events.signal});this.content.append(b);}}
  private measure(kind:'distance'|'area'):void{this.beginInteraction();this.open('measure',kind==='distance'?'路程测量（WGS84）':'面积测量（WGS84）');this.expressionButtons();const clear=this.panel.ownerDocument.createElement('button');clear.textContent='清除测量';clear.addEventListener('click',()=>this.target.measure.clear(),{signal:this.events.signal});this.content.append(clear);this.target.measure.start(kind);}
  private terrainState():void{const b=this.buttons.get('terrain');if(b){b.setAttribute('aria-pressed',String(this.target.terrainEnabled));b.querySelector('img')!.src=this.target.terrainEnabled?toolbarIcons.terrainOn:toolbarIcons.terrainOff;}}
  private entityManager():void{
    this.open('entities','绘图对象管理');const doc=this.panel.ownerDocument,select=doc.createElement('select'),pre=doc.createElement('pre');select.setAttribute('aria-label','业务对象');
    const show=()=>{pre.textContent=JSON.stringify(this.target.entities.getById(select.value)??null,null,2);};
    const refresh=()=>{const id=select.value;select.replaceChildren();for(const value of this.target.entities.values)select.append(new Option(`${value.visible?'●':'○'} ${value.id}`,value.id));if(this.target.entities.has(id))select.value=id;show();};
    select.addEventListener('change',show,{signal:this.events.signal});this.content.append(select);
    for(const [name,action] of [['显隐',()=>{const value=this.target.entities.getById(select.value);if(value)this.target.entities.setVisibleById(value.id,!value.visible);}],['删除',()=>this.target.entities.remove(select.value)]] as const){const b=doc.createElement('button');b.textContent=name;b.addEventListener('click',action,{signal:this.events.signal});this.content.append(b);}
    this.content.append(pre);refresh();this.managerUnsubscribe=this.target.entities.onChange(()=>{if(this.mode==='entities')refresh();});
  }
}
