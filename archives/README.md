# 历史诊断代码归档

## 第二批：历史矢量驱动与一次性接边计时

2026-10-11：`legacy-script-audits-20261011.zip`保存以下2个文件，逐项SHA256核验一致后从scripts移除：

- scripts/test-vector-browser.mjs：默认指向已经删除的test/vector-orientation.html；依赖旧页面状态与固定开发服务。取消package.json的test:vector:browser入口，不自动恢复用户删除的页面。其历史GPU/真实服务性能审计没有宣称全部已有替代。
- scripts/benchmark-terrain-edges.mjs：当时接边优化的Git版本计时对照，默认HEAD、固定180/350规模，没有断言、不属于日常回归。

其余23个当前回归按现存代码能力保留，职责/入口详 [scripts说明](../scripts/README.md)。此批只清理旧脚本，不处理用户另行删除的test文件、数据文档或版权声明文件。

## 第一批：旧消费者与手工探针

2026-10-11：`legacy-sdk-diagnostics-20261011.zip` 保存以下6个旧文件的相对路径。创建后逐项与原文件SHA256核对一致，才从原位置移除。

- examples/sdk-consumer/index.html
- examples/sdk-consumer/main.ts
- examples/sdk-consumer/package.json
- examples/sdk-consumer/tsconfig.json
- scripts/smoke-geojson-browser.mjs
- scripts/smoke-surface-overlay-browser.mjs

前4项为旧临时打包消费者，日常交互已由E:\0-SpringGISNet的TS/ES6页承担；后2项是依赖手工打开浏览器与固定CDP端口的临时探针，不由npm任务引用。本轮保留全部核心引擎自动化回归、当前源码浏览器测试、安装包检查和benchmark，不声称这两份探针的所有真实服务场景都已有等价自动测试。

ZIP不含token、node_modules、dist、配置好的资源、截图或用户数据，不进入SDK安装包。旧examples/sdk-consumer目录里另有被忽略的私有token.json，保留原位，没有读取、归档或删除；因此只清理旧代码，不递归删除该目录。当前.gitignore忽略*.zip，文件留在本机；如交付备份请显式携带此ZIP，不把它误认为已经发布或Git跟踪。

恢复前检查同名路径是否已存在，避免覆盖用户新文件。把ZIP解压到一个独立空目录先检查，再按上面的相对路径复制需要的文件到仓库；旧消费者无需恢复即可启动当前独立应用。保留历史设计/问题中的旧验收描述作为背景，不再提供旧模板作为当前入口。
