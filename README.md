# SpringAndAutumnGIS

## SDK公共入口（阶段A）

2026-10-08新增`Viewer.create(container, options)`，支持统一XYZ/TMS/provider/Style v8底图选择与异步切换、首帧地形开关、LOD经纬网显隐及幂等销毁。低层GlobeEngine保留。用`npm pack`生成安装包，再在外部项目以ES模块import；目前未发布registry，点线面entities仍属阶段B，不要照计划文档当成已实现API。

完整接口、安装与行为边界见[SDK使用说明](./SDK使用说明.md)。本仓库只构建dist与验证库输出，`npm run test:sdk`不再安装临时消费者或启动服务。独立交互放在`E:\0-SpringGISNet`，以已安装SDK依赖提供TS/JS两种消费页面；普通使用只需该应用`npm run dev`或`npm run build && npm run preview`，不再用引擎demo:sdk启动。

从底层重构中的轻量 3D GIS 内核。当前实现 **WGS84 三维经纬网 LOD**、可替换的 Web Mercator 影像/矢量瓦片以及 Terrain-RGB 只读地形。

## 当前架构

- `Ellipsoid`：WGS84 经纬度到地心笛卡尔坐标。
- `CoordinateTransform`：WGS84、引擎世界坐标、Web Mercator 和 XYZ Tile 的 CPU 权威转换关系。
- `GeographicTilingScheme` / `WebMercatorTilingScheme`：可替换的四叉树空间划分。
- `GlobeLodSelector`：基于屏幕像素尺寸、精确地平线/视口裁剪和迟滞阈值选择叶节点。
- `GlobeGridRenderer`：把叶节点批量生成为单次 draw call 的经纬网线。
- `RasterTileLayer`：按可见叶节点调度纹理，支持祖先瓦片回退、并发限制和 LRU 内存缓存。
- `TerrainRgbProvider`：支持 TileJSON、URL 模板、XYZ/TMS 和 Mapbox/Terrarium RGB 高程解码。
- `TerrainTileLayer`：同时保留 CPU 高度场与 GPU 高度纹理，为地形表面、贴地图层、经纬网和高度查询提供统一高度。
- `GlobeCameraController`：地球专用相机交互，支持左键环绕、右键绕地表焦点旋转、中键地表仰角、沿视线缩放和可编程 `flyTo`。
- `GlobeEngine`：负责渲染循环、相机和生命周期。

LOD 选择器不依赖瓦片纹理、网络请求或缓存；影像层消费同一份 `SelectedTile[]`。网格与影像顶点只保存参数坐标，经纬度到 WGS84 椭球顶点的转换在 GPU 顶点着色器中完成，并使用相对相机坐标降低大地坐标精度损失。

演示的经纬网使用 `2–27` 级 LOD；相机超出范围时会自动限制回对应的边界高度。Google 卫星影像保持到 20 级，20 级以后使用祖先纹理回退，经纬网与后续 MVT/MBTiles 矢量瓦片仍可继续细分到 27 级。实际显示层级由屏幕空间误差、视口范围和可见瓦片预算共同决定。相机导航按照当前方向的真实椭球离地高度动态调整旋转与缩放速度。

`public/En.json` 是 Mapbox Style v8 样式，当前包含一个 Esri MVT 数据源和 913 个样式图层，后续矢量瓦片渲染器可直接以它作为样式解析测试入口。

## MVT 接入状态

当前可以开始接入 MVT，但能力需要按渲染模式区分：

| 能力 | 当前状态 | 产品含义 |
|---|---|---|
| URL template/TileJSON 请求与 PBF 解码 | 已有基础实现 | 本机 `china_admin` z0–z10 已验证可请求、可解码 |
| `draped-raster` | 已实现试验版 | `MvtRasterProvider` 接受 Style v8 URL/对象，把 MVT 栅格化后复用公共地形表面；可贴地、可换样式，但不是可编辑矢量 |
| `native-vector` | 试验子集 | `china_admin` 已走原生 GPU fill/line/circle、渐进地形采样和简化 symbol；尚缺 Worker Bucket、拾取、glyph/sprite 与完整 SymbolPass |
| `gpu-surface` | 地表初版 | `En.json` → MapLibre 样式编译 → Worker PBF 解码 → GPU fill/宽线/circle → 公共地形表面；不经过 Canvas，但地表合成仍使用纹理，独立注记尚未实现 |

