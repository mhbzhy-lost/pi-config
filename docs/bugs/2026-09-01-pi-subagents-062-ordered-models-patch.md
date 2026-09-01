# pi-subagents 0.62.0 ordered-models 补丁迁移问题

## 现象

将项目运行时从 `pi-subagents@0.45.2` 升级到 `0.62.0` 后，ordered-models 的 tier 优先回归失败：显式选择 `pool/gpt-5.6-luna` 时，`direct/gpt-5.6-luna` 没有排在其他 tier 候选之前。

同时，直接从项目 `pi/npm` 的 jiti 导入 0.62.0 preflight 测试会因缺少 `@earendil-works/pi-coding-agent` peer 而报 `MODULE_NOT_FOUND`。

## 来源与分类

- tier 顺序异常属于预期 production source 未被正确处理：真实 npm registry 的 `pi-subagents@0.62.0` 已安装到项目 `pi/npm`，安装后补丁由 `scripts/setup-subagent-runtime-deps.mjs` 调用，真实 Pi 运行时会消费该源码。
- peer 缺失属于测试 harness 制造的非预期数据：测试绕过 Pi Host，直接从隔离 `pi/npm` 导入 upstream TypeScript；实际 `/opt/homebrew/bin/pi` 为 `0.84.4` 且可执行。该项只修测试 loader，不向 production 增加 peer fallback。

## 首个偏离点与调用链

### tier 顺序

`setup:subagent-runtime` 安装包后调用 `applyOrderedModelsRuntimePatch()`，补丁的 `execution()` 使用文件中的第一个 `scope` 字段添加 `prioritizePrimaryTier: true`。在 0.62.0 的 `preflight.ts` 和 `async-execution.ts` 中，第一个字段属于 `resolveEffectiveSubagentModel()`，不是后续的 `buildModelCandidates()` 调用，因此 tier 排序开关没有传入候选构建函数。

调用链为：安装精确包 → 安装后源码补丁 → `resolveSubagentLaunchContract()` → `buildModelCandidates()` → tier fallback 排序。

### peer 解析

测试文件直接使用 `pi/npm/node_modules/jiti` 导入 `preflight.ts` → `fork-context.ts` → `require.resolve('@earendil-works/pi-coding-agent')`，解析根不包含 Pi 全局模块。项目已有 `test/helpers/pi-host.mjs` 的真实 Pi Host alias，但该测试未使用它。

## 修复边界

- 让补丁精确定位 `buildModelCandidates()` 的 options，并在真实 0.62.0 的 preflight、background、foreground 调用中注入 tier 标志。
- 测试使用真实 Pi Host alias；无效 models 按 0.62.0 的 fail-closed diagnostics 行为断言。
- 不修改 Goal Engine，不增加 production fallback，不执行 Goal Engine 专用测试。
