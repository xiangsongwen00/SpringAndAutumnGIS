# SpringAndAutumnGIS SDK：阶段A

2026-10-08。公共初始化入口已实现；程序实体点线面、鼠标绘制及独立地形LOD不在本阶段承诺范围内。不是Cesium API兼容包。

## 安装与ES模块引入

当前尚未发布npm registry。先在引擎仓库运行：

```sh
npm pack
```

prepack会自动构建，引擎产物位于dist，tgz名称按当前package版本生成。然后在用户项目中安装实际生成的文件：

```sh
npm install ./spring-and-autumn-gis-0.1.0.tgz three@0.182.0
# TypeScript项目还需要Three的类型声明
npm install -D @types/three@0.182.0
```

```js
import { Viewer, TerrainRgbProvider } from 'spring-and-autumn-gis';

async function main() {
  const viewer = await Viewer.create('map', {
    basemaps: [
      { id: 'satellite', type: 'xyz', url: '/tiles/{z}/{x}/{y}.png',
        scheme: 'xyz', maxLevel: 20, levelOffset: -1.7 },
      { id: 'vector', type: 'vector-style', style: '/styles/my-style.json', symbols: true }
    ],
    baseMap: 'satellite',
    terrain: {
      provider: new TerrainRgbProvider({ id: 'dem', urlTemplates: ['/dem/{z}/{x}/{y}.png'] }),
      enabled: false
    },
    showLodGrid: false,
    initialView: { longitude: 106.49, latitude: 29.63, altitude: 12000 }
  });

  await viewer.setBaseMap('vector');
  viewer.setTerrainEnabled(true);
  viewer.setLodGridVisible(true);
  viewer.flyTo({ longitude: 106.55, latitude: 29.61, altitude: 1500, duration: 500 });
  // 页面卸载/组件销毁时调用；重复调用安全。
  // viewer.destroy();
  return viewer;
}
main().catch(console.error);
```

容器必须是有尺寸的HTMLElement，例如`<div id="map" style="width:100%;height:600px"></div>`。模板中的地址由应用部署，不是包内默认服务；数据、Style、token和跨域授权由应用提供。演示En/Enlabel/全国行政区数据不再随SDK打包。

## 初始化参数与行为

| 参数 | 行为 |
| --- | --- |
| container | DOM元素或元素id；无DOM/不存在元素明确报错 |
| basemaps | 独立底图清单，id非空且唯一 |
| baseMap | 缺省选择清单第一项；null为无底图；未知id报错 |
| terrain | false/缺省不配置DEM；或{provider, enabled}，enabled缺省true |
| showLodGrid | 缺省false；隐藏时跳过经纬网更新，不关闭地图LOD选择 |
| autoStart | 缺省true；false只创建配置，调用start后开始渲染 |
| signal | 可取消create中的配置加载；create完成后不再控制Viewer生命周期 |
| initialView | WGS84度与椭球高度米；纬度有效、数值有限、高度非负 |
| lod/raster/terrainLayer/navigation/onStats/onFramePerformance | 沿用低层GlobeEngine配置，详见类型声明 |

create成功表示配置已加载、对象可用，不表示视口内所有瓦片已下载/上传。实际进度通过onStats观察；底图配置加载失败与后续瓦片错误是不同阶段。

地形初始关闭时首帧不请求DEM；之后setTerrainEnabled(true)复用已配置provider。没有配置provider时开启会抛TERRAIN_UNAVAILABLE。本阶段不支持Viewer运行中更换DEM provider。

## 底图定义

- `type: 'xyz'`：url必须含{z}/{x}及{y}或{-y}，支持minLevel/maxLevel/levelOffset/attribution。scheme='tms'将{y}转换成{-y}；显式{-y}不会再反转一次。只改变请求行号，不改变纹理或几何南北方向。
- `type: 'provider'`：传入现有RasterTileProvider，可接入自行初始化的WMTS等。Viewer不调用借用provider的dispose；调用方管理其生命周期。每瓦片返回纹理由引擎层管理。
- `type: 'vector-style'`：style为Style v8对象或URL，支持sourceId、levelOffset、symbols及fetcher。使用现有GPU地表制图管线，不是Canvas兜底。symbols缺省true，独立有界注记通道order=10000；仍然是现有样式/点注记子集，不支持所有MapLibre特性。能力报告位于viewer.baseMap.capabilities。URL内部的相对资源保持现有加载器语义，建议应用提供可解析的绝对/同源资源地址。

