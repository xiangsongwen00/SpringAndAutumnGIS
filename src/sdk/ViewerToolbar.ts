import type { GlobeEngine } from '../engine/GlobeEngine';
import type { EntityDrawingController } from './EntityDrawingController';
import type { MeasurementController,MeasurementKind } from './Measurement';
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
  /** CSS pixels above the container bottom; default 48 plus safe-area inset. */
  bottomOffset?:number;
  /** Existing drawing/style/management form mounted inside the drawing popup. */
  drawContent?:HTMLElement;
  /** Optional existing source-demo form controls are moved, not cloned. */
  basemapContent?:HTMLElement;offsetContent?:HTMLElement;
  onDraw?:(type:EntityDefinition['type'],options:{clearPrevious:boolean})=>void;onPanelOpen?:()=>void;
  baseMapNames?:Readonly<Record<string,string>>};

const css=`
.sag-tools{position:absolute;left:12px;bottom:calc(var(--sag-toolbar-bottom,48px) + env(safe-area-inset-bottom,0px));display:flex;flex-direction:column;gap:3px;z-index:30;max-height:calc(100% - 80px);overflow:auto;padding:5px;border:1px solid #336477;border-radius:10px;background:#071d29eb;pointer-events:auto}
.sag-tools button{width:36px;height:34px;padding:5px;border:0;border-radius:5px;background:transparent;color:white;cursor:pointer;flex-shrink:0}
.sag-tools img{width:25px;height:25px;object-fit:contain}.sag-tools button:hover,.sag-tools button[aria-pressed=true]{background:#37758c}.sag-tools button:focus-visible{outline:2px solid #64d8ff}
.sag-tool-panel{position:absolute;right:12px;top:56px;z-index:40;width:min(330px,calc(100% - 76px));max-height:calc(100% - 90px);overflow:auto;box-sizing:border-box;padding:14px;background:#071d29f5;border:1px solid #336477;border-radius:10px;color:#dcf7ff;font:13px/1.6 sans-serif;pointer-events:auto}
.sag-tool-panel[hidden]{display:none}.sag-tool-panel button,.sag-tool-panel select,.sag-tool-panel input{font:inherit;margin:4px;padding:5px;border-radius:5px;max-width:100%;color:#dcf7ff;background:#133342;border:1px solid #336477}
.sag-tool-panel--compact{left:62px;right:auto;top:auto;bottom:calc(var(--sag-toolbar-bottom,48px) + env(safe-area-inset-bottom,0px));width:min(300px,calc(100% - 74px));max-height:calc(100% - 80px)}
.sag-tool-panel textarea{box-sizing:border-box;width:100%;min-height:90px;background:#133342;color:#dcf7ff}.sag-tool-panel .entity-panel{position:static;display:block;width:100%;max-height:none;border:0;padding:0;background:transparent}.sag-tool-panel .entity-panel[hidden]{display:none}
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
  private clearDrawingHistory=false;
  private clearMeasurementHistory=false;
  private previousPosition:string|null=null;
  private readonly host:HTMLElement;
  private readonly moved:{node:HTMLElement;parent:Node|null;next:Node|null}[]=[];
  constructor(private readonly target:ToolbarTarget,private readonly options:ViewerToolbarOptions={}){
    if(options.bottomOffset!==undefined&&(!Number.isFinite(options.bottomOffset)||options.bottomOffset<0))throw new Error('Invalid toolbar bottomOffset');
    const canvas=target.engine.renderer.domElement,doc=canvas.ownerDocument;
    this.host=options.container??canvas.parentElement!;
    if(doc.defaultView!.getComputedStyle(this.host).position==='static'){this.previousPosition=this.host.style.position;this.host.style.position='relative';}
    this.style=doc.createElement('style');this.style.textContent=css;this.host.append(this.style);
    this.element=doc.createElement('nav');this.element.className='sag-tools';this.element.setAttribute('aria-label','地图工具栏');
    this.panel=doc.createElement('aside');this.panel.className='sag-tool-panel';this.panel.hidden=true;
    if(options.bottomOffset!==undefined)for(const node of [this.element,this.panel])node.style.setProperty('--sag-toolbar-bottom',`${options.bottomOffset}px`);
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
    add('measure','测量／点查询',toolbarIcons.distance,()=>this.measureModule());
    add('draw','绘制点线面',toolbarIcons.polygon,()=>this.drawModule());
    if(options.onLayers)add('layers','业务图层管理',toolbarIcons.layers,()=>{this.close();target.draw.cancel();options.onLayers!();});
    this.cleanup.push(target.measure.onChange(state=>{if(this.mode!=='measure')return;this.status.textContent=`${state.active?'测量中':'完成或取消'} · ${state.vertexCount} 顶点${state.error?' · '+state.error:''}`;let pre=this.content.querySelector('pre');if(!pre){pre=doc.createElement('pre');this.content.append(pre);}pre.textContent=JSON.stringify(state.result,null,2);}),
      target.draw.onChange(state=>{if(state.lastEntityId&&target.entities.has(state.lastEntityId))target.entities.selectById(state.lastEntityId);this.buttons.get('draw')?.setAttribute('aria-pressed',String(this.mode==='draw'&&state.active));if(this.mode==='draw')this.status.textContent=state.error??`${state.active?'绘制中':'绘制结束'} · ${state.vertexCount} 顶点`;}));
    canvas.addEventListener('pointerdown',e=>{if(this.inspecting&&e.button===0)this.pointer={x:e.clientX,y:e.clientY,id:e.pointerId};},{signal:this.events.signal});
    canvas.addEventListener('pointercancel',()=>{this.pointer=null;},{signal:this.events.signal});
    canvas.addEventListener('pointerup',e=>{const p=this.pointer;this.pointer=null;if(!this.inspecting||!p||e.pointerId!==p.id||Math.hypot(p.x-e.clientX,p.y-e.clientY)>4)return;
      const r=canvas.getBoundingClientRect();try{const result=target.inspectAt({x:e.clientX-r.left,y:e.clientY-r.top});const pre=this.content.querySelector('pre');if(pre)pre.textContent=JSON.stringify(result,null,2);this.status.textContent=result.surface||result.entity?'查询完成，可继续点击':'天空或未命中对象';}catch(error){this.status.textContent=String(error);}},{signal:this.events.signal});
    canvas.ownerDocument.addEventListener('keydown',e=>{if(e.key==='Escape'&&this.inspecting)this.endInteraction();},{signal:this.events.signal});
  }
  close():void{this.managerUnsubscribe?.();this.managerUnsubscribe=null;this.inspecting=false;this.pointer=null;this.panel.hidden=true;if(this.mode==='measure')this.target.measure.cancel();if(this.mode==='draw')this.target.draw.cancel();this.mode=null;
    const mounted=this.moved.find(v=>v.node===this.options.drawContent);if(mounted){mounted.node.hidden=true;if(mounted.parent)mounted.parent.insertBefore(mounted.node,mounted.next?.parentNode===mounted.parent?mounted.next:null);}}
  destroy():void{if(this.destroyed)return;this.close();this.destroyed=true;this.events.abort();for(const fn of this.cleanup)fn();for(const {node,parent,next} of this.moved)if(parent)parent.insertBefore(node,next?.parentNode===parent?next:null);this.element.remove();this.panel.remove();this.style.remove();if(this.previousPosition!==null)this.host.style.position=this.previousPosition;}
  private beginInteraction():void{this.target.measure.cancel();this.target.draw.cancel();this.inspecting=false;}
  private open(mode:string,title:string):void{this.close();this.options.onPanelOpen?.();this.mode=mode;this.title.textContent=title;this.content.replaceChildren();this.status.textContent='';this.panel.classList.toggle('sag-tool-panel--compact',mode==='basemap'||mode==='offset');this.panel.hidden=false;}
  private mount(node:HTMLElement):void{if(!this.moved.some(v=>v.node===node))this.moved.push({node,parent:node.parentNode,next:node.nextSibling});this.content.append(node);}
  private baseMaps():void{this.open('basemap','底图切换');if(this.options.basemapContent){this.mount(this.options.basemapContent);return;}
    const select=this.panel.ownerDocument.createElement('select');select.setAttribute('aria-label','底图');select.append(new Option('无底图',''));for(const map of this.target.getBaseMaps())select.append(new Option(this.options.baseMapNames?.[map.id]??map.id,map.id));select.value=this.target.baseMap.id??'';
    select.addEventListener('change',async()=>{select.disabled=true;try{await this.target.setBaseMap(select.value||null);this.status.textContent='底图配置已切换，瓦片继续加载。';}catch{select.value=this.target.baseMap.id??'';this.status.textContent='切换失败，保留原底图。';}finally{select.disabled=false;}},{signal:this.events.signal});this.content.append(select);}
  private offset():void{this.open('offset','瓦片层级偏移');if(this.options.offsetContent){this.mount(this.options.offsetContent);return;}const input=this.panel.ownerDocument.createElement('input');input.type='range';input.min='-4';input.max='1';input.step='.1';input.value=String(this.target.tileLevelOffset??-1.7);const value=this.panel.ownerDocument.createElement('output');value.textContent=input.value;
    input.addEventListener('input',()=>{try{this.target.setTileLevelOffset(Number(input.value));value.textContent=input.value;}catch(error){this.status.textContent=String(error);}},{signal:this.events.signal});this.content.append(input,value);}
  /** Programmatic end is equivalent to the point-mode Finish button; popup stays open. */
  endInteraction():void{this.target.measure.stop();this.target.draw.stop();this.inspecting=false;this.status.textContent='操作已结束，可选择模式重新开始。';}
  private expressionButtons():void{for(const [name,action] of [['完成／结束（Enter）',()=>{
    if(!this.inspecting&&!this.target.draw.isActive){this.status.textContent='当前未开始，请点击开始按钮。';return;}
    if(this.inspecting||this.target.draw.state.type==='point'||this.target.draw.state.type==='label')this.endInteraction();else this.target.draw.finish();
  }],['撤销顶点',()=>this.target.draw.undo()],['取消（Esc）',()=>{this.target.measure.cancel();this.target.draw.cancel();this.inspecting=false;}]] as const){const b=this.panel.ownerDocument.createElement('button');b.textContent=name;b.addEventListener('click',()=>{try{action();}catch(error){this.status.textContent=String(error);}},{signal:this.events.signal});this.content.append(b);}}
  private selector(label:string,entries:readonly (readonly [string,string])[],change:(value:string)=>void):HTMLSelectElement{
    const doc=this.panel.ownerDocument,wrap=doc.createElement('label'),select=doc.createElement('select');wrap.textContent=label;select.setAttribute('aria-label',label);for(const [value,name] of entries)select.append(new Option(name,value));select.addEventListener('change',()=>{try{change(select.value);}catch(error){this.status.textContent=String(error);}},{signal:this.events.signal});wrap.append(select);this.content.append(wrap);return select;
  }
  private drawModule():void{
    this.beginInteraction();this.open('draw','绘制');const start=(value:string)=>{this.beginInteraction();const type=value as EntityDefinition['type'];
      if(this.options.onDraw)this.options.onDraw(type,{clearPrevious:this.clearDrawingHistory});else this.target.draw.start({type,continuous:true,clearPrevious:this.clearDrawingHistory});
      this.status.textContent='点可连续标记；线面双击或Enter完成。右/中键及滚轮可导航，关闭弹窗退出。';};
    const editor=this.panel.ownerDocument.createElement('div');
    const select=this.selector('绘制类型',[['point','标记点'],['polyline','折线'],['polygon','面'],['label','标注']],value=>{this.beginInteraction();const custom=this.options.drawContent?.querySelector<HTMLSelectElement>('[data-draw-type]');if(custom){custom.value=value;custom.dispatchEvent(new Event('change'));}renderEditor();this.status.textContent='类型已选择，点击“开始绘制”。';});
    this.historyCheckbox('draw');this.startButton('draw',()=>start(this.options.drawContent?.querySelector<HTMLSelectElement>('[data-draw-type]')?.value??select.value));this.expressionButtons();this.status.textContent='请选择类型和历史设置，再点击“开始绘制”。';
    if(this.options.drawContent?.querySelector('[data-draw-type]'))select.parentElement!.hidden=true;
    const renderEditor=()=>{editor.replaceChildren();if(this.options.drawContent){this.mount(this.options.drawContent);this.options.drawContent.hidden=false;return;}this.styleEditor(editor,select.value as EntityDefinition['type']);};
    this.content.append(editor);renderEditor();
    if(!this.options.drawContent)this.entityManager();
  }
  private measureModule():void{
    this.beginInteraction();this.open('measure','测量／查询');const pre=this.panel.ownerDocument.createElement('pre');const start=(value:string)=>{
      this.beginInteraction();pre.textContent='';if(value==='inspect'){this.inspecting=true;this.status.textContent='连续点击查询坐标和对象属性；结束或关闭退出。';}
      else{this.target.measure.start(value as MeasurementKind,{clearPrevious:this.clearMeasurementHistory});this.status.textContent='点可连续拾取；线面双击或Enter完成。数值为WGS84椭球测量。';}};
    const select=this.selector('测量类型',[['point','点坐标／高程'],['distance','折线路程'],['area','面积'],['inspect','点对象属性查询']],()=>{this.beginInteraction();pre.textContent='';this.status.textContent='类型已选择，点击“开始测量”。';});
    this.historyCheckbox('measure');this.startButton('measure',()=>start(select.value));this.expressionButtons();
    const clear=this.panel.ownerDocument.createElement('button');clear.textContent='清除测量';clear.addEventListener('click',()=>this.target.measure.clear(),{signal:this.events.signal});this.content.append(clear,pre);this.status.textContent='请选择类型和历史设置，再点击“开始测量”。';
  }
  private startButton(mode:'draw'|'measure',start:()=>void):void{
    const button=this.panel.ownerDocument.createElement('button');button.type='button';button.textContent=mode==='draw'?'开始绘制':'开始测量';button.dataset.action=`start-${mode}`;
    button.addEventListener('click',()=>{try{start();}catch(error){this.status.textContent=error instanceof Error?error.message:String(error);}},{signal:this.events.signal});this.content.append(button);
  }
  private historyCheckbox(mode:'draw'|'measure'):void{
    const doc=this.panel.ownerDocument,label=doc.createElement('label'),input=doc.createElement('input');input.type='checkbox';input.dataset.action=`clear-${mode}-history`;
    input.checked=mode==='draw'?this.clearDrawingHistory:this.clearMeasurementHistory;
    input.addEventListener('change',()=>{if(mode==='draw')this.clearDrawingHistory=input.checked;else this.clearMeasurementHistory=input.checked;},{signal:this.events.signal});
    label.append(input,doc.createTextNode(`新对象提交后清除历史${mode==='draw'?'绘制':'测量'}对象（开始时生效）`));this.content.append(label);
  }
  private terrainState():void{const b=this.buttons.get('terrain');if(b){b.setAttribute('aria-pressed',String(this.target.terrainEnabled));b.querySelector('img')!.src=this.target.terrainEnabled?toolbarIcons.terrainOn:toolbarIcons.terrainOff;}}
  private entityManager():void{
    const doc=this.panel.ownerDocument,heading=doc.createElement('h4'),select=doc.createElement('select'),pre=doc.createElement('pre');heading.textContent='绘图对象管理';select.setAttribute('aria-label','业务对象');
    const show=()=>{pre.textContent=JSON.stringify(this.target.entities.getById(select.value)??null,null,2);};
    const refresh=()=>{const id=this.target.entities.selectedId??'';select.replaceChildren(new Option('按ID选择对象',''));for(const value of this.target.entities.values)select.append(new Option(`${value.visible?'●':'○'} ${value.id}`,value.id));if(this.target.entities.has(id))select.value=id;show();};
    select.addEventListener('change',()=>{this.target.entities.selectById(select.value||null);show();},{signal:this.events.signal});this.content.append(heading,select);
    for(const [name,action] of [['应用当前绘制样式到选中对象',()=>{const value=this.target.entities.getById(select.value);if(value){const style=this.target.draw.getStyle(value.type);this.target.entities.update(value.id,style);}}],['显隐',()=>{const value=this.target.entities.getById(select.value);if(value)this.target.entities.setVisibleById(value.id,!value.visible);}],['删除',()=>this.target.entities.remove(select.value)]] as const){const b=doc.createElement('button');b.textContent=name;b.addEventListener('click',()=>{try{action();}catch(error){this.status.textContent=String(error);}},{signal:this.events.signal});this.content.append(b);}
    this.content.append(pre);refresh();this.managerUnsubscribe=this.target.entities.onChange(()=>{if(this.mode==='draw')refresh();});
    if(this.options.onEntities){const custom=doc.createElement('button');custom.textContent='打开应用对象管理';custom.addEventListener('click',()=>this.options.onEntities!(),{signal:this.events.signal});this.content.append(custom);}
  }
  private styleEditor(host:HTMLElement,type:EntityDefinition['type']):void{
    const doc=host.ownerDocument,style=this.target.draw.getStyle(type);
    if(!Object.keys(style).length)this.target.draw.setStyle(type,{heightReference:type==='point'||type==='label'?'absolute':'clamp-to-ground',groundOffset:.5,
      ...(type==='label'?{label:{text:'标注',occlusion:'overlay' as const}}:{symbol:{color:'#ffffff',occlusion:type==='point'?'overlay' as const:'depth' as const,...(type==='point'?{size:30,icon:{url:toolbarIcons.point,sourceHeading:0},alignment:'screen' as const}:type==='polyline'?{width:4}:{opacity:.5})}})});
    const current=this.target.draw.getStyle(type),symbol=current.symbol;
    const controls=new Map<string,HTMLInputElement>();
    const input=(name:string,title:string,value:string,kind='text')=>{const label=doc.createElement('label'),node=doc.createElement('input');label.textContent=title;node.type=kind;if(kind==='checkbox')node.checked=value==='true';else node.value=value;node.dataset.style=name;label.append(node);host.append(label);controls.set(name,node);return node;};
    input('color','符号颜色',symbol?.color??current.label?.color??'#ffffff','color');input('opacity','透明度',String(symbol?.opacity??current.label?.opacity??1),'number');
    if(type==='point'){const s=symbol as import('./EntityTypes').PointSymbol|undefined;input('image','使用点图标',String(!!s?.icon),'checkbox');input('url','图标URL',s?.icon?.url??'');input('size','点大小 / CSS像素',String(s?.size??36),'number');input('heading','朝向 / 度',String(s?.heading??0),'number');input('sourceHeading','素材原始朝向 / 度',String(s?.icon?.sourceHeading??0),'number');}
    else if(type==='polyline'||type==='polygon'){const texture=(symbol as import('./EntityTypes').LineSymbol|import('./EntityTypes').PolygonSymbol|undefined)?.texture;input('image','使用纹理',String(!!texture),'checkbox');input('url','纹理URL',texture?.url??'');
      if(type==='polyline'){const s=symbol as import('./EntityTypes').LineSymbol|undefined;input('width','线宽 / CSS像素',String(s?.width??4),'number');input('speed','流动速度 / CSS像素每秒',String(s?.texture?.speed??30),'number');}
    }
    const json=doc.createElement('textarea');json.setAttribute('aria-label','绘制样式JSON');json.value=JSON.stringify(current,null,2);const advanced=doc.createElement('details'),summary=doc.createElement('summary');summary.textContent='完整样式JSON（面UV、速度、注记等）';advanced.append(summary,json);host.append(advanced);
    const apply=doc.createElement('button');apply.textContent='应用样式JSON';apply.addEventListener('click',()=>{try{this.target.draw.setStyle(type,JSON.parse(json.value));this.styleEditorRefresh(host,type);this.status.textContent='当前会话与后续绘制已更新，已有对象不自动改变。';}catch(error){this.status.textContent=String(error);}},{signal:this.events.signal});advanced.append(apply);
    const changed=()=>{try{const value=(name:string)=>controls.get(name)!.value,number=(name:string)=>Number(value(name));const common={color:value('color'),opacity:number('opacity')},previous=this.target.draw.getStyle(type);
      const next=type==='point'?{symbol:{...common,size:number('size'),heading:number('heading'),icon:controls.get('image')!.checked?{...(previous.symbol as import('./EntityTypes').PointSymbol)?.icon,url:value('url'),sourceHeading:number('sourceHeading')}:null}}:
        type==='polyline'?{symbol:{...common,width:number('width'),texture:controls.get('image')!.checked?{...(previous.symbol as import('./EntityTypes').LineSymbol)?.texture,url:value('url'),speed:number('speed')}:null}}:
        type==='polygon'?{symbol:{...common,texture:controls.get('image')!.checked?{...(previous.symbol as import('./EntityTypes').PolygonSymbol)?.texture,url:value('url')}:null}}:{label:{...previous.label!,...common}};
      json.value=JSON.stringify(this.target.draw.setStyle(type,next),null,2);this.status.textContent='绘制样式已生效；修改已有对象请点击应用到选中对象。';
    }catch(error){this.status.textContent=String(error);}};
    for(const node of controls.values())node.addEventListener('change',changed,{signal:this.events.signal});
  }
  private styleEditorRefresh(host:HTMLElement,type:EntityDefinition['type']):void{host.replaceChildren();this.styleEditor(host,type);}
}
