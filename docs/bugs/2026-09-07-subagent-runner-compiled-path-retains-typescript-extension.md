# Subagent 编译运行时保留 `.ts` runner 路径

## 现象

执行 `npm run setup:subagent-runtime` 并重启 Pi 后，`subagent` 仍无法启动后台 runner。stale-run reconciliation 报告：

```text
Cannot find module 'packages/pi-subagents-enhanced/node_modules/pi-subagents/node-runtime/src/runs/background/subagent-runner.ts'
```

实际编译目录中存在 `subagent-runner.js`，不存在 `subagent-runner.ts`。修复该入口并由 fresh Host 重试后，runner 继续暴露同类路径：`node-runtime/src/runs/shared/pi-args.js` 仍指向不存在的 `subagent-prompt-runtime.ts`；同一 production 源码还包含 `fanout-child.ts` 与 `fast-mode-extension.ts` 动态 extension 路径。对应 `.js` 编译产物均存在。

## 数据来源与分类

这是“预期 production 数据未被正确处理”：

1. 用户通过公开 `npm run setup:subagent-runtime` 安装并编译固定的 `pi-subagents@0.62.0`。
2. `scripts/setup-subagent-runtime-deps.ts` 调用 package 的 `setup:runtime`。
3. `packages/pi-subagents-enhanced/scripts/setup-runtime-deps.ts` 调用 `applyOrderedModelsRuntimePatch`。
4. `buildNodeRuntime` 使用 TypeScript `rewriteRelativeImportExtensions` 生成 `node-runtime/**/*.js`。
5. upstream `src/runs/background/async-execution.ts` 使用运行时字符串 `"subagent-runner.ts"` 构造 runner 路径；`src/runs/shared/pi-args.ts` 同样使用三个 `.ts` 字符串构造 child extension 路径。这些字符串都不是 import specifier，TypeScript 不会重写。
6. 编译后的 `node-runtime/src/runs/background/async-execution.js` 与 `node-runtime/src/runs/shared/pi-args.js` 仍通过 jiti/Node 解析不存在的 `.ts` 文件，导致 runner 或 child extension 启动失败。

该输入来自固定 upstream production 源码和公开安装入口，不是测试 fixture 污染。

## 首个偏离点

首个偏离点位于 `buildNodeRuntime` 的编译产物适配边界：代码假设 `rewriteRelativeImportExtensions` 会覆盖所有 `.ts` 路径，但动态 runner 文件名不是 import，因此需要显式、版本锁定且可验证的 runtime path patch。

## 修复约束

- 不恢复 node_modules TypeScript type stripping，也不复制 `.ts` runner 到编译目录。
- 在固定 `pi-subagents@0.62.0` patch/build 流程中，将编译产物中的 runner 与三个内建 child extension 动态路径投影为 `.js`，并对每个固定 anchor 和 marker 做严格校验。
- package verifier 必须检查 `subagent-runner.js`、`subagent-prompt-runtime.js`、`fanout-child.js` 与 `fast-mode-extension.js` 存在，且对应编译模块不再引用这些 `.ts` 路径。
- 不放宽固定版本门禁，不修改 upstream package 之外的 runner 启动语义。
