# Icon assets (2026-10-11)

Original image contents are unchanged; filenames/directories were translated.

| Original | Current |
| --- | --- |
| 初始视角-home.png | home.png |
| 图层管理.png | layers.png |
| 地图底图.png | basemap.png |
| 指南针.png | compass.png |
| 瓦片层级偏移.png | tile-offset.png |
| 绘图管理信息.png | entity-manager.png |
| 地形/地形 -开.png | terrain/terrain-on.png |
| 地形/地形-关.png | terrain/terrain-off.png |
| 测量/拾取点属性.png | measurement/inspect-point.png |
| 测量/测量面积.png | measurement/measure-area.png |
| 测量/距离测量.png | measurement/measure-distance.png |
| 要素/中间过程点.png | entities/vertex.png |
| 要素/点-红色.png | entities/point-red.png |
| 要素/点-蓝色.png | entities/point-blue.png |
| 要素/线.png | entities/polyline.png |
| 要素/面.png | entities/polygon.png |
| 要素/起点.png | entities/start-point.png |
| 要素/终点.png | entities/end-point.png |
| mylocation_up.png | location-up.png |
| Qianjin_left.png | direction-left.png |

ToolbarIcons.ts statically imports toolbar images; Vite library builds inline them.
Unused entity/vertex images remain available for later drawing expressions.
The existing public/mylocation_up.png and public/Qianjin_left.png are separate
consumer demonstration resources; their public URLs were not renamed.
