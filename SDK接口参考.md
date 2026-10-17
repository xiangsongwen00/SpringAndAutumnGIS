# SpringAndAutumnGIS SDK 接口参考

版本：0.1.0 / 2026-10-11。面向 TypeScript 与 JavaScript ES Modules 的应用开发者。

本文按“类 → 构造/创建 → 属性 → 方法 → 参数类型 → 示例 → 限制”组织，不是 Cesium 的兼容实现。所有签名以安装包 `dist/index.d.ts` 及其引用的 `.d.ts` 为准；带 `private` 的成员不属于调用约定。安装、部署和资源配置流程见 [SDK使用说明](SDK使用说明.md)。

## 目录与能力状态

| 入口 | 用途 | 当前状态 |
| --- | --- | --- |
| [Viewer](#1-viewer创建与初始化) | 创建地图、底图、相机、工具栏、生命周期 | 公共入口 |
| [EntityCollection](#4-entitycollection对象管理与id选择) | 点线面/标注的 ID、CRUD、查询与选中 | 公共入口，局部几何规模限制 |
| [符号](#5-点线面与标注符号) | 图片点、宽线、纹理面、动画与文字 | 业务实体可用；不是完整制图符号标准 |
| [EntityDrawingController](#6-entitydrawingcontroller鼠标绘制与全局样式) | 鼠标绘制、默认样式、预览、结束和历史 | 公共入口 |
| [MeasurementController](#7-测量) | 坐标、椭球距离和面积 | 不等于沿地形距离/山坡面积 |
| [拾取与坐标](#8-拾取高程与坐标转换) | 显示地表拾取、坐标变换 | 公共入口，必须检查来源与覆盖 |
| [地形](#9-地形服务与独立lod配置) | DEM、地形开关与独立误差选择 | 初版独立 LOD；完整山地交接仍待收尾 |
| [业务图层与 MVT](#10-业务图层与实验性矢量瓦片) | 栅格/GeoJSON/MVT | MVT 与地图注记明确为实验性 |

经纬度均为 **WGS84 度**，高度/距离为米，屏幕位置及符号大小为 CSS 像素，时间为毫秒；UV 动画速度另有单位。不能直接把 GCJ-02、BD-09 或 EPSG:3857 米坐标当作经纬度输入。

## 1. Viewer：创建与初始化

```ts
import { Viewer, TerrainRgbProvider } from 'spring-and-autumn-gis';
import type { ViewerOptions } from 'spring-and-autumn-gis'; // JS 中省略此行

const options: ViewerOptions = {
  basemaps: [{ id:'satellite', type:'xyz', scheme:'xyz',
    url:'https://YOUR_HOST/imagery/{z}/{x}/{y}.png',
    minLevel:0, maxLevel:19, levelOffset:-1.7, attribution:'你的数据署名' }],
  baseMap:'satellite',
  terrain:{ provider:new TerrainRgbProvider({
    urlTemplates:['https://YOUR_HOST/dem/{z}/{x}/{y}.png'],
    scheme:'xyz', encoding:'mapbox', maxLevel:14
  }), enabled:false },
  initialView:{longitude:106.55,latitude:29.61,altitude:20000},
  showLodGrid:false, autoStart:true,
  toolbar:{bottomOffset:48},
  terrainLod:{maximumScreenSpaceError:3,maxTiles:96},
  onStats:stats=>console.log(stats.terrain?.readyTargets,stats.surfaceTiles)
};
const viewer = await Viewer.create('map', options);
viewer.flyTo({longitude:106.55,latitude:29.61,altitude:20000,
  heading:0,pitch:-60,duration:0});
```

页面需有非零尺寸容器，如 `<div id="map" style="position:relative;width:100%;height:600px"></div>`。使用 HTTP/HTTPS 服务，不用 `file://`。`Viewer.create` 配置就绪不表示全部瓦片下载/解码/上传完成；通过状态回调观察内容就绪。

### 创建签名与属性

`Viewer.create(container: string | HTMLElement, options?: ViewerOptions): Promise<Viewer>`

container 字符串是元素 ID，不是 CSS 选择器；无有效容器、非法选项、重复底图 ID 会失败。取消创建使用 `options.signal`，销毁已创建实例使用 `destroy()`，两者不同。

| Viewer 属性 | 类型 | 作用 |
| --- | --- | --- |
| `entities` | `EntityCollection` | 对象集合；只读属性，集合可增删改 |
| `draw` | `EntityDrawingController` | 共享鼠标绘制控制器 |
| `measure` | `MeasurementController` | 使用同一输入系统的测量控制器 |
| `engine` | `GlobeEngine` | 高级扩展入口；应用通常优先使用 Viewer |
| `coordinates` | `CoordinateTransform` | 坐标转换器，本版公开便利入口 |
| `selectedEntity` | `EntitySnapshot \| null` | 当前按 ID 选中的最新快照 |
| `baseMap` | `BaseMapState` | `{id,type,capabilities}`；capabilities 为矢量样式能力报告或 null |
| `terrainEnabled` / `lodGridVisible` | `boolean` | 当前开关，使用方法修改 |
| `tileLevelOffset` | `number \| null` | 当前底图偏移；null 不能简单解释成零 |
| `isDestroyed` | `boolean` | 生命周期状态 |

### ViewerOptions

| 字段 | 类型/默认 | 初始化作用 |
| --- | --- | --- |
| `basemaps` | `readonly BaseMapDefinition[]` / `[]` | 创建时注册可切换底图，ID 唯一 |
| `baseMap` | `string \| null` / 第一项 | null 允许无底图启动；没有定义时也可无底图 |
| `terrain` | `false \| {provider:TerrainProvider;enabled?:boolean}` | 未配置则无 DEM；enabled 默认 true |
| `initialView` | `{longitude;latitude;altitude}` | 初始相机位置，altitude 是椭球高度；默认经度105、纬度32、约1.35个地球半径高度，初始朝向地心 |
| `autoStart` | `boolean` / true | 创建成功后启动渲染 |
| `showLodGrid` | `boolean` / false | 调试经纬网/叶子网格显示 |
| `toolbar` | `boolean \| ViewerToolbarOptions` / 不启用 | true 使用内置工具栏；也可稍后 `createToolbar()` |
| `signal` | `AbortSignal` | 取消创建/配置加载，不控制创建后的完整生命周期 |
| `pixelRatio` | `number` / devicePixelRatio | 输出清晰度；还受像素总量上限约束 |
| `maxDrawingBufferPixels` | `number` / 800万 | 限制实际绘制缓冲区像素，避免高 DPR 的过量成本 |
| `clearColor` | `number` / `0x07131d` | 背景色 |
| `navigation` | `GlobeNavigationOptions` | 导航速度/阻尼/高度约束，见相机节 |
| `lod` | `GlobeLodSelectorOptions` | 影像/地图选择配置；不是 DEM 配置 |
| `raster` | `RasterTileLayerOptions` | 影像请求、缓存、连续覆盖及渲染参数 |
| `grid` | `GlobeGridRendererOptions` | 网格表达参数；显示开关用 showLodGrid |
| `terrainLayer` / `terrainLod` | 对应 Options；terrainLod 可 false | DEM 资源/调度与独立几何选择，见地形节 |
| `polarSurface` | `false \| true \| PolarSurfaceLayerOptions` | Mercator 极圈显示补全；不是真实极地数据 |
| `onStats` | `(GlobeEngineStats)=>void` | 节流状态回调，不保证每帧调用 |
| `onFramePerformance` | `(GlobeFramePerformance)=>void` | 每帧性能回调，回调自身须轻量 |

### Viewer 方法总表

| 签名 | 返回/说明 |
| --- | --- |
| `getBaseMaps()` | 注册底图定义的只读列表 |
| `setBaseMap(id: string \| null)` | `Promise<BaseMapState>`；null 移除底图；并发切换最后一次生效，失败保留旧底图 |
| `setTerrainEnabled(enabled:boolean)` | void；未配置 provider 时开启抛 TERRAIN_UNAVAILABLE |
| `setLodGridVisible(visible:boolean)` | void |
| `setTileLevelOffset(offset:number)` | void；-4..1；provider 不支持偏移则报错，不修改 DEM 精度 |
| `flyTo(view:GlobeFlyToOptions)` | void；立即或动画设置相机，不返回瓦片就绪 Promise |
| `getCameraViewState()` | 当前相机/焦点/姿态快照 |
| `orientNorthUp()` / `resetView()` | void；当前姿态北向俯视 / 恢复创建姿态 |
| `selectEntity(id:string\|null)` | 选中的 `EntitySnapshot\|null`；null 清选择，缺失 ID 抛 NOT_FOUND |
| `pick(screen, options?)` | `EntitySnapshot\|null`；屏幕命中实体，不自动选中 |
| `inspectAt(screen)` | `{surface:SurfacePickResult\|null;entity:EntitySnapshot\|null}` |
| `pickPosition(screen, options?)` | `Cartographic\|null` |
| `pickPositionDetailed(screen, options?)` | `SurfacePickResult\|null`，含来源/回投/高程诊断 |
| `sampleTerrainHeight(lon,lat)` | `number\|null`；只查已可用 DEM，不请求新瓦片 |
| `getEntityResourceState(id)` | 图片符号状态或 null |
| `getEntityGroundState(id)` | 贴地表达状态或 null |
| `retryEntityResources(id)` | boolean；主动重试已有实体的错误图片资源 |
| `measureDistance(positions)` / `measureArea(positions,holes?)` | 纯椭球测量；也可从包直接导入函数 |
| `createToolbar(options?)` | `ViewerToolbar`；替换此前工具栏，归 Viewer 销毁 |
| `getPolarSurfaceState()` | 极圈模式/采样覆盖/预制队列/失败/缓存，或 null |
| `start()` / `stop()` | void；停止 RAF 不等于取消在途加载 |
| `destroy()` | void；重复安全，释放引擎/工具栏/控制器/实体资源 |

## 2. 相机、姿态与导航

```ts
viewer.flyTo({longitude:103.43968,latitude:32.04231,
  altitude:1000,heading:30,pitch:-20,duration:700});
const state = viewer.getCameraViewState();
viewer.orientNorthUp(); // 同一相机位置/高度/投影，改为上北下南俯视
viewer.resetView();     // 回到创建时保存的真实相机姿态
```

`GlobeFlyToOptions`：longitude/latitude 必填度数；altitude 必填，是目的地可用地形上方的相机高度（无 DEM 时以椭球为基准），**不同于 initialView.altitude 的椭球高度语义**；heading 顺时针从北起算，默认0；pitch 默认-90，-90表示俯视、0表示水平，但flyTo受控制器俯仰区间夹取（默认约-89.9..-5°），严格北向俯视可用orientNorthUp；duration 默认1800ms，0立即定位。getCameraViewState 返回 cameraLongitude/cameraLatitude/cameraAltitude（当前椭球高度）以及 focusLongitude/focusLatitude/heading/pitch；无有效焦点或姿态解算时后四项可能 null。

navigation 可设置 rotateSpeed、minRotateSpeed、zoomSpeed、minZoomSpeed、dampingFactor、minAltitude、zoomAltitudeGain、lookSpeed、tiltSpeed。默认分别约0.4、1e-6、0.5、1e-8、0.12、0.25m、5、1、1；速度会随相机高度调整，不是固定米/秒。运行时 `viewer.engine.controls.enabled` 可禁用交互；`cancelAnimation()` 取消飞行动画。直接操纵 engine.camera 是 Three.js 高级路径：改 fov/zoom 后必须 `updateProjectionMatrix()`，不能把经纬度直接填进 camera.position 的米坐标。常规姿态建议 flyTo(duration:0)。

## 3. 底图定义、切换与自定义服务

`BaseMapDefinition` 为三个互斥分支：

| type | 必填 | 可选 |
| --- | --- | --- |
| `xyz` | id、url | scheme:'xyz'/'tms'，minLevel、maxLevel、levelOffset:number/null、attribution |
| `provider` | id、provider:RasterTileProvider | 自己实现 provider 的服务协议和资源加载 |
| `vector-style` | id、style:string/MapStyle | sourceId、levelOffset、symbols、fetcher；实验性，见第10节 |

```ts
const maps = [
  {id:'xyz',type:'xyz' as const,url:'/tiles/{z}/{x}/{y}.png',scheme:'xyz' as const},
  {id:'tms',type:'xyz' as const,url:'/tms/{z}/{x}/{y}.png',scheme:'tms' as const},
  {id:'explicit-tms',type:'xyz' as const,url:'/tms/{z}/{x}/{-y}.png'}
];
// 在创建时把 maps 交给 basemaps，随后：
await viewer.setBaseMap('xyz');
await viewer.setBaseMap('tms');
await viewer.setBaseMap(null);
```

引擎内部保持 XYZ（北端 y=0）；TMS 只在请求行号中反转 `2^z-1-y`。显式 `{-y}` 不再二次翻转。levelOffset 是底图数据请求偏移，不是图像翻转、地形高度或 DEM LOD；null 在 XYZ provider 中恢复按网格请求的模式。默认连续视图偏移约-1.7，具体有效数据层级还受 maxLevel 与服务能力限制。

### WMTS Provider

```ts
import {loadWmtsCapabilities,WmtsRasterProvider} from 'spring-and-autumn-gis';
const capabilities = await loadWmtsCapabilities('/YOUR_PROXY/WMTSCapabilities.xml');
const provider = new WmtsRasterProvider({id:'admin-raster',capabilities,
  layer:'china_admin',tileMatrixSet:'YOUR_ADVERTISED_MATRIXSET',
  requestEncoding:'auto',attribution:'你的行政区数据'});
// 创建时注册：{id:'admin-base',type:'provider',provider}
// 作为业务叠加层则：
viewer.engine.addImageryLayer('admin-overlay',provider,{overlay:true,opacity:.7,order:500});
```

layer、tileMatrixSet 必须取 capabilities 广告值，不猜矩阵名称。WmtsRasterProviderOptions 包含 capabilities、layer、tileMatrixSet，以及 style、format、requestEncoding:'auto'/'rest'/'kvp'、endpointBaseUrl、levelOffset、attribution；endpointBaseUrl 可替换服务源站做代理。并非所有 CRS/非标准矩阵都可直接投到当前 Mercator 网格。

### 自定义 RasterTileProvider

最小协议为只读 id、minLevel、maxLevel 和 `url(tile:TileId):string`；可选 `loadTexture(tile:TileId,signal?:AbortSignal):Promise<THREE.Texture>` 自行加载，否则走引擎URL纹理加载。TileId 是 `{level,x,y}`。还可实现 hasTile、setViewLevel、setViewLevelOffset、maximumSourceLevel、currentSourceLevel/revision 等接口成员，详发布类型；不支持偏移的 provider 会使 Viewer.setTileLevelOffset 报错。未声明的接口不能靠命名相似自动生效。应用负责 CORS、授权、服务范围与署名；不把业务叠加图层注册成默认底图来互相替换。

## 4. EntityCollection：对象管理与 ID 选择

```ts
viewer.entities.add({id:'vehicle-001',type:'point',position:[106.55,29.61,100],
  name:'定位对象',properties:{deviceId:'001'},
  symbol:{icon:{url:'/icons/location.png'},size:36,heading:0,occlusion:'overlay'}});
const vehicle = viewer.entities.getById('vehicle-001');
viewer.selectEntity('vehicle-001');
viewer.entities.update('vehicle-001',{position:[106.551,29.612,101],symbol:{heading:45}});
console.log(viewer.selectedEntity); // 同 ID 的最新快照
```

### 公共几何属性

| 属性 | 类型/默认 | 作用 |
| --- | --- | --- |
| id | string，必填，≤256字符 | 集合内唯一稳定 ID；更新不能改 id/type |
| type | point/polyline/polygon/label | 几何类型 |
| position | `[lon,lat,height?]` | point/label 的坐标；height 省略渲染约30m |
| positions | `readonly EntityPosition[]` | 线≥2点，面≥3点；单位度/米 |
| holes | 面的坐标环数组 / [] | 位于外环内部且不相交的洞 |
| name / properties | string / JSON对象 | 名称与业务属性；不接受函数、循环、NaN、Infinity |
| visible | boolean / true | 单对象显隐 |
| heightReference | absolute / clamp-to-ground；默认absolute | 后者按当前显示地表构造，不改保存坐标 |
| groundOffset | number / 0.15m，0..10 | 贴地显示间距，避免深度争抢，不伪改数据高程 |
| order | number / 500，0..9000 | 业务排序；低于系统底图注记通道 |
| symbol / label | 对应符号 | label 类型必须有 label.text；其他类型可附属标注 |

局部面当前每轴范围≤1°，不支持自交、环相切或非法洞；每对象输入≤10000顶点、集合≤5000对象。贴地只支持当前 Mercator 有效地表，不能用大量行政区替代瓦片数据。点/标注按显示三角网锚点贴地，线/面按显示三角网裁剪与插值；都会随有效地表revision重新准备，期间须检查getEntityGroundState，不把设置字段便当作立即就绪。

### 属性与方法

| 签名/属性 | 返回与语义 |
| --- | --- |
| length / visible / isDestroyed | 数量、集合总显隐、生命周期 |
| values | 只读快照数组；修改快照不能改变地图 |
| selectedId / selectedEntity | ID/null、当前实体快照/null |
| `add(definition:EntityDefinition)` | EntitySnapshot；重复 ID 抛 DUPLICATE_ID |
| `getById(id:string)` / `has(id:string)` | 快照/undefined、boolean |
| `selectById(id:string\|null)` | 选择上下文；null清除；不自动高亮或飞行 |
| `query(query?:EntityQuery)` | 只读快照数组；默认所有对象 |
| `update(id,patch:EntityPatch)` | 更新后快照；id不存在抛 NOT_FOUND |
| `move(id,delta:EntityMove)` | 地理度数/米平移，保持形状，不是 ECEF 刚体移动 |
| `setVisibleById(id,visible)` / `setVisible(visible)` | 单对象更新快照 / 集合显隐 |
| `remove(id)` / `clear()` | boolean / void；被选对象删除或清空时撤销选择 |
| `onChange(listener)` | 返回解除订阅函数；事件含 type、id?、fields? |
| `dispose()` | 集合独立使用的销毁；Viewer 拥有时由 Viewer.destroy 调用 |

```ts
const stopListening = viewer.entities.onChange(change=>console.log(change.type,change.id));
const result = viewer.entities.query({type:'point',visible:true,properties:{deviceId:'001'}});
viewer.entities.move('vehicle-001',{longitude:.001,latitude:0,height:5});
viewer.entities.setVisibleById('vehicle-001',false);
viewer.selectEntity(null);
stopListening();
```

EntityQuery 字段 type、visible、name 是精确匹配；properties 每项为 Object.is 精确匹配，不是 SQL/深层条件。bounds 为 `{west,south,east,north}`，按锚点查询而非图形相交，west>east 表示跨日期线。EntityChange.type 包含 add/update/remove/clear/visibility/selection；selection 不重建 GPU 几何。隐藏实体仍可按 ID 选中，但不会被屏幕拾取命中。

更新规则：symbol 与 label **一级字段合并**；icon/texture 嵌套对象作为整体替换，不递归合并；`icon:null` / `texture:null` 移除图片，`label:null` 移除附属标注；独立 label 必须保持 label。positions/holes 数组整体替换；properties 整体替换。实时定位时更新同一 ID，不每帧 remove/add；轨迹数组会触发几何重建，需由应用限频和控制点数。

## 5. 点、线、面与标注符号

颜色为 CSS 命名色或3/6位十六进制；不接受 rgba 字符串，透明度单独 opacity。纹理颜色会乘 symbol.color，保持图片原色用白色。所有 occlusion:'overlay' 都只是表达置顶，不是贴地或修改高程；仍保留背面等可见性过滤。

### PointSymbol / PointIcon

| 字段 | 默认/范围 | 作用 |
| --- | --- | --- |
| color | 图片时白色，否则约#ffd166 | 图片乘色/简单点颜色 |
| size | 无图标默认12px，有图标默认32px；显式1..256 | icon.width/height优先于size |
| shape | circle；可square/diamond | 无图标或加载失败时的点形 |
| outlineColor / outlineWidth | 白色 / 1px | 简单点轮廓，宽0..64 |
| opacity | 1，0..1 | 点透明度 |
| icon | PointIcon/null | url必填；width/height可选1..256px；sourceHeading默认0 |
| heading | 0° | 目标朝向，顺时针北起算 |
| alignment | map；可screen | 地理北参照 / 屏幕上方向参照 |
| occlusion | depth；可overlay | 深度遮挡 / 置顶表达 |

```ts
viewer.entities.update('vehicle-001',{symbol:{
  icon:{url:'/icons/location.png',width:32,height:48,sourceHeading:0},
  heading:90,alignment:'map',color:'#ffffff',opacity:.9,occlusion:'overlay'
}});
```

sourceHeading 描述未旋转素材：上0、右90、下180、左270。heading 是你想显示的朝向，不应通过翻转瓦片解决素材方向。图片异步加载，需要看 getEntityResourceState，不以 add/update 完成表示图标就绪。HTTP/CORS/CSP/解码失败时状态为 error，并保留简单点兜底。

### LineSymbol / LineTexture

| 字段 | 默认/范围 | 作用 |
| --- | --- | --- |
| color / opacity | 无纹理#32e6a1、有纹理白色 / 1 | 颜色、透明度；图片原色用白色 |
| width | 3px，0..64 | 屏幕宽线；0不画有效宽线 |
| dash | `[onPixels,offPixels]` | 虚线周期，各1..256px |
| texture | `{url,length?,speed?,sourceDirection?}` / null | 图片宽线，可与动画配合 |
| texture.length | 64px，1..2048 | 图案沿路径屏幕长度周期 |
| texture.speed | 0，-4096..4096px/s | 正值沿 positions 顺序流动，0静止 |
| texture.sourceDirection | right；可left | 素材箭头原始方向；Qianjin_left 用left |
| occlusion | depth/overlay | 遮挡表达，不是高度 |

```ts
viewer.entities.add({id:'route-1',type:'polyline',heightReference:'clamp-to-ground',groundOffset:.5,
  positions:[[106.55,29.61,0],[106.56,29.62,0]],
  symbol:{color:'#ffffff',width:24,texture:{url:'/icons/forward-left.png',
    sourceDirection:'left',length:48,speed:30}}});
viewer.entities.update('route-1',{symbol:{texture:null,width:3,color:'#00ffff'}});
```

宽线目前是有限简单端帽/连接表达，不是完整制图级 line-join/line-cap。纹理太宽/像素太小会难辨箭头；动画只更新材质相位，不每帧重新加载图片。

### PolygonSymbol / PolygonTexture

| 字段 | 默认/范围 | 作用 |
| --- | --- | --- |
| color / opacity | #32e6a1 / 0.35 | 填充/纹理乘色与透明度 |
| fill | true | 是否绘制填充 |
| outlineColor / outlineWidth | #32e6a1 / 2px | 外环与洞轮廓；宽0..64 |
| texture | `{url,repeat?,offset?,rotation?,speed?}` / null | 面填充图片 |
| repeat | `[1,1]`，各0.01..256 | 面局部UV范围重复次数，不是米单位 |
| offset | `[0,0]` | UV偏移，各-1000..1000 |
| rotation | 0° | 局部UV旋转 |
| speed | `[0,0]` | U/V方向UV单位/秒，0停止 |
| occlusion | depth/overlay | 地形遮挡或置顶 |

```ts
viewer.entities.add({id:'zone-1',type:'polygon',heightReference:'clamp-to-ground',groundOffset:.5,
  positions:[[106.55,29.61],[106.56,29.61],[106.56,29.62],[106.55,29.62]],holes:[],
  symbol:{color:'#ffffff',opacity:.5,texture:{url:'/patterns/area.png',
    repeat:[8,4],offset:[0,0],rotation:0,speed:[-.15,0]}}});
```

### LabelSymbol

text 必填，≤512字符；最多表达约8行。fontSize 默认16px，6..96；color 白色，haloColor 约#122733，haloWidth 默认2px；offset 默认[0,-22]px，各-1024..1024；backgroundColor 可选；padding 默认4px；opacity 默认1；haloWidth/padding 等0..32。occlusion 默认 depth，附属点标注未显式指定时继承点策略。

```ts
viewer.entities.add({id:'label-1',type:'label',position:[106.55,29.61,100],
  label:{text:'站点A',fontSize:18,color:'#ffffff',haloColor:'#122733',
    offset:[0,-30],occlusion:'overlay'}});
viewer.entities.update('vehicle-001',{label:{text:'设备001',occlusion:'overlay'}});
```

实体文字是有界系统字体表达、有碰撞/分配上限，不是成熟的地图 glyph/sprite/SDF 符号管线。MVT 的地图注记能力另见实验章节，不能混为一谈。

## 6. EntityDrawingController：鼠标绘制与全局样式

```ts
viewer.draw.setStyle('point',{symbol:{color:'#ffffff',size:36,
  icon:{url:'/icons/location.png',sourceHeading:0},occlusion:'overlay'}});
viewer.draw.start({type:'point',continuous:true,properties:{source:'manual'}});
// 活动会话及后续同类型绘制都更新；不修改已经提交的对象：
viewer.draw.setStyle('point',{symbol:{heading:90}});
viewer.draw.stop();
viewer.draw.start({type:'polygon',heightReference:'clamp-to-ground',groundOffset:.5});
```

EntityDrawOptions：type必填；id/name/properties可选；symbol/label、heightReference/groundOffset 可在 start 指定；pick:SurfacePickOptions选择拾取方式；navigation:'allow'默认，左键绘制、右键/中键/滚轮导航，'lock'锁相机；continuous 默认true，仅点/标注会话多次提交，false单点提交后结束；clearPrevious 默认false，新对象成功提交后才清同工具历史；historyGroup 默认drawing，measurement供测量控制器使用。鼠标输入每会话≤1000顶点。

EntityDrawStyle 只包含 symbol、label、heightReference、groundOffset；按point/polyline/polygon/label分别保存默认样式。`setStyle` 合并一级符号字段，label:null清附属文字；返回可独立修改的样式副本。当前同类型会话同步修改；start 显式字段优先于默认样式，之后显式 setStyle 仍可更新活动会话。不会扫描修改历史对象；已有对象使用 entities.update 或工具栏“应用到选中对象”。样式仅保存在当前实例内，不跨页面重载持久化。

| 方法/属性 | 语义 |
| --- | --- |
| `start(options)` → EntityDrawState | 验证后开始；会取消旧预览，不删除已提交点 |
| `setStyle(type,style)` / `getStyle(type)` | 当前实例的按类型绘制默认样式 |
| `isActive` / `state` | 活动状态及快照 |
| `finish()` → EntitySnapshot | 线/面需要足够顶点；点需要已提交结果，否则用stop结束空会话 |
| `stop()` | 结束操作，保留已提交点；不提交未完成线面 |
| `undo()` → EntityDrawState | 撤销顶点；连续点会撤销最近本会话点 |
| `cancel()` | 丢弃未完成预览，不撤回已提交连续点 |
| `clearHistory(group='drawing')` | 只删该控制器仍拥有的结果；不误删普通业务对象或复用ID |
| `onChange(listener)` | 返回解除订阅函数 |
| `dispose()` | 独立创建时自行销毁；Viewer内由Viewer销毁 |

state 包含 active、type、vertexCount、positions、lastEntityId、lastPick、error 和 pickMs/previewMs/previewFrameMs。UI 打开/类型选择不会自动 start。线/面可双击或 Enter 完成，Esc取消，Backspace或Ctrl/Cmd+Z撤销；连续点可结束按钮、Enter、stop或关闭绘制弹窗结束。输入表单内 Enter 不拦截为地图完成。

工具栏的绘制样式与对象管理同处绘制弹窗。示例应用的图标复选框/纹理控件会更新同一个控制器，避免“表单设置了图标，工具栏却按默认圆点开始”的分叉。绘制预览为轻量表达，最终线面才进入正式持续贴地管线。

## 7. 测量

```ts
import {measureDistance,measureArea} from 'spring-and-autumn-gis';
const length = measureDistance([[106.55,29.61],[106.56,29.62]]);
const area = measureArea([[106.55,29.61],[106.56,29.61],[106.56,29.62]]);
viewer.measure.start('point');   // 默认连续坐标/高程拾取
viewer.measure.stop();
viewer.measure.start('distance',{clearPrevious:false});
// 鼠标落点后双击/Enter，或 viewer.measure.finish()
const unsubscribe = viewer.measure.onChange(state=>console.log(state.result));
```

measureDistance 返回 `{kind:'distance',method:'wgs84-geodesic',metres,segments}`；measureArea 返回 `{kind:'area',method:'wgs84-geodesic',squareMetres,perimeterMetres}`，第二参数 holes 可减洞面积、加洞周长。输入为有限WGS84坐标，≤10000点；距离≥2点，面积环≥3点。应用须提供有效非自交外环和合法洞，不能把纯函数的数值输出当作完整拓扑校验。高度不影响这两种水平椭球测量，不是3D直线距离、贴地折线路程或山坡面积。

MeasurementController 方法 start(kind='point',options?)、finish()、undo()、stop()、cancel()、clear()、onChange()、dispose()。state 为 active/kind/vertexCount/result/entityId/error；point结果含position、拾取source，以及可选polar-cap近似标识。完成结果保存在生成实体 properties.measurementResult；随后手动更新实体不自动重算测量。clear只删除本控制器拥有的结果，不清普通绘制/业务对象。测量与绘制共享同一个输入会话，切换工具会取消旧未完成操作。

## 8. 拾取、高程与坐标转换

```ts
const canvas = viewer.engine.renderer.domElement;
canvas.addEventListener('click',event=>{
  const rect=canvas.getBoundingClientRect();
  const screen={x:event.clientX-rect.left,y:event.clientY-rect.top};
  const hit=viewer.pickPositionDetailed(screen);
  console.log(hit?.position,hit?.source,hit?.errorPixels);
  const entity=viewer.pick(screen,{tolerance:8});
  if(entity)viewer.selectEntity(entity.id);
});
```

ScreenPosition 是相对 canvas 左上角的 CSS 像素，不是整个窗口client坐标、NDC、设备像素，不乘 devicePixelRatio。天空/画布外可返回 null。

SurfacePickOptions.mode：surface默认，交当前实际显示的三角地表；没有该交点时**可能回退椭球**，必须看source，不可将回退当真实DEM高程。ellipsoid只交WGS84参考椭球；absolute-height需要height米数，交固定椭球高程面，不是地形采样。

SurfacePickResult：position含longitude/latitude/height；source为rendered-surface/ellipsoid/absolute-height；tile是实际地表瓦片ID或null；screen/reprojected/errorPixels用于回投校核；distance是射线距离米，viewDepth是相机空间深度；approximation:'polar-cap'表示极圈近似补全，不是真实极地DEM。高程是椭球高度，不是海拔/正高；未知大地水准面转换不能自行假定。

`sampleTerrainHeight(longitude,latitude)` 仅查已有可用DEM，受当前地形开关/覆盖/夸张系数影响；未知/关闭/域外返回null。它不是任意位置异步高程服务，也不等于当前显示三角网格的精确插值；屏幕绘制/测量落点优先使用 pickPositionDetailed。

### CoordinateTransform（也可独立 new）

```ts
import {CoordinateTransform} from 'spring-and-autumn-gis';
const coordinates=viewer.coordinates; // 或 new CoordinateTransform()
const world=coordinates.geodeticToWorld({longitude:106.55,latitude:29.61,height:100});
const geodetic=coordinates.worldToGeodetic(world);
const mercator=coordinates.geodeticToWebMercator(106.55,29.61);
const restored=coordinates.webMercatorToGeodetic(mercator.x,mercator.y);
const tile=coordinates.geodeticToTile(106.55,29.61,18); // x/y为浮点瓦片坐标
const enu=coordinates.eastNorthUpFrame({longitude:106.55,latitude:29.61,height:100});
```

| 签名 | 返回 |
| --- | --- |
| `new CoordinateTransform(ellipsoid=Ellipsoid.WGS84)` | 转换器 |
| `geodeticToWorld(position:Cartographic,result?:THREE.Vector3)` | 引擎轴的米制Vector3 |
| `worldToGeodetic(world:THREE.Vector3)` | `{longitude,latitude,height}`，度/米 |
| `geodeticToWebMercator(lon,lat)` | `{x,y}` 米；纬度夹到±85.0511287798066° |
| `webMercatorToGeodetic(x,y)` | 经度/纬度，不推断高度 |
| `geodeticToTile(lon,lat,level)` | `{x,y,level}` 浮点XYZ瓦片坐标；索引需floor并处理边界 |
| `eastNorthUpFrame(origin,result?:THREE.Matrix4)` | 局部东/北/上到世界的变换矩阵 |

引擎世界轴为X=90°E赤道方向、Y=北极、Z=0°经线赤道方向，不是常规ECEF XYZ。与常规ECEF互换为 `ECEF=(world.z,world.x,world.y)`。ENU局部X东/Y北/Z上。Ellipsoid.WGS84提供equatorialRadius/polarRadius/eccentricitySquared和cartographicToCartesian；默认半径使用米。GeographicTilingScheme/WebMercatorTilingScheme提供rootTiles、children、rectangle；当前影像/DEM常规使用后者。GCJ-02/BD-09转换、任意投影重投影和高程基准转换尚未提供。

## 9. 地形服务与独立LOD配置

```ts
const dem = new TerrainRgbProvider({id:'user-dem',
  urlTemplates:['https://YOUR_HOST/dem/{z}/{x}/{y}.png?key=YOUR_PUBLIC_KEY'],
  scheme:'xyz',encoding:'mapbox',minLevel:0,maxLevel:14,attribution:'你的DEM署名'});
// Viewer.create 时：terrain:{provider:dem,enabled:true}
viewer.setTerrainEnabled(false);
viewer.setTerrainEnabled(true); // 只能开启已配置的provider，不自动寻找服务
```

TerrainRgbProviderOptions：urlTemplates与tileJsonUrl至少一种；模板为有序备用源；id默认terrain-rgb，scheme默认由配置/元数据选择，encoding默认mapbox；minLevel默认0、maxLevel默认14（可被实际元数据收紧）；attribution可选。noDataHeight仅显式授权404/204数据空洞使用平面，不应用于401/403，通常省略，保留可信祖先。普通RGB影像不是Terrain-RGB；encoding选错会得到错误高程。TileJSON及DEM瓦片URL均需允许跨域访问。

TerrainProvider最小接口为id/minLevel/maxLevel和loadTile(tile,signal?)→Promise<TerrainTileData>；返回id必须是实际数据源XYZ坐标，width/height、Float32Array heights、minimumHeight/maximumHeight和THREE.DataTexture。可提供geometricError(tile)返回数据集几何误差米数，缺省使用显式估算而非宣称测绘认证误差。

| terrainLod 字段 | 默认 | 含义 |
| --- | --- | --- |
| maximumScreenSpaceError | 3px | DEM几何误差阈值，不是影像瓦片像素阈值 |
| maxTiles | 96 | 独立DEM目标预算，还受资源容量收紧 |
| maxSurfaceTiles | 512 | 公共显示网格预算，不是影像请求数量 |
| samplesPerTile / estimatedSlope | 256 / 0.25 | 无误差元数据时的分辨率/坡度估算 |
| updateIntervalMs | 100ms | 运动中选择节奏，上传/消费者仍逐帧更新 |

Web Mercator默认独立；terrainLod:false对照旧共享路径。terrainLayer主要字段：segments默认64（诊断地形网格密度）、maxConcurrentRequests默认6、maxCachedTiles默认384、maxResourceBytes默认96MiB、exaggeration默认1、maxCommitsPerFrame默认2、commitBudgetMs默认2、maxUploadBytesPerFrame默认1MiB、requestTimeoutMs默认15000、requestPriority默认camera-near、preemptFarDetail默认false。regionalCoverage是未完整现场验收的事务实验开关，默认false；independentSelection由GlobeEngine接线，应用不要自行伪造选择方式。

onStats.terrain区分ready/loading/queued/pending/errors、targetTiles/readyTargets、目标级别和sourceMinimumLevel/sourceMaximumLevel；surfaceTiles/terrainSurfaceLimited是公共地表预算诊断。coverageReady只表示有覆盖，60FPS不表示精度达标。极圈补全也不是真实极地DEM。建筑拉伸、任意多边形地形平整/抬升以及异步全球高程服务尚未开放。

### token.json：应用配置，不是引擎自动加载接口

SDK不会偷偷读取token.json，也不内置开发者密钥。独立交互应用主动读取自己的token.json并构造Provider；无有效资源配置则不创建地图。应用可以使用以下自建服务配置：

```json
{
  "demo": {
    "defaultBaseMap": "my-base",
    "basemaps": [{"id":"my-base","type":"xyz","scheme":"xyz",
      "url":"https://YOUR_HOST/imagery/{z}/{x}/{y}.png","maxLevel":19}],
    "terrain": {"urlTemplates":["https://YOUR_HOST/dem/{z}/{x}/{y}.png"],
      "scheme":"xyz","encoding":"mapbox","maxLevel":14}
  }
}
```

独立应用还支持tianditu.token、maptiler.key、geovis.terrainToken及osm.rasterUrl/styleUrl等配置，见其token.example.json及SDK使用说明。开发时文件在消费者项目根，静态部署到消费者dist；配置文件发布意味着浏览器可读，只放受域名/权限限制的公开Key，serverToken/私钥留在服务端。天地图/OSM等资源亦须由用户确认授权/配额/署名，SDK不承诺第三方服务免费或无条件可用。不要把已填凭据的dist、截图日志或URL上传为公共示例。

## 10. 业务图层与实验性矢量瓦片

稳定业务层建议与底图分离：engine.addImageryLayer(id,provider,options)添加栅格叠加，removeImageryLayer/getImageryLayer管理；layer.setVisible/setOpacity/setOrder控制显隐、透明度及排序。engine.addFeatureLayer/removeFeatureLayer/getFeatureLayer管理GeoJsonLayer。Viewer.setBaseMap只替换底图，不清业务层或entities。

```ts
import {GeoJsonSource,GeoJsonLayer} from 'spring-and-autumn-gis';
const source=new GeoJsonSource({id:'boundary',url:'/data/boundary.geojson',crs:'EPSG:4326'});
const collection=await source.load();
const layer=new GeoJsonLayer(viewer.engine.ellipsoid,collection,{
  color:'#00ffff',terrain:viewer.engine.terrain??undefined,heightOffset:3});
viewer.engine.addFeatureLayer('boundary',layer);
layer.object3d.visible=false;
viewer.engine.removeFeatureLayer('boundary');
```

GeoJsonSourceOptions含id/url/maxFeatures（默认5000）/crs（默认EPSG:4326）；load(signal?)返回经过验证的FeatureCollection。GeoJsonLayer现主要渲染点和边界，不是可填充/ID编辑的EntityCollection；options还有pointColor/opacity/pointSize/order、terrainSampleBudget默认4096、terrainRefreshDelayMs默认150、maximumSegmentDegrees默认0.1°。大量全国行政区不要走手工实体编辑路径。

### MVT / Style v8（实验性）

底图可注册`{id:'vector',type:'vector-style',style:'/styles/Enlabel.json',symbols:true}`；这里JSON需有合法sources与layers，数据服务、glyph、sprite URL也要有效。可以跨XYZ/Provider/Style底图切换；symbols:false关闭独立地图注记通道。

```ts
import {MvtVectorLayer} from 'spring-and-autumn-gis';
const business=new MvtVectorLayer(viewer.engine.ellipsoid,{
  id:'china-admin',role:'overlay',
  urlTemplate:'http://localhost:8085/mapservice/vector/china_admin/tile/{z}/{x}/{y}',
  scheme:'xyz',sourceId:'admin',terrain:viewer.engine.terrain??undefined,
  style:{version:8,sources:{admin:{type:'vector',tiles:[
    'http://localhost:8085/mapservice/vector/china_admin/tile/{z}/{x}/{y}']}},
    layers:[{id:'boundary',type:'line',source:'admin','source-layer':'YOUR_ACTUAL_SOURCE_LAYER',
      paint:{'line-color':'#00ffff','line-width':2}}]},
  maxVisibleLabels:64,maxLabelsPerTile:8,maxAllocatedLabels:256
});
await business.initialize();
viewer.engine.addVectorLayer('china-admin',business);
```

source-layer必须是PBF内部实际图层名，不一定等于服务ID。MvtVectorLayer支持style/styleUrl、tileJsonUrl/urlTemplate、sourceId、scheme、bounds、minLevel/maxLevel、levelOffset、opacity/order、terrain/heightOffset、symbols/symbolsOnly及有界请求/标签参数；setOpacity、setViewLevelOffset和object3d.visible供运行时控制。创建/initialize成功不代表全部可见PBF就绪。

**明确限制：** 当前并非完整MapLibre样式兼容或成熟地图标注系统；表达式、图案、精确线连接、沿线文本、glyph/sprite布局、跨瓦片碰撞/去重等都有能力边界；业务粗MVT跨更细DEM的分块/atlas仍未完成。GPU矢量底图是制图到地表纹理的管线，并非所有道路/面都独立成为3D几何。不能宣传MVT已成熟或底图文字可立体拉伸。检查BaseMapState.capabilities与样式能力报告；明确unsupported/degraded，而非静默承诺全部标准支持。实体图标/文字系统与MVT地图符号系统是不同实现。

## 11. 工具栏与可改样式

ViewerToolbarOptions：container可指定定位容器；bottomOffset默认48px加safe-area；baseMapNames映射ID到展示名；onLayers扩展业务面板；drawContent挂载已有绘制/样式/管理表单；onDraw(type,{clearPrevious})桥接自定义开始逻辑；basemapContent/offsetContent挂载现有控件；onPanelOpen供关闭互斥面板。未提供drawContent时，历史onEntities回调可由绘制面板内“打开应用对象管理”按钮触发，但不再有独立工具栏图标，推荐用drawContent内嵌管理。

```ts
const toolbar=viewer.createToolbar({bottomOffset:56});
toolbar.element.style.setProperty('--sag-toolbar-bottom','72px');
toolbar.panel.style.setProperty('--sag-toolbar-bottom','72px');
toolbar.endInteraction(); // 结束输入，面板保留
toolbar.close();          // 关闭并取消未完成输入
// 也可 toolbar.destroy()；创建替代工具栏/Viewer销毁会统一清理
```

CSS选择器为`.sag-tools`、`.sag-tool-panel`、`.sag-tool-panel--compact`；可在地图容器设置`--sag-toolbar-bottom`。默认7图标：底图、初始视角、指南针、偏移、地形、测量、绘制；有onLayers再加业务图层。对象管理位于绘制弹窗。底图/偏移为工具栏旁小弹窗，复杂工具为右侧面板。只有“开始”按钮才开启操作，清历史选项在开始时捕获，新对象成功提交后才清。

移动端 Pointer Events 映射：单指拖动为 globe orbit；双指平移同时提供 look/tilt；双指距离变化写入与 wheel 相同的 zoom 通道。鼠标左/中/右键行为保持不变。

## 12. 生命周期、状态、错误与扩展入口

ViewerError.code：INVALID_OPTIONS（容器/配置/参数）、DESTROYED、ABORTED、BASEMAP_LOAD_FAILED、TERRAIN_UNAVAILABLE。EntityError.code：INVALID_ENTITY、DUPLICATE_ID、NOT_FOUND、DESTROYED。Provider网络错误可含URL，应用日志不得泄露Key。异步捕获错误并保留原地图，不用不断新建Viewer作为失败重试。

```ts
try { await viewer.setBaseMap('vector'); }
catch(error) { console.error(error.code); } // 不公开打印带Key的服务错误URL
const image=viewer.getEntityResourceState('vehicle-001');
const ground=viewer.getEntityGroundState('route-1');
viewer.destroy(); // 解除自己创建的DOM监听/onChange订阅也由应用负责
```

EntityResourceState含state:'none'/'pending'/'loading'/'ready'/'error'和images数量；EntityGroundState含absolute/pending/ready/unavailable/limited、revision、patches、vertices、message。地表更新期间ready可变pending；unavailable是无有效覆盖，limited是规模/预算约束，不可当作成功。onStats包括影像、DEM、vectorLayers及性能；onFramePerformance的lodMs/terrainMs/surfaceMs/featureMs/renderSubmitMs、drawCalls、triangles、gpuMs（可能null）是不同阶段，不是FPS承诺。

高级公开入口按用途阅读发布类型，避免调用private：

| 导出组 | 典型入口与职责 |
| --- | --- |
| 引擎 | GlobeEngine/GlobeCameraController；camera、renderer、controls、scene及图层生命周期 |
| 栅格 | UrlTemplateRasterProvider、WmtsRasterProvider、RasterTileLayer；自定义服务/业务栅格 |
| 地形 | TerrainRgbProvider、TerrainTileLayer、TerrainLodSelector；sampleTerrainTile/decodeTerrainRgbHeight、误差/覆盖诊断 |
| 坐标/网格 | Ellipsoid、CoordinateTransform、WebMercatorTilingScheme、GeographicTilingScheme、GlobeLodSelector |
| 实体 | EntityCollection、EntityLayer、EntityDrawingController、MeasurementController；通常由Viewer持有 |
| 图层目录 | LayerCollection、DataSourceRegistry、LayerCatalog及其验证/序列化；不是Viewer自动读取token接口 |
| 实验矢量 | MvtVectorLayer、MvtTileSource、MapStyleLoader、GpuVectorTileProvider及样式能力分析 |
| 内部调度诊断 | FrameWorkBudget、RequestScheduler、TileStateMachine；高级导出不表示可以绕过引擎一致覆盖规则 |

不稳定Worker实现、桶构建、贴地事务与纹理生命周期细节不建议作为应用依赖。常规SDK用本手册的Viewer/实体/测量/坐标入口；尚未实现的能力不要通过private字段临时拼装成对外API。

## 13. 安装包与 TS / ES6 示例

```bat
rem 在消费者项目执行，不在引擎项目创建临时消费者
npm install ./vendor/spring-and-autumn-gis-0.1.0.tgz three
```

在Vite等构建工具中直接`import {Viewer} from 'spring-and-autumn-gis'`；JS去掉类型标注和import type，运行时接口相同。原生浏览器直接引入ESM dist时需import map解析外置three依赖；不是复制单个JS就包含three。Worker/CSP策略要允许对应资源与blob工作线程，兼容主线程降级可能影响动态性能。包只发布dist及SDK公开文档，不发布开发者token、测试地图数据或独立网站源码。

本地交互消费者为E:\0-SpringGISNet：sdk.html（TS）、sdk-js.html（ES6），填写自己的token.json后`npm run dev`，地址以终端输出为准。引擎根index.html是源码调试页，不是独立依赖消费示例。旧examples/sdk-consumer已归档，不再维护第二套临时消费者流程。