setBaseMap(id)等待样式/能力/注记配置准备好后提交；最后一次有效请求生效，被取代请求抛ABORTED，配置失败保留原底图。不同类型均走同一入口，业务图层不删除。setBaseMap(null)移除底图。交接保证的是配置一致性，不是全视口高清纹理就绪；新底图瓦片可能先显示占位/祖先，瓦片网络失败不自动回滚配置。

异步切换需捕获Promise错误，尤其快速点击时的ABORTED。取消会释放Viewer拥有的GPU provider与注记资源；custom fetcher也应尊重传入signal。底图已提交后，每次瓦片fetch仍合并其请求signal，不会丢失逐瓦片取消。

## 方法与错误

`setBaseMap`、`setTerrainEnabled`、`setLodGridVisible`、`flyTo`、`getCameraViewState`、`start`、`stop`、`destroy`均已实现。

只读状态：`baseMap`（id/type/capabilities）、`terrainEnabled`、`lodGridVisible`、`isDestroyed`。`getBaseMaps()`返回清单快照。`engine`保留低层逃生口，可复用现有图层API；不要直接操作SDK的base图层或保留名称`__sdk_base_labels`，否则破坏其生命周期约束。

ViewerError带code：INVALID_OPTIONS、BASEMAP_LOAD_FAILED、ABORTED、TERRAIN_UNAVAILABLE、DESTROYED。公共加载错误不复制后端URL/token-bearing消息。destroy幂等；销毁后的变更/相机/启动调用拒绝。创建失败和取消清理已创建Viewer；底层WebGL/浏览器构造失败可能直接抛浏览器错误。

## 直接浏览器模块与CommonJS

ESM产物外置Three.js，不能把ES文件作为零依赖脚本直接丢进页面。无构建工具时需同时部署Three模块，并配置import map：

```html
<script type="importmap">
{"imports":{"three":"/vendor/three.module.js","three/webgpu":"/vendor/three.webgpu.js"}}
</script>
<script type="module">
import { Viewer } from '/sdk/spring-and-autumn-gis.es.js';
// 按上面的配置调用Viewer.create(...)
</script>
```

Three 0.182模块的相对依赖文件也需按原目录部署，推荐npm+应用构建工具。此路径的原生浏览器import-map部署尚未单独验收，已验收的是tgz安装后的ESM消费。

CommonJS入口改为.umd.cjs，`require('spring-and-autumn-gis')`导出已在独立安装中检查；Viewer本身仍需要浏览器DOM/WebGL，不是Node无头渲染器。旧手工引用.umd.js文件者需调整路径。

Worker由库构建内联；生产页面需要现代浏览器、WebGL及相应Worker/blob CSP许可。Worker被CSP禁用不在本阶段成功启动承诺内；可通过引擎provider诊断查看实际Worker状态。不得把本仓库开发代理当作生产跨域解决方案。

## 消费验收

```sh
npm test
npm run typecheck
npm run test:sdk
```

test:sdk自动构建打包、检查无demo数据泄露、将tgz安装到临时独立项目，进行严格TS检查(skipLibCheck=false)、生产Vite构建及Chrome浏览器运行，并检查真实矢量Worker、初始化/开关、XYZ/TMS、切换失败/竞争和销毁。还检查CommonJS导出。模板位于examples/sdk-consumer，只import安装包，不引用src或demo。它是验收fixture，内含自造瓦片/DEM/PBF，不是实际业务数据示例。

测试产物保留在输出的临时目录供检查；未执行npm publish或更改版本号。B阶段entities/点线面、C阶段交互绘制仍待实现。
