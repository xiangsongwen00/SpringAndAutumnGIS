# SDK首版接口与开发计划

日期：2026-10-02初始计划，2026-10-10更新。状态：A+B与C1基础鼠标绘制已实施，高级编辑/测量/持续贴地待实施。独立地形LOD本阶段搁置，保留现有渲染/影像连续性策略。

2026-10-10：按新增要求实现根index.html调试面板、viewer.draw.start/finish/undo/cancel/state/onChange、点/折线/面/标注独立模式、预览及导航冲突管理。修正“椭球拾取再强加1500米”的漂移路径；pickPosition默认显示地表网格，pickPositionDetailed提供来源/回投诊断，显式ellipsoid仍可对照。新增occlusion:depth/overlay，不改实际高程，置顶表达不等于贴地。现行API与边界以SDK使用说明§4.3为准；下文为历史草案，尤其原C待实施与椭球-only描述不再代表最新状态。

**B版当前实现：** viewer.entities统一管理point/polyline/polygon/label，支持add/getById/has/values/query/update/move/setVisibleById/setVisible/remove/clear/onChange。真实填充面与孔洞、屏幕像素宽线、屏幕朝向标注；viewer.pick选择对象，pickPosition仅参考椭球。公共字段是symbol、positions、holes，不是本页早期草案的style/rings；省略高度现为30米以帮助无地形时显示，仍是绝对高度而非贴地。具体运行示例、限制和错误码以[SDK使用说明§4.1](SDK使用说明.md#41-b版点线面与标注对象)及dist类型声明为准。下文保留早期评估供追溯，不将过时示意代码当作现行API。

2026-10-09验收范围：引擎原有影像/地形/矢量/XYZ-TMS回归、实体不可变快照/管理/非法环/孔洞/释放，以及E:\0-SpringGISNet安装dist后的严格TS、JS同步、浏览器GPU像素、控件及资源数量回归。使用合成测试避免压测真实服务；不以软件GPU测试宣称生产60FPS。未修改版本号、未发布npm，暂保持0.1.0本地候选。

2026-10-08进展：A已实现Viewer公共入口、初始化/开关、统一底图切换与安装包消费流程，实际用法以[SDK使用说明](SDK使用说明.md)和类型声明为准。本页后续接口仍含B/C待实现项（尤其entities），不能当作全部已可执行示例。独立tgz安装的严格TS/生产构建、真实Worker与浏览器生命周期验收通过；未发布npm registry，版本暂保留0.1.0。

## 1. 工作量判断与交付边界

仅包装初始化和开关较小；“可从安装包ES模块引入、底图类型统一切换、点线面绘制与生命周期可靠”整体中等偏大，不建议当成一轮小改动。建议分三批，每批独立验收。这里的估算按工作项/复杂度，不承诺未经实施验证的精确小时数。

| 批次 | 内容 | 复杂度 | 可交付结果 |
| --- | --- | --- | --- |
| A | SDK外观接口、初始化/开关、底图管理、ESM包清理与外部消费测试 | 中 | 外部项目可安装初始化、切换、销毁，不依赖demo/main.ts |
| B | 程序传坐标点/线/实心面、样式、实体管理、示例与回归 | 中 | 首个可用SDK版本，暂不贴地 |
| C | 鼠标绘制、椭球屏幕拾取、预览、完成/取消/撤销和相机冲突管理 | 中到高 | 交互绘制版；除非用户要求首版包含，否则后续交付 |

推荐首版范围=A+B。点线面“加入绘制”默认解释为程序传坐标添加；鼠标交互另外询问，未答复不把C暗中纳入首版。贴地暂不作为首版承诺，所有高度先采用椭球绝对高度；地形开启后，低于地形的对象可能被遮挡，这是高度语义，不通过关闭全场景深度测试伪装贴地。

## 2. 当前可复用部分与明确缺口

- `src/index.ts`已有大量exports；Vite库构建输出ESM/UMD，TypeScript声明亦存在，不需另建渲染引擎。
- `GlobeEngine`已有初始视角、imagery/terrain provider、相机导航、各类图层增删和dispose。缺统一面向用户的创建/错误/销毁语义、底图选择工厂和组合配置。
- `GlobeEngine.setImageryProvider`在初始化无imagery时只是可选调用，无后续创建能力；`setTerrainEnabled`在无provider时无法生成地形。这些不能用“开关方法存在”冒充完整生命周期，必须规定provider是否可后加及错误返回。
- `GlobeGridRenderer.object3d.visible`可隐藏，现有options没有正式visible初始化字段；隐藏时还要跳过grid.update工作，而非只是GPU不显示。此开关只管LOD经纬网诊断线，不关闭LOD选择。
- `GeoJsonLayer`支持点、线、Polygon/MultiPolygon边界。源码的Polygon只调用line，没有面填充；坐标第三维目前没有成为每顶点绝对高度。不能直接包装后宣称支持实心面/3D高度。
- 原生矢量桶中已有fill/line构建与高精度渲染逻辑，可评估复用，但必须与独立实体生命周期/绝对高度语义适配，不能直接依赖底图样式桶或公开Three内部mesh作为唯一用户接口。
- 当前没有独立screenToGeographic/pick、绘制状态机和撤销控制；交互绘制不属于给GeoJSON数组的薄包装。

## 3. 拟定公共接口（待实现，非Cesium兼容承诺）

继续保留`GlobeEngine`等低层导出，新增推荐高层`Viewer`。先统一通过`Viewer.create(container, options): Promise<Viewer>`处理异步样式/能力加载，字符串容器id及HTMLElement均支持。Cesium式使用体验不等于方法、坐标系统或行为与Cesium完全兼容。

```js
import { Viewer } from 'spring-and-autumn-gis';

// 拟定接口示意，当前版本尚不可直接运行。
const viewer = await Viewer.create('map', {
  basemaps: [
    { id: 'satellite', type: 'xyz', url: '/tiles/{z}/{x}/{y}.png', scheme: 'xyz' },
    { id: 'vector', type: 'vector-style', style: '/styles/Enlabel.json' }
  ],
  baseMap: 'satellite',
  terrain: { enabled: false, provider: myTerrainProvider },
  showLodGrid: false,
  initialView: { longitude: 106.49, latitude: 29.63, altitude: 12000 }
});

await viewer.setBaseMap('vector');
viewer.setTerrainEnabled(true);
viewer.setLodGridVisible(true);
const point = viewer.entities.add({
  id: 'station', type: 'point', position: [106.55, 29.61, 100],
  style: { color: '#ffcc00', size: 8 }
});
viewer.entities.add({
  id: 'route', type: 'polyline',
  positions: [[106.55, 29.61, 100], [106.56, 29.62, 150]],
  style: { color: '#00ffff', width: 3 }
});
viewer.entities.add({
  id: 'site', type: 'polygon',
  rings: [[[106.55, 29.61, 100], [106.56, 29.61, 100],
    [106.56, 29.62, 100], [106.55, 29.62, 100]]],
  style: { fillColor: '#33cc88', fillOpacity: 0.45, outlineColor: '#ffffff' }
});
viewer.entities.setVisible(point.id, false);
viewer.entities.remove('route');
viewer.entities.clear();
viewer.destroy();
```

### 初始化与开关契约

- 用户底图清单与默认id必须校验；未知id、重复id、空容器、无WebGL等错误明确抛出，不静默回落到另一底图。
- 数据源由用户提供URL/token/CORS配置，不附带demo令牌或默认依赖localhost服务。token不得写入公共错误消息/示例仓库。
- 首版至少支持XYZ/TMS栅格与Style v8矢量底图，其他已有provider可通过provider类型注入；WMTS可复用已有capabilities加载器。每种接入返回能力诊断，不宣称完整MapLibre样式兼容。
- 切换同/不同类型底图走一个入口，业务层不被删除；底图注记保持现有顶部注记约束。异步切换以最新请求为准，失败保留原底图，旧任务不准覆盖新结果；被取消任务、纹理与Worker正确释放。
- terrain.enabled=false+provider表示已配置但关闭，首帧不加载/启用DEM；开启复用provider。没配置provider时开启明确报错或显式通过设置provider方法完成，不做空调用。首版不强行支持运行中任意替换DEM，若纳入必须单独验收。
- showLodGrid=false为高层默认，低层原行为保持兼容；开关不影响地图内容LOD。
- create完成代表对象及必要配置已可用，不意味着全视口高清瓦片全部下载完成。事件/状态区分初始化ready、加载busy、错误和当前视口就绪。
- destroy幂等，停止RAF/ResizeObserver/事件监听、释放所有层与GPU资源；销毁后的变更调用明确拒绝。不要把共享provider缓存/Worker随意跨Viewer销毁。

### 实体与绘制契约

- 坐标统一WGS84经纬度（度）、椭球高度（米），默认height=0；不自动执行GCJ02/BD09转换。未来heightReference扩展absolute/relative-to-ground/clamp，当前仅absolute有承诺。
- entities提供add/get/update/remove/clear/setVisible；id稳定且重复报错。更新几何不能遗留旧GPU资源。首版可按实体/小批次渲染，不承诺十万实体效率；限制输入规模并给出错误。
- 点size和线width为CSS像素，处理DPR；宽线不能依赖跨平台不可靠的原生WebGL线宽。填充支持凹多边形、外环和洞，轮廓与填充可分别配置；不是“面=边界线”。
- 拒绝NaN/Infinity、不足顶点、非法纬度/高度、自交等不支持数据；重复闭合坐标规范化。巨大跨半球/跨日界线及极区面必须明确限制或专门处理，不静默错误三角化。首版优先城市/局部面。
- 点线面使用现有相机相对/高精度坐标路径，长线需细分以避免球内穿透；多边形大跨度曲面细分是填充验收项，不是只测一个小三角形。
- 程序添加与交互绘制使用同一实体描述结构。C阶段拟定draw.start(type)/finish/cancel/undo；天空点击返回null，不能拿固定高度假交点；绘制时明确暂停/恢复冲突的导航操作，取消清理预览层与监听。

## 4. ESM打包与独立消费验收

本轮`npm pack --dry-run --json`核对：压缩约6.0MB，解包约22.2MB，112条目，包含En/Enlabel约4.3MB以及全国省市县GeoJSON约16MB。这些是demo/test资产，应与引擎SDK分离。尚未发布npm包或修改版本。

- Vite库构建需避免默认复制public演示资产，输出目录/发布files明确；README、许可证、类型声明与必要Worker保留，数据/样式/服务地址由用户应用部署。
- `vite.config.ts`external了three，而package只在devDependencies列出three。应声明受支持的peerDependencies并给消费项目安装说明，或决定直接捆绑；推荐保持外置，避免应用多个Three实例。不能要求消费者偶然已有开发依赖才运行。
- 首版以ESM为承诺：`exports.import`与types路径匹配。现有type=module却用.umd.js作require目标，传统CommonJS兼容不能仅凭有UMD输出宣称；决定保留CJS时需.cjs产物及独立测试，否则先不承诺CJS。
- 浏览器直接`type=module`引入打包ES文件还需解决裸three导入（import map或应用构建）；与npm+Vite使用分别给示例，不混淆“ES6 import”与“零依赖单文件”。
- Worker当前使用Vite `?worker&inline`。独立包消费应验证Worker真实可用、URL部署与CSP blob策略；阻止Worker时反馈兼容降级，不能只测本仓库dev服务。
- 从实际tgz安装到独立临时消费项目，运行TS类型检查、生产构建和浏览器测试；页面只import包入口，不引用src、demo或本项目node_modules。打包检查不等于此消费验收已经通过。

## 5. 可执行顺序与验收门槛

1. 批次A：确定Viewer/配置/错误模型→底图生命周期与异步切换→初始化地形/grid开关→发布目录与peer依赖→独立消费者示例/测试。
2. 批次B：统一实体描述/集合→点和宽线绝对高度→面填充/洞/边界/曲面精度→更新删除释放→在已打包消费页面有地形/无地形各验收。首版示例按键添加、隐藏、删除即可，不冒充鼠标自由绘制。
3. 完成A+B后做v0.2.0候选（版本号待实施时确认），不是立即修改版本/发布；文档列支持范围与限制。C若用户不要求首版，则之后实施。

验收必须覆盖：初始化两种底图和无底图、不同底图互切及快速竞争/失败；关闭地形首帧零DEM请求且可开启；grid隐藏不更新；点线面实际GPU显示/高度/样式/遮挡；洞不填、自交错误；连续增删没有资源增长；destroy重入且无残留RAF；包安装后JS/TS和Worker都可运行。现有影像/地形/XYZ/TMS回归不退化。

## 6. 本轮结论

建议按A+B开发首个对外可用版，不先扩展地形独立LOD、贴地绘制、建筑拉伸、地形编辑或完整Cesium兼容。本轮只完成代码/包结构评估、干运行打包检查和计划，不改引擎行为、不宣称点线面SDK已经可用。