首版样式自定义以 Mapbox Style v8 **受控子集**为边界：基础 background/fill/line/circle、`source-layer`、层级显隐、常用 filter/expression、颜色、透明度、线宽/虚线/端点连接和圆点样式。glyph/sprite、沿线文字、pattern/gradient、heatmap、hillshade、fill-extrusion 等不能静默忽略，接入界面必须显示“支持/降级/不支持”诊断。完整设计和实施顺序见 [`设计.md`](./设计.md#8-原生矢量瓦片渲染路线)，服务与层级样本见 [`测试数据.md`](./测试数据.md#4-localhost8085--china_admin-矢量瓦片)。

演示中 `public/En.json` 作为标准 Style v8 输入驱动“Esri 矢量底图（兼容栅格化）”，可与影像、WMTS 和普通栅格底图互斥切换；`china_admin` 使用 [`public/styles/china-admin-overlay.json`](./public/styles/china-admin-overlay.json) 进入原生 GPU 业务矢量通道，只在“业务图层”面板中叠加，不加入底图互斥组。原生通道当前覆盖基础 fill/line/circle/symbol 子集，复杂 Esri 底图仍保留 Canvas 兼容路径。库调用方也可以直接向 `MvtRasterProvider` 传入内联 `MapStyle`。

2026-09-30 新增“Esri 原生矢量底图（地表初版）”，可通过 `?baseLayer=esri-native-vector` 直接测试。它与业务原生通道共用官方样式编译、几何构建和 Worker 解码模块；业务通道已改用 GPU DEM 采样，但独立几何与公共地表的三角化完全一致仍未实现，不能据此宣称所有业务面都已无穿透。新底图地表选择复用已有公共地形网格，避免另建近共面 Mesh 的碎片遮挡。后续必须补独立 SymbolPass、完整线连接、FeatureIndex 和调度预算，不能把本版称为完整 MapLibre 渲染器。

方向契约：引擎内部统一 XYZ；`scheme: tms` 只把请求 `{y}` 转为 `2^z-1-y`；`{-y}` 始终是内部 XYZ 行号的反向值，不重复翻转。MVT 局部坐标始终左上原点、Y 向南；GPU 地表输出北侧位于纹理 Y=1，沿用公共地表 UV，禁止改变现有影像/DEM 方位来适配新通道。浏览器回归入口为 `/test/vector-orientation.html`，成功显示 `PASS`。

GPU地表初版已将网络数据上限与绘制层级分开：Esri PBF请求到z16，z19/20等高层级从父矢量重新按目标样式绘制，不放大旧纹理；显示上限默认27。源几何量化误差不会凭重绘消失。父PBF/解码去重缓存32MiB，制图默认每帧1张且可取消。地形明暗改用顶点梯度插值，统计增加CPU阶段、制图/接边峰值和draw calls；独立标注仍未接入，真实显卡性能未验收。

当前能力扫描结果：`En.json` 共 913 层，其中 212 层完整支持、701 层因 sprite icon、沿线文字等能力降级、0 层属于未知图层类型；这说明它可以作为兼容底图测试，但尚不等价于完整 Mapbox/ArcGIS 制图效果。`china_admin` 的 9 个自定义图层落在原生通道当前支持子集；注记只在目标数据层级参与视口碰撞，并受瓦片级和全视口预算限制，父级回退瓦片只保留点线面。

底图与业务 MVT 默认使用 `levelOffset: -1.7`，但数据层级与球面叶节点解耦：整个视口统一使用 `floor(相机层级 + levelOffset)` 作为最高数据/样式层级，再由更精细的球面几何复用相应内容。图层目录可显式覆盖该值，运行统计会显示实际数据层级，避免把相机 LOD 与源瓦片 z 混为一谈。

矢量模式通常把视口最低叶节点约束为“当前相机整数层级减 1”，避免卫星影像可接受、但矢量制图会产生样式断层的超大跨级混合。若极地或特殊角度触及瓦片预算，运行时会整体降低最低层级后重新选择，禁止输出跨越多级的半完成叶节点集合。标注在单瓦片内执行碰撞检测和边缘安全区过滤；跨瓦片的完整屏幕空间标注将在独立符号渲染层中继续实现。

演示启用 `showCountryLabels: true`，只覆盖样式中被隐藏的 `Admin0 point` 国家名称图层。符号碰撞按国家、争议区、省级、城市、水域的层次排序，使全球和国家尺度优先保留国家名称。

演示使用仓库原先配置的 Google 卫星 URL 模板。生产环境应改用 Google Map Tiles API 的正式 Key + Session 接口，动态展示数据署名，并遵守服务的缓存和使用政策。

地形演示从本地环境变量读取公开客户端凭据。复制 `.env.example` 为 `.env.local`，至少配置一个有效来源：

```bash
VITE_ENABLE_TERRAIN=true
VITE_MAPTILER_KEY=YOUR_PUBLIC_KEY
# 或
VITE_GEOVIS_TERRAIN_URL=https://example.com/terrain-rgb/{z}/{x}/{y}?token=YOUR_PUBLIC_TOKEN
VITE_GEOVIS_TERRAIN_SCHEME=xyz
```

不要在 Vite 前端配置 Mapbox `sk.*` 私密令牌；浏览器只能使用允许公开、并最好限制域名与额度的客户端凭据。当前地形阶段已实现高度解码、祖先回退、GPU 位移、贴图与经纬网随地形起伏；skirt、geomorph、真实地形法线边界融合和地形编辑仍属于下一阶段。

启用后可使用页面右上角的“定位珠峰地形/定位重庆地形”按钮切换测试区。珠峰用于检查高程解码、山脊位移和近地相机限制，重庆用于检查低起伏区域是否稳定贴合。地形数据层默认只提供高度纹理，不额外绘制重复调试网格；如需检查独立地形表面，可设置 `terrainLayer.showDebugSurface=true`。

## 运行

```bash
npm install
npm run dev
```

本机服务和业务测试数据见 [`测试数据.md`](./测试数据.md)。底图与业务图层在产品语义上严格分离：底图选择器只管理影像底图和“矢量渲染成栅格”的底图；GeoServer、永远村静态影像、MVT 和后续 GeoJSON 都进入独立的“业务图层”面板，以叠加方式显示，不参与 `basemap` 互斥组。

页面右上角提供两个独立入口：

- **业务图层**：打开图层控制面板，可分别启停业务图层并调整透明度。
- **测试永远村**：启用永远村正射影像并定位到其覆盖范围，不改变当前底图。
- **测试 GeoJSON**：加载省级边界并定位到全国视角；市、县边界可在业务图层面板中单独测试。

Vite 开发服务器会把 `/test/geoserver`、`/test/mapservice` 和 `/test/business-map` 转发到对应测试服务，避免服务未配置 CORS 时阻断浏览器测试；该代理不是生产部署方案。

## 统一瓦片运行时与 WMTS

- `TileStateMachine` 以 `sourceId/kind/z/x/y/variant` 为键，记录网络、解码、上传、ready、failed、expired 和 cancelled 生命周期，并提供祖先回退与四子完整替换判定。
- `RequestScheduler` 提供跨消费者去重、动态优先级、全局/同源并发限制、引用取消和按字节 LRU。新 Provider 不应再私建请求队列。
- `WmtsRasterProvider` 支持 WMTS 1.0.0 `GetCapabilities`、REST/KVP、Layer/Style/Format/TileMatrixSet 选择及服务声明的真实 TileMatrix 标识符。
- `LayerCollection` 的加载/错误统计属于临时 runtime 状态，不进入项目 JSON；`parseLayerCatalog` / `serializeLayerCatalog` 对导入项目进行交叉引用和范围校验。
- Raster/Terrain 请求按视线中心距离优先，同级再比较屏幕误差；离开视口的请求会被取消。切换底图时旧 Provider 不再占用新队列，并在新目标层级纹理就绪前保留旧清晰纹理，避免粗祖先纹理覆盖后长时间模糊。
- `GeoJsonSource + GeoJsonLayer` 提供业务测试链路：FeatureCollection 校验、要素数量保护、点/线及 Polygon/MultiPolygon 边界、显隐、透明度和资源释放。边界采用 GPU 经纬度投影避免与底图争深度，并支持按固定帧预算对去重顶点渐进采样地形；面填充、空间索引和拾取仍属于后续完整 Feature Runtime。
- WMTS 会执行服务声明的 `TileMatrixSetLimits`，范围外瓦片保持透明且不使用父级回退；透明图片/面业务层与底图共享同一地形位移面和深度基准，并使用预乘 Alpha、无 mipmap 的线性采样，避免覆盖边界黑带和地形视角下的三角形空洞。
- 系统底图注记使用独立最高合成顺序和更高表面偏移，始终绘制在 Raster/GeoJSON 业务图层之上。

构建与类型检查：

```bash
npm run typecheck
npm run build
npm run test:layers
npm run test:runtime
npm run test:terrain
```

相机交互：

- 左键拖动：绕地球环绕，并保持当前斜视方向；
- 右键拖动：围绕当前地表焦点旋转视角，并限制在可恢复的倾角范围内；
- 中键拖动：围绕当前视线与地表的交点调整仰角；
- 滚轮：沿当前视线按真实离地高度缩放；
- `engine.flyTo({ longitude, latitude, altitude, heading, pitch, duration })`：执行可中断的镜头动画，`pitch=-90` 表示垂直俯视。

矢量点注记性能试验（2026-10-01）：[带注记 Esri 底图](http://localhost:5180/?baseLayer=esri-native-labels&levelOffset=-1.0&longitude=106.5516&latitude=29.563&altitude=12000)，[同位置无注记对照](http://localhost:5180/?baseLayer=esri-native-vector&levelOffset=-1.0&longitude=106.5516&latitude=29.563&altitude=12000)。Enlabel.json 是原 En.json 的完整副本，独立点文字通道共享 PBF 缓存；当前显示最多64个点注记，尚无完整 glyph/SDF、图标和沿线文字。地形斜视 LOD 增加椭球地平线/有向盒细筛、演示上限350；MapTiler 网络上限改为 TileJSON 声明的15，显示 overzoom 不受该网络上限限制。验收方法和边界见《测试数据》§9、《设计》§16.7。
