import * as THREE from 'three';
import { EntityCollection, EntityError, EntityLayer, EntityDrawingController, type GlobeEngine, type EntityDefinition, type EntityPatch,
  type EntityPosition, type EntityQuery, type PointSymbol, type LineSymbol, type PolygonSymbol } from '../index';

/** Source-demo adapter: one engine, one independent entity overlay, no SDK consumer iframe. */
export function attachEntityPlayground(engine: GlobeEngine): () => void {
  const entities = new EntityCollection(), layer = new EntityLayer(engine.ellipsoid, entities);
  const layerId = '__demo_entities'; engine.addSceneLayer(layerId, layer);
  const draw=new EntityDrawingController(engine,entities,'__demo_draw_preview');
  const events = new AbortController(); let serial = 0, disposed = false;
  const el = <T extends HTMLElement>(id: string): T => {
    const value = document.getElementById(id); if (!value) throw new Error(`Missing entity control: ${id}`); return value as T;
  };
  const input = (id: string) => el<HTMLInputElement>(`entity-${id}`);
  const select = (id: string) => el<HTMLSelectElement>(`entity-${id}`);
  const area = (id: string) => el<HTMLTextAreaElement>(`entity-${id}`);
  const panel = el('entity-panel'), toggle = el<HTMLButtonElement>('entity-test');
  const message = (text: string, error = false) => { const target=el('entity-message');target.textContent=text;target.dataset.status=error?'error':'ready'; };
  const number = (id: string, min=-Infinity, max=Infinity): number => {
    const raw=input(id).value, value=Number(raw);if(!raw.trim()||!Number.isFinite(value)||value<min||value>max)throw new Error(`${id} 数值无效。`);return value;
  };
  const position = (): EntityPosition => [number('lon',-180,180),number('lat',-90,90),number('height',-10000,10000000)];
  const selected = (): EntityDefinition => {const value=entities.getById(select('select').value);if(!value)throw new Error('请先选中一个对象。');return value;};
  const updateResource = (): void => {
    if(disposed||panel.hidden)return;
    const id=select('select').value,state=id?layer.getResourceState(id):null;
    el('entity-resource').textContent=`${entities.length} 个对象 · 集合${entities.visible?'显示':'隐藏'}${state?` · 符号资源 ${state.state} (${state.images} 图片)`:''}`;
  };
  const refresh = (): void => {
    if(disposed)return;const target=select('select'),previous=target.value;
    target.replaceChildren(new Option(`对象 ${entities.length} 个 · 请选择`,''));
    for(const value of entities.values)target.add(new Option(`${value.visible?'●':'○'} ${value.id} · ${value.type}`,value.id));
    target.value=entities.has(previous)?previous:'';input('all-visible').checked=entities.visible;
    el('entity-output').textContent=target.value?JSON.stringify(entities.getById(target.value),null,2):`集合 ${entities.length} 个对象`;
    updateResource();
  };
  const open = (shown: boolean): void => {
    if(!shown)draw.cancel();
    panel.hidden=!shown;toggle.setAttribute('aria-expanded',String(shown));document.body.classList.toggle('entity-panel-open',shown);
    if(shown){el('business-layer-panel').hidden=true;el('business-layer-control').setAttribute('aria-expanded','false');updateResource();}
  };
  const bind = (id: string, action: () => void, event='click'): void => {
    el(id).addEventListener(event,()=>{try{action();message(`${el(id).textContent?.trim()||id}：完成`);updateResource();}
      catch(error){message(error instanceof EntityError?`${error.code}: ${error.message}`:error instanceof Error?error.message:'操作失败',true);}}, {signal:events.signal});
  };
  const color = (value: string | undefined, fallback: string): string => `#${new THREE.Color(value??fallback).getHexString()}`;
  const loadForm = (): void => {
    const value=selected(),p='position' in value?value.position:value.positions[0]!;
    select('type').value=value.type;input('id').value=value.id;input('name').value=value.name??'';
    input('lon').value=String(p[0]);input('lat').value=String(p[1]);input('height').value=String(p[2]??30);
    const s=value.type==='label'?undefined:value.symbol;
    input('color').value=color(value.type==='label'?value.label.color:s?.color,'#ffffff');
    input('outline').value=color(value.type==='point'||value.type==='polygon'?value.symbol?.outlineColor:value.label?.haloColor,'#173342');
    input('opacity').value=String(s?.opacity??value.label?.opacity??1);
    input('size').value=String(value.type==='point'?value.symbol?.size??36:36);
    input('width').value=String(value.type==='polyline'?value.symbol?.width??3:value.type==='point'||value.type==='polygon'?value.symbol?.outlineWidth??2:2);
    select('shape').value=value.type==='point'?value.symbol?.shape??'circle':'circle';
    input('fill').checked=value.type==='polygon'?value.symbol?.fill!==false:true;
    input('text').value=value.label?.text??'';input('font').value=String(value.label?.fontSize??16);
    select('occlusion').value=(value.type==='label'?value.label.occlusion:value.symbol?.occlusion??value.label?.occlusion)??'depth';
    const icon=value.type==='point'?value.symbol?.icon:undefined;
    input('icon-enabled').checked=!!icon;input('icon-url').value=icon?.url??'/mylocation_up.png';
    input('heading').value=String(value.type==='point'?value.symbol?.heading??0:0);input('source-heading').value=String(icon?.sourceHeading??0);
    select('alignment').value=value.type==='point'?value.symbol?.alignment??'map':'map';
    const pattern=value.type==='polyline'||value.type==='polygon'?value.symbol?.texture:undefined;
    input('texture-enabled').checked=!!pattern;input('texture-url').value=pattern?.url??'/Qianjin_left.png';
    if(value.type==='polyline'){input('line-period').value=String(value.symbol?.texture?.length??48);input('line-speed').value=String(value.symbol?.texture?.speed??30);select('line-direction').value=value.symbol?.texture?.sourceDirection??'left';}
    if(value.type==='polygon'){input('repeat-u').value=String(value.symbol?.texture?.repeat?.[0]??8);input('repeat-v').value=String(value.symbol?.texture?.repeat?.[1]??4);input('speed-u').value=String(value.symbol?.texture?.speed?.[0]??-0.15);input('speed-v').value=String(value.symbol?.texture?.speed?.[1]??0);input('texture-rotation').value=String(value.symbol?.texture?.rotation??0);}
    area('positions').value='positions' in value?JSON.stringify(value.positions):'';area('holes').value=value.type==='polygon'?JSON.stringify(value.holes??[]):'';area('properties').value=JSON.stringify(value.properties??{});
    el('entity-output').textContent=JSON.stringify(value,null,2);
  };
  function symbol(type:'point'):PointSymbol;
  function symbol(type:'polyline'):LineSymbol;
  function symbol(type:'polygon'):PolygonSymbol;
  function symbol(type:'point'|'polyline'|'polygon'):PointSymbol|LineSymbol|PolygonSymbol;
  function symbol(type:'point'|'polyline'|'polygon'):PointSymbol|LineSymbol|PolygonSymbol {
    const common={color:input('color').value,opacity:number('opacity',0,1),occlusion:select('occlusion').value as 'depth'|'overlay'},outlineColor=input('outline').value;
    if(type==='point')return {...common,outlineColor,outlineWidth:number('width',0,64),size:number('size',1,256),shape:select('shape').value as 'circle'|'square'|'diamond',
      occlusion:select('occlusion').value as 'depth'|'overlay',
      heading:number('heading'),alignment:select('alignment').value as 'map'|'screen',icon:input('icon-enabled').checked?{url:input('icon-url').value.trim(),sourceHeading:number('source-heading')}:null};
    if(type==='polyline')return {...common,width:number('width',0,64),texture:input('texture-enabled').checked?{url:input('texture-url').value.trim(),length:number('line-period',1,2048),speed:number('line-speed',-4096,4096),sourceDirection:select('line-direction').value as 'left'|'right'}:null};
    return {...common,outlineColor,outlineWidth:number('width',0,64),fill:input('fill').checked,texture:input('texture-enabled').checked?{url:input('texture-url').value.trim(),
      repeat:[number('repeat-u',0.01,256),number('repeat-v',0.01,256)],speed:[number('speed-u',-1000,1000),number('speed-v',-1000,1000)],rotation:number('texture-rotation')}:null};
  }
  const label = () => input('text').value?{text:input('text').value,fontSize:number('font',6,96),color:input('color').value,haloColor:input('outline').value,occlusion:select('occlusion').value as 'depth'|'overlay'}:undefined;
  const positions = (type:'polyline'|'polygon'): readonly EntityPosition[] => {
    if(area('positions').value.trim())return JSON.parse(area('positions').value);
    const [x,y,h]=position();return type==='polyline'?[[x-.02,y-.01,h],[x,y,h],[x+.02,y+.01,h]]:[[x-.02,y-.02,h],[x+.02,y-.02,h],[x+.02,y+.02,h],[x-.02,y+.02,h]];
  };
  const holes = (): readonly (readonly EntityPosition[])[] => area('holes').value.trim()?JSON.parse(area('holes').value):[];
  const properties = (): Record<string,unknown> => JSON.parse(area('properties').value.trim()||'{}');
  const focus = (value:EntityDefinition): void => {const p='position' in value?value.position:value.positions[0]!;engine.flyTo({longitude:p[0],latitude:p[1],altitude:Math.max(14000,(p[2]??30)+10000),pitch:-65,heading:0,duration:700});};
  const samples:EntityDefinition[]=[
    {id:'demo-point',type:'point',name:'人物定位',position:[106.55,29.61,1500],symbol:{color:'#ffffff',size:36,icon:{url:'/mylocation_up.png',sourceHeading:0},heading:0,alignment:'map'},label:{text:'人物定位',offset:[0,-36]},properties:{category:'station'}},
    {id:'demo-line',type:'polyline',name:'方向流动线',positions:[[106.52,29.60,1500],[106.55,29.61,1500],[106.59,29.62,1500]],symbol:{color:'#ffffff',width:24,texture:{url:'/Qianjin_left.png',length:48,speed:30,sourceDirection:'left'}},properties:{category:'route'}},
    {id:'demo-polygon',type:'polygon',name:'半透明纹理面（有洞）',positions:[[106.51,29.63,1500],[106.57,29.63,1500],[106.57,29.67,1500],[106.51,29.67,1500]],holes:[[[106.53,29.64,1500],[106.55,29.64,1500],[106.55,29.66,1500],[106.53,29.66,1500]]],symbol:{color:'#ffffff',opacity:.5,outlineColor:'#ffffff',outlineWidth:2,texture:{url:'/Qianjin_left.png',repeat:[8,4],speed:[-.15,0]}}},
    {id:'demo-label',type:'label',name:'独立标注',position:[106.58,29.65,1500],label:{text:'独立标注\n绝对高度1500m',fontSize:18,color:'#ffffff',backgroundColor:'#173342',offset:[0,0]}}
  ];
  const startDrawing=(type:EntityDefinition['type']):void=>{
    select('type').value=type;input('id').value='';if(type==='label'&&!input('text').value)input('text').value='标注';
    if(type==='polyline'||type==='polygon')select('occlusion').value='overlay';
    const mode=select('pick-mode').value as 'surface'|'ellipsoid'|'absolute-height';
    draw.start({type,name:input('name').value,properties:properties(),symbol:type==='label'?undefined:symbol(type),label:label(),pick:{mode,height:mode==='absolute-height'?number('height'):undefined}});open(true);
  };
  const unsubscribeDraw=draw.onChange(state=>{message(state.error??(state.active?`正在绘制 ${state.type} · ${state.vertexCount} 个顶点 · 完成/撤销/取消`:'绘制结束，相机操作已恢复'),!!state.error);
    if(state.lastEntityId&&entities.has(state.lastEntityId)){select('select').value=state.lastEntityId;loadForm();}});
  const addSamples = (type?:EntityDefinition['type']):void => {
    const items=samples.filter(value=>!type||value.type===type);for(const value of items){entities.remove(value.id);entities.add(value);}
    entities.setVisible(true);select('select').value=items[0]!.id;loadForm();focus(items[0]!);open(true);
  };
  const unsubscribe=entities.onChange(refresh);
  bind('entity-test',()=>{if(panel.hidden){open(true);if(!entities.length)addSamples();}else open(false);});
  bind('entity-close',()=>open(false));bind('entity-samples',()=>addSamples());
  bind('pick-debug',()=>{open(true);input('pick-diagnostics').checked=true;message('点击地表查看经纬度、高度、来源和回投误差；可勾选单击新增点。');});
  for(const type of ['point','polyline','polygon','label'] as const)bind(`entity-sample-${type==='polyline'?'line':type}`,()=>addSamples(type));
  bind('entity-select',loadForm,'change');
  bind('entity-add',()=>{
    const type=select('type').value,id=input('id').value.trim()||`user-${type}-${++serial}`,text=label(),common={id,name:input('name').value,label:text,properties:properties()};let value:EntityDefinition;
    if(type==='point')value={...common,type,position:position(),symbol:symbol(type)};
    else if(type==='polyline')value={...common,type,positions:positions(type),symbol:symbol(type)};
    else if(type==='polygon')value={...common,type,positions:positions(type),holes:holes(),symbol:symbol(type)};
    else{if(!text)throw new Error('独立标注必须填写文字。');value={...common,type:'label',position:position(),label:text};}
    entities.add(value);select('select').value=id;loadForm();
  });
  bind('entity-update',()=>{const current=selected(),patch:EntityPatch={name:input('name').value,properties:properties(),label:label()??null};
    if('position' in current)patch.position=position();else patch.positions=positions(current.type);
    if(current.type!=='label')patch.symbol=symbol(current.type);if(current.type==='polygon')patch.holes=holes();entities.update(current.id,patch);loadForm();});
  bind('entity-focus',()=>focus(selected()));bind('entity-toggle',()=>{const current=selected();entities.setVisibleById(current.id,!current.visible);});
  bind('entity-all-visible',()=>entities.setVisible(input('all-visible').checked),'change');
  bind('entity-remove',()=>{entities.remove(selected().id);input('id').value='';});bind('entity-clear',()=>{entities.clear();input('id').value='';});
  bind('entity-move',()=>{entities.move(selected().id,{longitude:number('dlon'),latitude:number('dlat'),height:number('dheight')});loadForm();});
  bind('entity-query',()=>{el('entity-output').textContent=JSON.stringify(entities.query(JSON.parse(area('query-json').value) as EntityQuery),null,2);});
  bind('entity-retry',()=>{layer.retryResources(selected().id);});
  bind('entity-draw-start',()=>startDrawing(select('type').value as EntityDefinition['type']));
  for(const type of ['point','polyline','polygon','label'] as const)bind(`entity-draw-${type==='polyline'?'line':type}`,()=>startDrawing(type));
  bind('entity-draw-finish',()=>{draw.finish();});bind('entity-draw-cancel',()=>draw.cancel());bind('entity-draw-undo',()=>{draw.undo();});
  for(const id of ['business-layer-control','business-layer-test','geojson-test'])el(id).addEventListener('click',()=>open(false),{signal:events.signal});
  let pointer:{x:number;y:number;id:number}|undefined;
  const canvas=engine.renderer.domElement;
  canvas.addEventListener('pointerdown',event=>{if(event.button===0)pointer={x:event.clientX,y:event.clientY,id:event.pointerId};},{signal:events.signal});
  canvas.addEventListener('pointercancel',()=>{pointer=undefined;},{signal:events.signal});
  canvas.addEventListener('pointerup',event=>{
    const start=pointer;pointer=undefined;if(!start||start.id!==event.pointerId||Math.hypot(start.x-event.clientX,start.y-event.clientY)>4||panel.hidden)return;
    try{
      const rect=canvas.getBoundingClientRect(),screen={x:event.clientX-rect.left,y:event.clientY-rect.top};engine.camera.updateMatrixWorld();
      const mode=select('pick-mode').value as 'surface'|'ellipsoid'|'absolute-height';
      const picked=engine.pickPositionDetailed(screen,{mode,height:mode==='absolute-height'?number('height'):undefined});
      const reference=engine.pickPositionDetailed(screen,{mode:'ellipsoid'});
      const ground=mode==='surface'?picked:engine.pickPositionDetailed(screen);
      const hit=layer.pick(screen,engine.camera,{},ground?.source==='rendered-surface'?ground.viewDepth:null);
      if(hit){select('select').value=hit.id;loadForm();message(`选中 ${hit.id}`);}
      else if(input('click-add').checked&&picked){const p=picked.position;input('lon').value=String(p.longitude);input('lat').value=String(p.latitude);input('height').value=String(p.height);input('id').value='';select('type').value='point';el('entity-add').click();}
      if(input('pick-diagnostics').checked)el('entity-output').textContent=JSON.stringify({picked,referenceEllipsoid:reference?.position??null,selectedObject:hit?.id??null,
        differenceMeters:picked&&reference?engine.coordinates.geodeticToWorld(picked.position).distanceTo(engine.coordinates.geodeticToWorld(reference.position)):null},null,2);
      if(!picked)message('此像素无地表交点（天空／画布外）。');else if(!hit)message(`来源 ${picked.source} · 回投误差 ${picked.errorPixels.toFixed(5)} px · 高度 ${picked.position.height.toFixed(2)}m`);
    }catch(error){message(error instanceof Error?error.message:'拾取失败',true);}
  },{signal:events.signal});
  const observer=new ResizeObserver(()=>{const bottom=el('map-controls-anchor').getBoundingClientRect().bottom+12;document.documentElement.style.setProperty('--map-controls-bottom',`${bottom}px`);});
  observer.observe(el('map-controls-anchor'));
  const timer=window.setInterval(updateResource,500);refresh();
  // Explicit local-only browser regression hook. Absent in normal URLs.
  if(new URLSearchParams(location.search).get('entitySmoke')==='1'){
    (window as Window & {__entityDemo?:unknown}).__entityDemo={entities,layer,engine,draw};
    el('entity-message').dataset.smoke='ready';
  }
  return ()=>{if(disposed)return;draw.dispose();disposed=true;events.abort();unsubscribe();unsubscribeDraw();clearInterval(timer);observer.disconnect();engine.removeSceneLayer(layerId);entities.dispose();document.body.classList.remove('entity-panel-open');};
}
