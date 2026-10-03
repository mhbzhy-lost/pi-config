# 主动 steer 无法向非 workspace subagent 插入文本（SUPERVISOR_INTENT_INVALID）

- 日期：2026-09-30
- 级别：P1（功能性，主动 steer 对一类 run 完全失效）
- 状态：已定位，修复中
- 报告来源：用户报告「旧仓 runtime 下主动 steer 无法向 subagent 插入文本」；新环境复现并定位

## 现象

主动 `subagent({action:"steer", runId, message})` 对 **coding worktree:false**（非
managed workspace）的 run 无法插入文本。steer 工具调用返回
`SUPERVISOR_INTENT_INVALID: Supervisor control request blocked.`，文本根本没到达
child 的 steering inbox（child 状态 `steering.requested: 0`）。

## 复现

`test/subagent-steer-text-insertion.integration.mjs`（真实 Host）：child 第一回合
`sleep 5` 保持存活，parent 运行中发 steer 注入标记文本。修复前：child 会话无注入
文本、第二回合走 FALLBACK、`steering.requested: 0`、steer 工具返回
`SUPERVISOR_INTENT_INVALID`。

## 根因（首个偏离点）

1. coding **worktree:false** run 的授权注册在 `extension.ts` executeCoding 的
   `onBinding` 内、`if (workspace)` 分支里（b332005 门控：仅 managed workspace 注册
   broker 授权）→ 非 workspace coding run **没有 owner receipt**。
2. steer 走 `extension.ts` executeControl 的 supervisor 控制面分支：
   `identityForRun(runId)` → `readOwnerReceipt(runId)` 返回 undefined →
   `owner?.rootSessionId` / `owner?.ownerGeneration` 为 undefined。
3. `supervisor-control-plane.ts` `parseSupervisorControlIntentV1` 要求
   `safeId(rootSessionId)` 与 `positive(ownerGeneration)`，二者 undefined → 抛错 →
   `resolveSupervisorControl` 返回 `blocked("SUPERVISOR_INTENT_INVALID")`。
4. steer 被拦在 `rpc.steer` 之前，文本无法投递。

## 数据来源分类

**类别 1（production 可达缺陷）**：steer 是真实生产控制动作；非 workspace coding run
是合法派发形态（generic/worktree:false）；owner receipt 缺失是 b332005 门控的正常
结果。三者叠加使「对非 workspace run 主动 steer」这一合法生产路径恒失败。

## 修复方向

supervisor 控制面的 steer 围栏针对 broker-owned run；非 owned run 的 supervisor
请求本就无法登记（registerSupervisorRequest 也要求 owner receipt），故对无 owner
receipt 的 run，steer 应**绕过控制面直接透传 rpc.steer**，由上游 steer 投递与
steerable 校验负责。这不放宽任何 broker-owned run 的安全边界。

## 验收

- 单测（membrane）：readOwnerReceipt 返回 undefined 的 run，steer 透传到 rpc.steer，
  不再 SUPERVISOR_INTENT_INVALID；broker-owned run 的既有围栏（REPLY_REQUIRED/
  STALE_OWNER/STEER_NOT_ALLOWED/DUPLICATES_REPLY）不回归。
- 集成（真实 Host）：steer 标记文本进入 child 会话并被消费（RECEIVED，非 FALLBACK）。
