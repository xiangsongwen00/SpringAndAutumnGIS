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

内部统一XYZ；scheme:tms只转换请求行号，显式{-y}不重复翻转，不改纹理/几何南北方向。借用Provider由调用方管理，Viewer创建的矢量Provider由Viewer释放。矢量是现有GPU地表管线与简化独立注记子集，不是完整MapLibre兼容实现；能力报告见baseMap.capabilities。GeoJSON面目前为边界，不冒充填充面。entities、交互绘制、独立地形LOD尚未实现。

## 5. 用户资源与凭据

独立应用要求用户填写自己的token.json，缺少底图/DEM不启动普通地图；HTTP页面仍可显示配置提示。这是交互应用的约束，Viewer库本身仍允许不配置地形。

独立应用不再import token.json，不把Key嵌入JS。开发/preview通过应用自身的同源/token.json接口返回允许公开的配置，服务端字段剔除；build不自动发布配置。静态部署时显式运行应用npm run config:deploy，或部署自己管理的授权网关/配置。

发布只提供token.example.json、公开服务说明与资源申请教程。不分享维护者Key，不把OSM或云平台资源当成无限免费兜底。浏览器配置是公开数据，不是加密文件，只能放限制域名/权限/配额的客户端Key；服务端Secret必须留在后端。当前本机天地图曾返回429，不宣称真实服务权限/配额已验收成功。

## 6. 验证职责

- 引擎：npm test、npm run typecheck、npm run test:sdk；保持原有渲染回归。
- 独立应用：npm run build、npm run test:sdk、npm run test:sdk:browser，检查已安装dist、TS/JS交互、Worker、资源隔离与销毁重建。
- SDK源码更新后显式build和sdk:update；日常应用启动只npm run dev或preview。
- 历史examples/sdk-consumer仅是旧测试资料，不再随包发布，也不是日常交互入口；以独立应用为准。
