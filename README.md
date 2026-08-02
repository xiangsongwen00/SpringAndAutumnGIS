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

## 运行

```bash
npm install
npm run dev
```

构建与类型检查：

```bash
npm run typecheck
npm run build
```

相机交互：

- 左键拖动：绕地球环绕，并保持当前斜视方向；
- 右键拖动：围绕当前地表焦点旋转视角，并限制在可恢复的倾角范围内；
- 中键拖动：围绕当前视线与地表的交点调整仰角；
- 滚轮：沿当前视线按真实离地高度缩放；
- `engine.flyTo({ longitude, latitude, altitude, heading, pitch, duration })`：执行可中断的镜头动画，`pitch=-90` 表示垂直俯视。
