# Plan Launcher 错把 Session File 视为 async spawn 返回字段

## 现象

真实 `pi-subagents@0.34.0` async spawn 只在 `details` 返回 `runId/asyncDir`；`sessionFile` 要等 `<asyncDir>/status.json` 初始化后才出现。Launcher 却读取 `details.results[0].sessionFile`，因此拒绝真实返回为 incomplete handle。

## 影响范围

`/plan-run` 在真实 stable RPC 上必然失败并尝试 rollback，Parent 无法持久化 handle；单元测试因伪造了同步 results 而未发现。

## 复现步骤

使用真实 Pi 与 stable RPC 启动 async Plan Runner。spawn reply 含 `details.runId` 和 `details.asyncDir`，不含 `details.results`；稍后 async status artifact 顶层出现 `sessionFile`。当前 Launcher 抛 `Plan runner returned an incomplete lifecycle handle`。

## 根因

Task 12 fixture 混用了 foreground structured result 与 async dispatch/status 两种 shape，没有复用已存在的 `pi-subagents-runtime.integration.mjs` contract。

## 修复方案

Launcher 接受 spawn reply 的 `runId/asyncDir`，随后有界轮询该 run 的稳定 status artifact，读取匹配 runId 的 non-empty `sessionFile` 后再持久化完整 handle。timeout、runId偏离或 malformed artifact均 fail-closed并保留 workspace证据。

## 验证方式

单测使用不含 results 的真实 async reply，延迟提供 status sessionFile；真实 Plan E2E 断言 handle七字段并推进到 child lifecycle。
