# SDK 使用说明

2026-10-08。引擎仓库负责库输出；独立交互、TS/JS消费和应用构建放在 **E:\0-SpringGISNet**。不再从本仓库通过demo:sdk创建临时消费者或启动交互服务。

## 1. 引擎只构建 dist

CMD 示例（npm命令也可在PowerShell中执行，切目录语法不同）：

```bat
cd /d E:\SpringAndAutumnGIS\SpringAndAutumnGIS
npm run build
npm run test:sdk
```

上面cd /d是CMD语法；PowerShell切目录用Set-Location。build生成ES模块、CJS兼容入口和类型声明；test:sdk仅检查现有dist，不安装依赖、不启动服务。不运行浏览器，也不代表真实数据服务已验收。

- dist/spring-and-autumn-gis.es.js：ES6库。
- dist/spring-and-autumn-gis.umd.cjs：CommonJS兼容入口。
- dist/index.d.ts及各模块声明：TypeScript接口。
- 引擎dist不是网站，没有交互index.html。

发布可使用npm pack（prepack构建），或构建后npm pack --ignore-scripts。安装包只包含dist、公共文档及npm附带的包描述/许可/README；不带src、交互项目、token.json、全国数据或自有服务资源。Three为peer dependency。未发布npm registry。

## 2. 在实际独立项目消费

```bat
cd /d E:\0-SpringGISNet
npm run sdk:update
npm run dev
```

sdk:update将引擎**当前已生成的dist**打成vendor安装包并安装，不构建引擎、不读源码模块、不建立源码目录链接。引擎目录可用SDK_ENGINE_DIR指定；正常dev/build/preview不调用sdk:update，也不依赖引擎仓库仍然存在。

默认开发地址由应用config/pc.env.json决定，当前为5173：

- /：现有Vue站点，引擎区域嵌入交互页。
- /sdk.html：TypeScript消费。
- /sdk-js.html：JavaScript ES6消费。

两种消费源码都使用 `import { Viewer } from 'spring-and-autumn-gis'`。JS文件为实际ES模块，不是让浏览器执行TS。详见独立项目的SDK接入说明.md。

应用生产构建/预览：

```bat
cd /d E:\0-SpringGISNet
npm run build
npm run preview
```

默认preview端口4173。直接服务应用dist；不重新打包引擎、不生成临时项目。静态服务器部署整个应用dist（HTML和assets一起），而不是把引擎库文件当HTML页面打开。Vite仅为应用开发/预览工具，不是SDK运行时必须部署的服务器。

## 3. Viewer最小用法

```js
import { Viewer } from 'spring-and-autumn-gis';

async function main() {
  const viewer = await Viewer.create('map', {
    basemaps: [
      { id: 'image', type: 'xyz', url: '/tiles/{z}/{x}/{y}.png',
        scheme: 'xyz', maxLevel: 20, levelOffset: -1.7 },
      { id: 'vector', type: 'vector-style', style: '/styles/map.json', symbols: true }
    ],
    baseMap: 'image',
    terrain: false,
    showLodGrid: false,
    initialView: { longitude: 106.55, latitude: 29.61, altitude: 12000 }
  });
  await viewer.setBaseMap('vector');
  viewer.setLodGridVisible(true);
  viewer.flyTo({ longitude: 106.55, latitude: 29.61, altitude: 2000, pitch: -45, duration: 700 });
  // 页面/组件退出时viewer.destroy()，不是初始化后立即销毁。
  return viewer;
}
main().catch(console.error);
```

容器必须有尺寸。地址由应用提供。create和setBaseMap表示配置就绪，不表示所有瓦片已经加载。普通交互页不自动销毁地图；自动回归才进行销毁/重建验证。

## 4. 公共接口与边界

