# Bug：重复 async-started 使 terminal child 回退为 running

## 1. 现象

同一个 run 已经通过 `status.json` reconciliation 进入 terminal 状态后，如果 footer browser 再次收到重复或延迟的 `subagent:async-started`，`trackStarted()` 会删除原 run 并按初始事件重建 children。原本完成的 child 重新显示为 running。

## 2. 影响

完成历史会重新进入 active 区，main footer 的 `history N` 和 active child 展示错误；已从 status 获得的 `sessionFile`、`transcriptPath`、model、thinking、tokens、label 和 per-step terminal 状态全部丢失。删除并重新插入 Map 还会改变 active run 的稳定顺序。

## 3. 稳定复现

1. 对 `run-1` 调用 `trackStarted()`。
2. 通过 `reconcileRun()` 写入 `state: complete` 和 `sessionFile`。
3. 再次传入相同 `run-1` 的 started event。
4. snapshot 中 child 由 complete 变成 running，`sessionFile` 消失。

独立脚本已在当前实现上稳定复现该状态变化。

## 4. 证据

`trackStarted()` 当前无条件执行 `this.runs.delete(id)`，随后以 event 中有限的 `id/asyncDir/cwd/agents/sessionId` 创建新 children 并重新 `set()`。该路径没有检查既有 run，也没有复用 reconciliation 已确认的 child metadata。

现有 terminal immutability 测试只覆盖 delayed `reconcileRun(running)`，没有覆盖重复 started event。

## 5. 根因

started lifecycle 被实现成“替换 run”命令，而不是幂等的“确保 run 已被跟踪”事件。实现默认 started 对每个 run 只到达一次，未考虑 reload、事件重投或异步时序下重复/延迟交付。

## 6. 修复与验证策略

先增加失败测试，覆盖 terminal run 重复 started 后状态和 metadata 不变，以及 active multi-child run 重复 started 后顺序和已确认字段不变。最小修复应让同 ID 的 started event 幂等：既有 run 不被删除或重排，只允许补充缺失的安全 run-level metadata；不得覆盖 status reconciliation 的 child 事实。最后重跑全部 roster 测试和 round-trip/order/cap 回归。
