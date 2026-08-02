# SpringAndAutumnGIS

从底层重构中的轻量 3D GIS 内核。当前实现 **WGS84 三维经纬网 LOD** 和可替换的 Web Mercator XYZ 影像瓦片层。

## 当前架构

- `Ellipsoid`：WGS84 经纬度到地心笛卡尔坐标。
- `CoordinateTransform`：WGS84、引擎世界坐标、Web Mercator 和 XYZ Tile 的 CPU 权威转换关系。
- `GeographicTilingScheme` / `WebMercatorTilingScheme`：可替换的四叉树空间划分。
- `GlobeLodSelector`：基于屏幕像素尺寸、精确地平线/视口裁剪和迟滞阈值选择叶节点。
- `GlobeGridRenderer`：把叶节点批量生成为单次 draw call 的经纬网线。
- `RasterTileLayer`：按可见叶节点调度纹理，支持祖先瓦片回退、并发限制和 LRU 内存缓存。
- `GlobeEngine`：负责渲染循环、相机和生命周期。

LOD 选择器不依赖瓦片纹理、网络请求或缓存；影像层消费同一份 `SelectedTile[]`。网格与影像顶点只保存参数坐标，经纬度到 WGS84 椭球顶点的转换在 GPU 顶点着色器中完成，并使用相对相机坐标降低大地坐标精度损失。

演示的经纬网使用 `2–27` 级 LOD；相机超出范围时会自动限制回对应的边界高度。Google 卫星影像保持到 20 级，20 级以后使用祖先纹理回退，经纬网与后续 MVT/MBTiles 矢量瓦片仍可继续细分到 27 级。实际显示层级由屏幕空间误差、视口范围和可见瓦片预算共同决定。相机导航按照当前方向的真实椭球离地高度动态调整旋转与缩放速度。

`public/En.json` 是 Mapbox Style v8 样式，当前包含一个 Esri MVT 数据源和 913 个样式图层，后续矢量瓦片渲染器可直接以它作为样式解析测试入口。

Esri 矢量底图当前使用 `levelOffset: -2` 与球面 LOD 对齐：球面 LOD 16 请求 Esri 14 级瓦片，并通过子瓦片 UV 自动选取父纹理的对应十六分之一区域。Google 卫星影像保持 `levelOffset: 0`，与球面 LOD 一一对应。

演示使用仓库原先配置的 Google 卫星 URL 模板。生产环境应改用 Google Map Tiles API 的正式 Key + Session 接口，动态展示数据署名，并遵守服务的缓存和使用政策。

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