- Viewer.create：DOM/id容器，basemaps、baseMap、terrain、showLodGrid、autoStart、signal、initialView及低层LOD/导航/回调配置。默认第一底图，baseMap:null为无底图，showLodGrid默认false。
- setBaseMap(id|null)：XYZ/TMS、借用RasterTileProvider、Style v8 GPU矢量统一切换，保留业务图层。配置失败保留原底图；被新请求取代的旧请求抛ABORTED。
- setTerrainEnabled：需初始化时配置DEM Provider。初始enabled:false不请求DEM；不支持运行中替换DEM Provider。
- setLodGridVisible：隐藏经纬网，不关闭地图LOD；隐藏时跳过网格更新。
- flyTo、getCameraViewState：WGS84角度与高度米，pitch -90俯视、0水平，duration毫秒。
- start、stop、destroy：stop暂停渲染但不承诺取消所有在途任务；destroy幂等，销毁后变更拒绝。
- baseMap、terrainEnabled、lodGridVisible、isDestroyed、getBaseMaps：状态/配置快照。
- engine：低层扩展入口，可复用GeoJsonLayer等，不要直接破坏SDK持有的base图层或__sdk_base_labels。
- ViewerError.code：INVALID_OPTIONS、BASEMAP_LOAD_FAILED、ABORTED、TERRAIN_UNAVAILABLE、DESTROYED。公共加载错误不回显后端凭据URL；浏览器WebGL构造错误可能直接抛出。

内部统一XYZ；scheme:tms只转换请求行号，显式{-y}不重复翻转，不改纹理/几何南北方向。借用Provider由调用方管理，Viewer创建的矢量Provider由Viewer释放。矢量是现有GPU地表管线与简化独立注记子集，不是完整MapLibre兼容实现；能力报告见baseMap.capabilities。旧GeoJsonLayer的面仍仅为边界；2026-10-09增加entities，2026-10-10增加基础鼠标绘制、显示地表拾取和置顶表达，见§4.1–4.3。独立地形LOD、持续贴地和高级编辑仍未实施。

## 4.1 B版：点线面与标注对象

推荐使用 `viewer.entities`。四种type：point、polyline、polygon、label；任何几何也可附属label。底图切换保留这些业务对象，不与底图清单混用。无需通过engine手动增加GeoJSON图层。

```js
viewer.entities.add({
  id: 'station', type: 'point', name: '业务站点',
  position: [106.55, 29.61, 1500], properties: { category: 'station' },
  symbol: { shape: 'diamond', size: 22, color: '#ffd166', outlineColor: '#ffffff', outlineWidth: 2 },
  label: { text: '业务站点', fontSize: 18, color: '#ffffff', haloColor: '#173342', offset: [0, -30] }
});
viewer.entities.add({
  id: 'route', type: 'polyline',
  positions: [[106.52,29.60,1500], [106.55,29.61,1500], [106.59,29.62,1500]],
  symbol: { color: '#4bdcff', width: 5, opacity: 1, dash: [12, 6] }
});
viewer.entities.add({
  id: 'area', type: 'polygon',
  positions: [[106.51,29.63,1500], [106.57,29.63,1500], [106.57,29.67,1500], [106.51,29.67,1500]],
  holes: [[[106.53,29.64,1500], [106.55,29.64,1500], [106.55,29.66,1500], [106.53,29.66,1500]]],
  symbol: { fill: true, color: '#27e7a4', opacity: 0.5, outlineColor: '#ffffff', outlineWidth: 2 }
});
viewer.entities.add({ id: 'note', type: 'label', position: [106.58,29.65,1500],
  label: { text: '独立标注', fontSize: 18, backgroundColor: '#173342', padding: 5, offset: [0,0] } });

const station = viewer.entities.getById('station'); // 深度只读快照；查不到返回undefined
const stations = viewer.entities.query({ type: 'point', properties: { category: 'station' } });
viewer.entities.update('station', { symbol: { color: '#ff0066', size: 28 }, label: { text: '修改后的标注' } });
viewer.entities.move('station', { longitude: 0.01, latitude: 0, height: 100 });
viewer.entities.setVisibleById('station', false);
viewer.entities.setVisible(false); // 整个集合隐藏，保留各对象自己的visible标志
viewer.entities.setVisible(true);
viewer.entities.update('area', { symbol: { fill: false } });
viewer.entities.update('station', { label: null }); // 仅移除附属标注
const unsubscribe = viewer.entities.onChange(change => console.log(change.type, change.id));
viewer.entities.remove('route');
unsubscribe();
// viewer.entities.clear(); // 删除全部业务对象，不影响底图
```

