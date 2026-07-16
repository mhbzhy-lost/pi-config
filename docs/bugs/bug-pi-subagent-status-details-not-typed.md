# Bug：兼容性测试假设 status RPC details 包含 runId

## 1. 现象

stable status RPC 已成功返回正在运行的目标 run，但测试读取 `report.status.details.runId` 得到 undefined。

## 2. 影响

测试会把真实可用的 status method 误报为失败；若控制面依赖该字段，会错误建立 task/run binding，或被迫解析 status 的格式化 text。

## 3. 稳定复现

保持 Pi RPC stdin 到 notify 后运行 status 集成测试。返回数据中 spawn details 有 `runId/asyncDir`，status data 有格式化 text 和 `{details:{mode:"single",results:[]}}`，但没有 typed runId。

## 4. 证据

`pi-subagents@0.34.0` 的 RPC status 复用普通 control action，并通过 `dataFromToolResult()` 返回 tool result 的 text/details。真实 reply 与前期源码调查一致：核心 status 仍在 text 中，details 不保证完整 typed projection；权威 runId/state 位于 `<asyncDir>/status.json`。

## 5. 根因

测试把 stable RPC envelope 的机器可读性误解成 status payload 所有字段都 typed，进而猜测 `details.runId`。方案已明确禁止解析格式化 text，却没有在测试中坚持 artifact 为 lifecycle SSOT 的边界。

## 6. 修复与验证策略

保留当前真实失败作为 RED。status RPC 只断言调用成功、无 `isError` 且 mode 合法；目标绑定使用先前 spawn 的 `runId/asyncDir`，随后读取该 asyncDir 的 `status.json` 并断言 artifact runId 相等。等待 run 终态后再清理临时 package，不解析 `status.text`。
