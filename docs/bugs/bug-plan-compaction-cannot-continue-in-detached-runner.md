# Plan Compaction 后 Detached Runner 无法继续

## 现象

Plan child 在 `plan.created` 后成功写入真实 Pi `compaction` entry，但未继续 `plan_continue`，顶层 `pi-subagents` run 在首个 `agent_end` 直接结束。

## 影响范围

固定组合 Pi `0.80.6` + `pi-subagents@0.34.0` 下，运行中的 detached Plan Session 无法完成“手动 compaction 后继续到 validated”的真实链路。普通执行、领域事件 replay 和 Parent restart 不受影响。

## 复现步骤

在 Plan child 完成 `plan_open` 后，通过 `agent_end` 的 ExtensionContext 调用 `ctx.compact()`。session JSONL 出现位于 `plan.created` 之后的真实 `compaction`；随后 runner 记录 `subagent.run.completed`，compaction 完成回调或 `session_compact` follow-up 无法再启动新 turn。

## 根因

Pi 手动 compaction 是异步操作并会 abort 当前 agent operation；从 tool 内触发会自等待，从 `agent_end` 触发虽可成功落盘，但 `pi-subagents` 非交互 runner 已把该 `agent_end` 视为 step 完成并退出。compaction 期间旧 Extension context 失效，延迟回调再调用捕获的 `pi.sendMessage` 也会被 Pi 拒绝。

## 修复方案

当前固定上游没有安全的本仓内修复。需要 `pi-subagents` 在 pending compaction/follow-up 存在时延迟 step settled，或提供显式 sessionFile resume；本仓不得用解析 transcript、伪造 compaction entry或普通 spawn 新 session 替代。保留真实边界测试证明 custom event 未被 compaction 删除，并把“继续到 validated”标记为上游阻塞。

## 验证方式

当前兼容性测试断言 `plan.created → compaction` 顺序和 runner 可回收。上游能力可用后，将测试升级为 compaction 后继续原 session、执行 worker/Gates 并达到同一 `validatedHead`。
