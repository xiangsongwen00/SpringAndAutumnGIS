# 当前开发回归脚本

2026-10-11清理后保留23个 `.mjs`。这些是开发/验收代码，不是引擎运行时模块，也不进入SDK发布包。旧临时消费者、手工探针、旧矢量页面浏览器驱动与一次性Git版本性能对照已移至archives。

## 保留的原因与入口

| 脚本 | 当前回归责任 | 入口 |
| --- | --- | --- |
| test-layer-management.mjs | 底图/业务层分离、目录与数据源、图层生命周期 | npm test / test:layers |
| test-tile-runtime.mjs | 请求状态、缓存、WMTS矩阵与服务映射 | npm test / test:runtime |
| test-raster-orientation.mjs | 纹理方向、南北行号及shader约束 | npm test / test:runtime |
| test-raster-continuity.mjs | 高清显示交接、引用保护、容量及公平调度 | npm test |
| test-vector-pipeline.mjs | PBF解码、样式、孔洞、XYZ/TMS、源上限 | npm test / test:vector |
| test-vector-performance.mjs | 矢量工作集、视口近景、缓存和稳定相机 | npm test |
| test-lod-visibility.mjs | 可见覆盖、地平线/视锥、背面排除与日期线 | npm test |
| test-lod-budget.mjs | 缩放预算、梯度、静止稳定性 | npm test |
| test-lod-mountain-detail.mjs | 山地俯仰近景误差，防止近处反被降级 | npm test |
| test-terrain-stitch.mjs | 公共接边函数与混合LOD实际几何边界 | npm test / test:terrain |
| test-terrain-dynamic.mjs | DEM分帧发布、无假高程、网格缓存与局部失效 | npm test |
| test-terrain-coverage.mjs | 仍在代码中的regional实验路径、父覆盖/一致提交/失败/超时 | npm test |
| test-terrain-priority.mjs | 现有共享/兼容路径与近景调度、Worker队列公平性 | npm test / test:terrain:priority |
| test-terrain-independent.mjs | 独立DEM选择、慢队列收敛、容量、源ID与影像网格分离 | npm test / test:terrain:independent |
| test-entities.mjs | 当前实体CRUD、符号、几何与生命周期 | npm test / test:entities |
| test-drawing-style.mjs | 绘制预设/活动会话、测量隔离和ID选中 | npm test / test:drawing |
| test-entity-ground.mjs | 点线面真实显示地表贴合、洞及更新 | test:ground |
| test-surface-picking.mjs | 当前地表射线/回投、高程、俯仰与精度 | test:picking |
| test-measurement-camera.mjs | 椭球测量、测量所有权与指南针/初始姿态 | test:measurement |
| test-polar-surface.mjs | 南北补圈几何、拾取、负高程与资源借用 | test:polar |
| test-polar-appearance.mjs | 不同底图极圈像素/样式、缓存、请求与失败 | test:polar:appearance |
| test-sdk-package.mjs | 实际dist的ESM/CJS/类型/文档与公开入口检查 | test:sdk |
| test-entity-demo-browser.mjs | 当前根index页面的真实浏览器/GPU、工具栏、绘制、拾取与测量 | test:entities:browser |

编写较早不等于历史废弃版。例如regionalCoverage:false不是删除regional实现；terrainLod:false仍可进入共享路径，这些回归不能在代码仍可被调用时直接删掉。未来真正移除对应公共/兼容能力后，再同步移除或重写测试。

## 执行方式与限制

- `npm test`会先构建，再运行表中标为npm test的项目，不包含全部浏览器/专项测试。
- 独立的test:*多数消费已有dist；修改引擎后先`npm run build`，不要把旧dist上的通过当新源码通过。
- Browser脚本自动创建本地Vite服务与隔离Chrome环境，使用受控数据，不是旧的手工固定调试端口探针；需Chrome，CHROME_PATH可覆盖路径。
- 独立网站/TS/ES6安装包消费回归位于E:\0-SpringGISNet，本仓库不再维护第二套消费者。
- 测试断言有作用域与数据限制，不代表真实第三方服务、完整山地轨迹或所有GPU设备验收。

本轮验证时发现用户工作区已删除THIRD_PARTY_NOTICES.txt，但vite.config.ts仍在generateBundle读取它；因此新构建被该删除阻塞。未擅自恢复，也未移除发布所需的版权声明插件。本轮保留脚本仅按现有dist验证，不能标为重新构建后的全通过。

验证结果：23份脚本语法检查通过；22份非浏览器回归消费现有dist全部通过；当前根页面的源码开发服务浏览器回归（地形开/关、真实图标/贴地/拾取/工具栏）通过。开发服务测试不需要生产generateBundle，不代表缺失版权输入的新生产构建已通过。

## 已移除的旧入口

`test:vector:browser`已从package.json删除：旧脚本默认指向已被用户删除的test/vector-orientation.html，并依赖旧页面状态/环境开关。其历史GPU/性能审计并非全部已由现行测试替代；未来需要时针对当前Viewer/页面API重新建立，不把失效入口留在日常命令里。

`benchmark-terrain-edges.mjs`是接边优化时的Git源码版本比较，默认HEAD对当前实现、固定180/350规模，仅打印计时、不带断言；作为历史诊断归档，而不是当前性能测试。ZIP恢复说明见 [archives说明](../archives/README.md)。