| 接口 | 契约 |
| --- | --- |
| add(definition) | id必填且唯一，返回EntitySnapshot；不修改调用方的输入 |
| getById(id)、has(id)、values、length | 按ID/全量读取；values和对象属性均为冻结快照，不能直接赋值修改 |
| query({type,visible,name,properties,bounds}) | 条件AND；properties浅层精确值匹配，适合字符串/数值字段；bounds按几何首顶点/点位置查询，不是面相交查询，west>east支持跨日界线 |
| update(id,patch) | id/type不可变；symbol、label字段合并，position/positions/holes数组替换，properties整体替换；返回新快照，失败不改旧对象 |
| move(id,{longitude,latitude,height}) | 度／米增量；面和洞一起移动，经度归一化；不是ECEF刚体变换，越界纬度拒绝 |
| setVisibleById(id,bool)、setVisible(bool)、visible | 单对象／集合显隐；隐藏不释放资源，不被pick选中；元数据／显隐更新不重建几何 |
| remove(id)、clear() | 删除释放对象GPU资源；remove不存在ID返回false；clear不销毁集合 |
| onChange(listener) | add/update/remove/clear/visibility，update带fields；返回取消订阅函数，观察者异常不打断其他订阅者 |
| viewer.pick({x,y},{tolerance}) | canvas左上角为原点的CSS像素；返回最上层命中对象快照或null，默认容差6px |
| viewer.pickPosition({x,y},options?) | 默认求当前显示地表网格交点；支持明确指定参考椭球或固定绝对高度面，详见§4.3 |

示例点击查询：从event.clientX/clientY减去canvas.getBoundingClientRect()的left/top再传给pick，不乘devicePixelRatio。单击新增点采用拾取位置及高度，不再取椭球经纬度后硬加1500米；多点绘制使用viewer.draw，详见§4.3。

符号与高度边界：

- 坐标WGS84度、第三维为椭球绝对高度米，省略时30米。默认30米是无地形时的显示抬高，不是采样地形。显式0仍为0；开启地形不会自动抬高或持续贴地。默认正常深度，低于山体会被遮挡；可选择occlusion:overlay置顶表达，明确不作为贴地。
- 点circle/square/diamond或URL图标，size/outlineWidth为CSS像素；宽线为GPU屏幕挤出，不依赖原生WebGL线宽。线端为butt，连接仍为简化效果，不是完整制图级join/cap；纹理与虚线按可见路径屏幕长度累计。图标/流动纹理见§4.2；不支持自定义字体资源或建筑拉伸。
- polygon是真实填充，支持凹外环、洞和轮廓；fill:false仅轮廓。闭合末点可省略；自交、相交/触碰环、洞在外部、嵌套洞、零面积拒绝。局部面经纬各跨度最多1度，支持局部跨日界线；区域/全国面优先使用已有瓦片图层。显式0高度和很长线段/复杂面仍可能受曲率及细分预算影响，不承诺任意全球曲面贴合精度。
- 颜色CSS命名色或3/6位hex，透明度用opacity；尺寸/坐标输入、符号字段、几何规模均校验。EntityError.code为INVALID_ENTITY/DUPLICATE_ID/NOT_FOUND/DESTROYED，不能混同ViewerError。
- 标注是GPU屏幕朝向文字，可配颜色、光晕、背景、字号、offset；offset正x向右、正y向下。几何附属标注锚在首顶点；需要另一个锚点时使用独立label对象。文字最多512字符，显示最多8行、宽度1024CSS px（超出裁切）；使用系统sans-serif，不是完整glyph/sprite/symbol-style兼容系统。
- 标注有画布/椭球遮挡裁剪、32px网格碰撞及最多256个可见限制，高order优先占位；正常模式地形遮挡交给GPU，overlay模式关闭符号深度测试但不改高度。业务order范围0..9000，底图引擎注记保持既有上层顺序。点／文字pick可用当前地表深度排除正常模式的遮挡对象；线面仍是屏幕几何近似，不是任意模型/透明材质深度拾取。
- 默认最多5000对象、单几何10000输入点，线细分有界，面有曲率细分和规模限制；这是可编辑业务对象系统，不承诺数万密集对象60FPS。只重建脏对象，每帧最多8个/2ms软预算；一个任务不能被预算中途抢占。样式/几何跨帧生效，更新期间保留旧显示；remove/隐藏立即影响显示与拾取。
- destroy释放集合、材质、纹理、几何和订阅；之后集合读写拒绝。不要手动移除__sdk_entities或调用其dispose后继续使用Viewer的entities。EntityCollection单独导出便于无WebGL管理/测试；EntityLayer是低层适配器。

