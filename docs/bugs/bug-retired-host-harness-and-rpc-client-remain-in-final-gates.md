# 已退役 Host Harness 与孤立 RPC client 仍进入最终门禁

## 1. 现象

`test/plan-parallel-harness.integration.mjs` 与 `test/plan-amendment-harness.integration.mjs` 仍导入已经删除的 `plan-host-runtime.mjs`，`package.json` 的 `test:plan-harness` 仍指向旧 parallel Harness。同时，`scripts/lib/subagents-rpc-client.mjs` 只被自身单元测试引用，却仍作为可见 runtime 模块保留。

## 2. 影响

标准 Harness 脚本在模块加载阶段失败，最终测试矩阵仍把 Standalone Host 和 shared event-bus RPC 误表示为受支持架构。孤立 client 还会与当前 typed dispatch client、Root broker 两条有效控制面形成第三个名称相近但无调用方的接口。

## 3. 时间线

- flat Root runtime 已替代 Standalone Host，并删除 `scripts/lib/plan/plan-host-runtime.mjs`。
- 双 Plan flat Harness 已覆盖并行 Executor、Attention、multi-generation continuation 与 Root graceful close。
- 旧 parallel/amendment Harness 和 package script 未随 Host 删除完成迁移。
- repo-local 调用图确认旧 RPC client 只有 `test/subagents-rpc-client.test.mjs` 一个真实入边。

## 4. 根因

Host 退役按生产模块、控制协议和 Harness 分阶段推进，最终 Harness/package 清理未纳入同一静态迁移门禁。旧 RPC client 的自测又让“文件存在”持续自证，掩盖了生产调用方已经归零的事实。

## 5. 触发条件

运行 `npm run test:plan-harness`，或仅凭仓库文件与测试名判断支持拓扑；也会在全仓搜索 Standalone Host、`subagents-rpc-client.mjs` 等退役标识时暴露。

## 6. 修复与验证

由 flat Root Harness supersede parallel Host Harness，把仍有价值的纯 `pi-plan.v3` fixture 合同迁到普通单元测试；amendment 独有崩溃恢复场景完成 flat 迁移后移除其 Host 依赖。删除无调用方的旧 RPC client 及自测，保留独立的 upstream compatibility probe 和 typed dispatch client。迁移测试必须在实现删除前先证明旧文件、旧 imports 和过期 package script 仍存在，并在 GREEN 后对 `scripts/`、`pi/`、`test/`、`package.json` 执行精确零引用门禁。
