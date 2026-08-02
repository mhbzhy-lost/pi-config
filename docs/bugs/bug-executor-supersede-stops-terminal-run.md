# Bug: supersede 对已 terminal run 重复 stop

## 症状
backend `terminalProof()` 无条件先调用 `rpc.stop()`，再读取 authoritative status；即使 recovered succeeded/validated run 已是 complete/failed/paused/stopped 也会 stop。

## 影响
upstream 对已完成 run 的 stop 可能拒绝，导致本可直接验证的 supersede cleanup 永久失败；同时制造无意义副作用，违背 succeeded/validated 只验证 terminal proof 的合同。

## 复现
注入 recovered binding 和 stable status state=complete，让 rpc.stop 抛 already-terminal；当前 supersede 在读取 status 前失败。

## 根因
backend 把“取得 terminal proof”实现为“先发 cancel 再轮询”，没有区分已终态 reconciliation 与仍运行 cancellation。

## 修复
supersede 首先读取并校验一次 authoritative artifact；若已 terminal 直接返回确定性 proof且不 stop。missing/transient/nonterminal 才幂等 stop，随后有界轮询。binding mismatch 仍立即失败。

## 验证
新增 recovered complete/failed/paused/stopped 各自 zero-stop proof；running/stopping 仍 exactly-one stop；terminal read 的 binding mismatch fail closed；既有 late-start cancel 回归通过。