## 4.2 图标朝向、线方向纹理和面滚动材质

用户提供两张示例PNG已放入独立应用public：`mylocation_up.png`本来向上（sourceHeading:0），`Qianjin_left.png`本来向左（270度、sourceDirection:left）。引擎dist/tgz不携带这些图片；任何消费者自行部署自己的图片URL。图片不是底图或业务瓦片，不能按XYZ/TMS再翻转。

```js
viewer.entities.add({ id: 'person', type: 'point', position: [106.55,29.61,1500],
  symbol: { icon: { url: './mylocation_up.png', width: 36, height: 36, sourceHeading: 0 },
    heading: 0, alignment: 'map', color: '#ffffff', opacity: 1 } });
viewer.entities.update('person', { symbol: { heading: 90 } }); // 朝东，不再下载图片/重建几何

viewer.entities.add({ id: 'flow-route', type: 'polyline',
  positions: [[106.52,29.60,1500], [106.55,29.61,1500], [106.59,29.62,1500]],
  symbol: { width: 24, color: '#ffffff', opacity: 0.9,
    texture: { url: './Qianjin_left.png', sourceDirection: 'left', length: 48, speed: 30 } } });

viewer.entities.add({ id: 'moving-area', type: 'polygon',
  positions: [[106.51,29.63,1500], [106.57,29.63,1500], [106.57,29.67,1500], [106.51,29.67,1500]],
  symbol: { fill: true, color: '#ffffff', opacity: 0.5, outlineColor: '#ffffff', outlineWidth: 2,
    texture: { url: './Qianjin_left.png', repeat: [8,4], offset: [0,0], rotation: 0, speed: [-0.15,0] } } });

viewer.entities.update('flow-route', { symbol: { texture: {
  url: './Qianjin_left.png', sourceDirection: 'left', length: 48, speed: 0 } } }); // 停止流动
viewer.entities.update('person', { symbol: { icon: null } }); // 退回简单点符号
viewer.entities.update('moving-area', { symbol: { texture: null } }); // 退回纯色填充
const resource = viewer.getEntityResourceState('person'); // none/pending/loading/ready/error；不存在返回null
viewer.retryEntityResources('person'); // 显式重试失败图片或纹理预算受限标注，返回是否排入重试
```

朝向与动画契约：

