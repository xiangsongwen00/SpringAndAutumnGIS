# SpringAndAutumnGIS

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

Esri 矢量底图当前使用 `levelOffset: -2`，但制图层级与球面叶节点解耦：整个视口统一使用 `floor(相机层级 - 2)` 作为最高数据/样式层级，再由更精细的球面几何通过 UV 裁切共享这些纹理。相机 5.1 级统一使用 Esri 3 级，相机 16.2 级统一使用 Esri 14 级。Google 卫星影像保持 `levelOffset: 0`，与球面 LOD 一一对应。

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
