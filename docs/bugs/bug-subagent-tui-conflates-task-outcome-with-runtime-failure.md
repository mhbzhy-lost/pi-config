# Bug：subagent TUI 将业务结论误报为运行失败

## 现象
当 subagent 正常返回 TDD tests-only RED、`NEEDS_CONTEXT`、无法完成或 acceptance 未满足的报告时，TUI 显示红色 `✗ failed`。

## 影响
用户会把可继续处理的业务结论误判为 harness/runtime 故障，且 grouped 通知中的 child 结论可能被整组状态覆盖。

## 根因
pi-subagents 将 acceptance rejection、非零业务结论和运行故障折叠为 official `failed`；项目的 classifier 曾错误读取 completion 顶层字段，而真实可见报告及 `outputState`、acceptance、protocol/process 字段嵌套在 `results[]` child 中。compact renderer 又将缺少 presentation metadata 的所有 `failed` 直接映射为红色 `✗`，没有保留独立的展示投影。

## 触发条件
completion event 顶层只有 `state`、`success`、`summary`，而每个 normalized child 在 `results[]` 中携带 `status`（`completed`/`failed`/`paused`/`stopped` 等）、兼容旧 `state`、`success`、`outputState: "present"`、`summary`、`acceptance.status`、`protocolError`、`processSignal`、`timedOut` 等字段；或 raw lifecycle 为 failed/rejected 但没有机械运行故障证据。

## 修复方案
presentation classifier 逐 child 读取真实嵌套 payload（优先 `status`，兼容 `state`），并将 parent 的结构化限额/暂停/停止/机械故障与 child projection 稳定归并；browser 按 child index 投影并保留原始 child lifecycle/status，不改写 upstream raw 字段。只有 `protocolError`、非预期 process signal，或明确 `outputState: "absent"` 加运行 error 等肯定机械证据才能显示红色 `runtime-failed`。`outputState: "present"` 才是可用报告；acceptance rejected 和业务未满足为 `reported`，并且只在 output、summary、content 中精确识别 `NEEDS_CONTEXT` token。限额、暂停、停止独立显示；legacy/raw failed 无结构证据保守显示 `reported`。

## 验证与预防
用真实 `results[]` payload 测试覆盖 TDD RED、acceptance rejection、`NEEDS_CONTEXT`、限额和明确 runtime 故障，以及 grouped child index 对齐和旧 persistence hydrate；后续 TUI 仅消费 presentation 字段而不改写 upstream state。