- heading顺时针度数。alignment:map（默认）以当前位置投影的地理北为0，地图旋转时图标随地理北变化；screen以屏幕上方为0。sourceHeading表示原素材方向，最终旋转为目标朝向减原朝向，再加地图北向；原向左图标若要朝北，sourceHeading设270而非修改PNG。宽高为CSS像素，省略用size，图标默认32px。
- 线width必须大于0才制作条带；图片沿positions方向排列。sourceDirection:left把向左素材校正为沿坐标顺序向前，right为原素材向右。length是沿路径的重复周期CSS像素，speed为CSS像素/秒，正数沿坐标顺序、负数反向、0静止。虚线和箭头使用累计屏幕长度，相机姿态变化时更新长度属性，静止不重算；连接处仍不是完整制图级圆角/斜接。
- 面纹理UV由局部经纬包围盒归一化；repeat为重复次数，offset为初始UV偏移，rotation为顺时针纹理旋转度数，speed为纹理坐标轴上的平移UV/秒。rotation:0时U向东、V向北，向左箭头配负U流速显示向西移动。旋转后运动轴一起旋转；不是世界米/秒，也不是按地形坡面面积等距铺图。
- color乘到纹理上，保留原图片颜色用白色；opacity与图片alpha共同生效，面孔洞仍为空。图标和纹理可动态修改/移除；symbol浅层合并，但icon/texture描述整体替换，修改纹理speed时请保留url等字段。
- PNG/JPEG/WebP，远程图片需要CORS；支持相对/HTTP(S)/blob及对应base64 data URL。不支持任意脚本URL。加载最多4并发、256个ready/loading共享图片，单图片≤8MiB且≤2048×2048；15秒超时，不影响地图瓦片队列。图片与文字纹理共同受64MiB估算RGBA上传预算约束（不含解码临时内存）；预算不足时可暂停新符号纹理/文字并报告error，不无限扩张显存。超限制/404/CORS失败暂显示简单几何，不冒充纹理已经就绪；公共状态不回显带凭据URL。修复服务或释放其他对象后调用retryEntityResources显式重试，不自动无限重试坏URL。
- 按URL共享引用，样式更新先取得新引用再释放旧显示；最后一个使用者删除后取消请求、关闭ImageBitmap并释放GPU纹理。迟到图片不会覆盖已删除或新建对象。GPU上传前ImageBitmap显式翻转一次，方向回归覆盖上/下和顺时针旋转；这不改变底图XYZ/TMS约束。
- 流动动画每帧仅修改相位/UV偏移uniform，不重建网格、标注或重复下载。stop暂停渲染，动画时间当前为实例墙钟，恢复时相位会追上当前时间；尚未提供暂停时间轴或动画完成事件。

## 4.3 当前项目调试、显示地表拾取与基础鼠标绘制（2026-10-10）

引擎根目录index.html也有测试入口，不只独立SDK demo。CMD：

```bat
cd /d E:\SpringAndAutumnGIS\SpringAndAutumnGIS
npm run dev
```

打开终端实际地址的/index.html。此源码页依赖Vite转换TS，不能通过file://或Live Server直接运行；引擎dist仍只输出库，不改成网站。独立应用继续安装dist/tgz并用自身dev/preview。

顶部“测试点线面”打开完整面板，默认加入四类示例；里面有明确的“绘制点／绘制折线／绘制面／绘制标注”按钮，不是只勾选单击加点。顶部“拾取调试”打开诊断面板，不强制定位。永远村和行政区GeoJSON快捷定位收进“业务图层”面板，数据源不删除；独立demo重复的旧合成GeoJSON点线面示例已移除。

```js
viewer.draw.start({ type: 'polyline', id: 'route-from-mouse',
  symbol: { color: '#00ffff', width: 4, occlusion: 'overlay' }, pick: { mode: 'surface' } });
// 逐点点击地图，鼠标移动时有线段预览；至少两点后：
const line = viewer.draw.finish(); // 加入同一个viewer.entities，返回只读快照
viewer.draw.start({ type: 'polygon', symbol: { color: '#32e6a1', opacity: 0.35, occlusion: 'overlay' } });
viewer.draw.undo(); // 撤销当前最后一个顶点
viewer.draw.cancel(); // 丢弃预览，不删除已提交对象
viewer.draw.start({ type: 'point', symbol: { icon: { url: './mylocation_up.png' }, occlusion: 'overlay' } });
// 点和标注单击自动提交；独立标注：type:'label', label:{text:'标注',occlusion:'overlay'}
const unsubscribe = viewer.draw.onChange(state => console.log(state.active, state.type, state.vertexCount, state.lastEntityId));
```

绘制开始时取消未完成飞行并暂停相机输入，完成/取消/销毁后恢复此前导航状态；Enter完成，Esc取消，Backspace/Ctrl+Z撤销顶点（输入框内不抢占编辑）。切换模式取消旧预览；非法自交面或顶点不足不会提交，保留当前会话供撤销/修正。当前鼠标上限1000顶点；面只绘外环，孔洞可通过实体update后加。符号和拾取配置在start时捕获，结束后可继续编辑。高级捕捉、顶点拖拽、Redo、触屏绘制、测量和持续贴地尚未实施。

