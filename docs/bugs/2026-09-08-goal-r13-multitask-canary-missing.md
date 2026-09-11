# R13 三任务两轮 canary 缺口

## 问题

既有真实 RPC smoke 只覆盖单任务 `goal_init/status/dispatch/subagent` binding，不能证明 Runtime Goal 的三任务 DAG、受控 `NEEDS_CONTEXT` 失败处置与修订恢复、真实 RPC 用户批准、生产终审及两轮资源隔离。

## RED

在 `test/goal-runtime-real-canary.integration.mjs` 增加纯本地多轮 driver fixture：它要求每轮由 prompt response 到 `agent_settled` 驱动，限制 continuation，逐阶段 deadline，严格配对 toolCallId/result，处理 UI，失败 abort/finally cleanup，并拒绝 round 间复用 identity。初始执行因 driver 尚未定义而失败。

## GREEN 边界

只在 env-gated canary harness 中实现通用 driver 和 `PI_RUN_GOAL_R13_CANARY=1` 两轮真实 RPC case；复用既有 `JsonlRpcClient`、env、locator、parser。不得修改 production、伪造 child/provider/approval，真实失败 fail closed 且不进入第二轮。

## 首次真实执行结果

首次授权 round 于约 40.746 秒失败：root model 的 `goal_init` 首 attempt 返回 error，随后发生 retry；exactly-one policy 拒绝该序列。按 P4 约束未执行第二轮、未重试、未在真实执行中修复。该失败不构成 R13 通过证据。
