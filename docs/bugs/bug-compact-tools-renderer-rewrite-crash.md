# Bug：Compact Tools 渲染器批量改写后导致 Pi 崩溃

## 1. 现象

`compact-tools.ts` 在折叠模式可用后，为展开边界和 tool name 加粗进行批量修改；修改后 Pi 启动或渲染阶段崩溃。恢复旧版文件后 Pi 可再次运行。

## 2. 影响

Pi 交互界面不可用，用户只能手工移走或恢复扩展。由于改动同时覆盖多个 tool 的渲染函数，无法从现象判断是扩展加载失败还是某个 tool 的渲染回调失败。

## 3. 稳定复现

已知失败版本包含批量文本替换、统一 `expandedBlock`、`Container` 渲染和 tool name 加粗。恢复版不包含这些组合改动。失败版本已被用户移走，当前缺少原始 stderr，因此不能把崩溃单独归因于其中任一项。

## 4. 证据

Pi 源码中的内置 `read/edit/find/grep/ls/write` 均使用 `theme.fg("toolTitle", theme.bold("name"))`，说明加粗 API 本身合法。恢复版成功加载，说明原生 tool factory 与执行委托可用。上次修改未经过独立 renderer 测试，且一次改变了多个渲染契约。

## 5. 根因

直接根因是渲染器重写缺少可执行契约测试，并通过批量替换同时改变多个行为，导致无效组件、错误 fallback 或文件损坏都可能进入 Pi。现有证据不足以确认具体运行时异常；此前将崩溃归因于 `theme.bold` 属于未经验证的判断。

## 6. 修复与验证策略

先为 renderer 建立独立测试，覆盖 Pi 同款 tool title 样式、折叠摘要和展开边界，确认测试先失败。再用一个共享 renderer 模块重写 extension，执行仍委托给 Pi 原生 tool。最后运行单元测试和无交互扩展加载 smoke test；不再使用批量 `sed` 修改 TypeScript。