鼠标绘制线/面在两个demo里默认选“置顶表达”，确保当前未持续贴地的阶段也能看清图形；完成后可改正常深度。API创建实体与未指定occlusion的draw仍默认正常深度。overlay是关闭指定对象材质的depthTest、保留depthWrite:false和既有绘制顺序；不修改经纬度/高程，不是伪造贴地。点与文字保留地球背面剔除和标注碰撞限制；线面采用保守包围体剔除，跨地平线的大图形并非逐像素精确遮挡。

```js
viewer.entities.update('station', {
  symbol: { occlusion: 'overlay' }, label: { occlusion: 'overlay' }
});
// 改回正常深度：occlusion:'depth'。独立文字在label上设置。
// 附属点标注未显式指定时继承点策略；显式label.occlusion可单独控制。
const rect = viewer.engine.renderer.domElement.getBoundingClientRect();
const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
const actual = viewer.pickPositionDetailed(screen); // 默认mode:'surface'
const reference = viewer.pickPositionDetailed(screen, { mode: 'ellipsoid' });
const fixed = viewer.pickPositionDetailed(screen, { mode: 'absolute-height', height: 1500 });
```

默认拾取使用当前base影像／原生矢量的实际显示地表三角网格，复现现有shader的DEM采样（线性/最近邻）、XYZ UV绑定、局部高精度路径、曲率和公共边ECEF覆盖。不是拿“最新下载DEM”改高度，也不是把椭球交点垂直抬升。无可用base网格时明确返回source:ellipsoid，天空/画布外返回null。不会为拾取额外请求DEM，不改变瓦片/地形LOD；CPU顶点缓存按几何/纹理版本失效，在查询时懒制作，不每帧扫描网格。高频拾取/BVH和独立有效地表接口仍需后续性能工作。

pickPositionDetailed提供position、source、tile、screen、reprojected、errorPixels、distance和viewDepth。诊断同时显示椭球对照；斜视时高度差会造成经纬度差，不能因“不看高度”就排除其影响。它是显示地图地表查询，不是建筑/模型/透明纹理任意深度缓冲拾取，也不是高度量测真值。拾取后顶点存绝对高度快照，DEM后续细化不自动改对象；测量与持续贴地需要后续明确高度参考及同代地表规则。

验证：npm run test:picking与npm run test:entities:browser。后者显式entitySmoke=1使用本地合成栅格/DEM，在root index验证单canvas、DPR=2、页面偏移、地形开/关、GPU点击点像素、折线/面绘制、撤销/取消/导航恢复、置顶与背面剔除；阻断外部请求，不用真实服务压测。受控点击回投约0.000001px，不证明所有实景服务配准或FPS已验收。普通URL不启用合成回退。

## 5. 用户资源与凭据

独立应用要求用户填写自己的token.json，缺少底图/DEM不启动普通地图；HTTP页面仍可显示配置提示。这是交互应用的约束，Viewer库本身仍允许不配置地形。

独立应用不再import token.json，不把Key嵌入JS。开发/preview通过应用自身的同源/token.json接口返回允许公开的配置，服务端字段剔除；build不自动发布配置。静态部署时显式运行应用npm run config:deploy，或部署自己管理的授权网关/配置。

发布只提供token.example.json、公开服务说明与资源申请教程。不分享维护者Key，不把OSM或云平台资源当成无限免费兜底。浏览器配置是公开数据，不是加密文件，只能放限制域名/权限/配额的客户端Key；服务端Secret必须留在后端。当前本机天地图曾返回429，不宣称真实服务权限/配额已验收成功。

## 6. 验证职责

- 引擎：npm test、npm run typecheck、npm run test:sdk、npm run test:entities；保持原有渲染回归。
- 独立应用：npm run build、npm run test:sdk、npm run test:sdk:browser，检查已安装dist、TS/JS交互、真实GPU填充/洞/文字/图标方向/线面滚动/透明度、资源隔离与销毁重建。
- SDK源码更新后显式build和sdk:update；日常应用启动只npm run dev或preview。
- 历史examples/sdk-consumer仅是旧测试资料，不再随包发布，也不是日常交互入口；以独立应用为准。
