# steer 控制面绕过：授权目标与上游投递目标不一致（B1）

- 日期：2026-09-30
- 级别：**P0（授权绕过）**
- 状态：已修复
- 引入者：本仓 `5039a40`（修复「非 workspace run 主动 steer 被控制面拦截」时引入）
- 发现者：astra reviewer 执行后验收审核 Blocker B1

## 背景

`5039a40` 为修复「无 broker owner receipt 的 run 主动 steer 被 `SUPERVISOR_INTENT_INVALID`
拦截」，在 `executeControl` 的 steer 分支加了「owner 缺失即绕过控制面直透 `rpc.steer`」。
功能缺陷确实修好了，但**放行条件建立在错误的目标解析与不可靠的 owner 查询之上**，
把功能缺陷换成了授权绕过。

## 根因（首个偏离点）

### 1. id / runId 优先级与上游相反

- 本层：`extension.ts` `const runId = params.runId ?? params.id;`
- 上游权威解析 `pi-subagents/src/runs/background/async-resume.js:161`：
  `const requestedId = assertRunId(params.id, "id") ?? assertRunId(params.runId, "runId");`
  —— **`id` 优先**。

传入 `id=<受管 run>`、`runId=<不存在的 run>` 时：本层对不存在的 run 查 owner → 查不到
→ 判定「非受管」→ 绕过全部围栏；上游却按 `id` steer 到**真实受管 run**。

### 2. dir 单独定位完全不经 owner 判定

`async-resume.js:163-171`：`params.dir` 存在时 `resolvedId = requestedId ?? path.basename(asyncDir)`。
仅传 `dir`（无 id/runId）时本层 `runId === undefined` → 不做任何 owner 查询 → 直接透传，
而上游已从目录名解析出真实 run。

### 3. 前缀形态 runId 会被上游扫描成另一个 run

`run-id-query.js`：`MIN_SAFE_ASYNC_RUN_PREFIX_LENGTH = 8`、`FULL_ASYNC_RUN_ID_LENGTH = 36`，
`canScanAsyncRunPrefix(id) = id.length >= 8 && id.length < 36`。
`async-resume.js:184-196`：精确路径不存在时对前缀做 `findAsyncRunPrefixMatches` 扫描解析。
本层用**前缀**查 owner（receipt 以完整 runId 为键）→ 查不到 → 绕过；上游扫描后 steer
到解析出的完整 run。

### 4. owner 查询异常被降级成「明确非受管」

`extensions/subagent-runtime.ts:313-325`：`readOwnerReceipt` 的 `catch` 与
`!brokerReady || !broker` 分支都 `return undefined`。于是「broker 读失败 / 未就绪」与
「确认无 owner receipt」在本层不可区分，前者被当成后者放行。
`supervisor-control-plane.ts:120` 的 `identityForRun` 只是透传该 undefined，无三态语义。

## 为什么上游检查不等价于本层围栏

上游 `steering` 路径确有目录约束、session 校验、运行状态与 pending-ask 检查，但**不包含**
本仓控制面合同的 `ownerGeneration` 世代校验、`SUPERVISOR_STALE_OWNER`、
`SUPERVISOR_REPLY_REQUIRED`、`STEER_DUPLICATES_REPLY` 与幂等投递回执。因此不能以
「上游会校验」为由声称 broker-owned run 围栏未被放宽。

## 数据来源分类

**类别 1（生产可达的授权缺陷）**：`id`/`runId`/`dir` 均为 `subagent` 工具 schema 公开字段
（`extension.ts:108-110`），任何调用方都可组合传入；broker 读失败与未就绪是真实运行态。
非测试制造数据。

## 修复设计

1. **规范化唯一目标后再授权**：新增 `canonicalSteerTarget(params)`，按上游优先级
   `id ?? runId` 取规范化目标；`id` 与 `runId` 同时存在且不一致 →
   `SUPERVISOR_STEER_TARGET_CONFLICT`；出现 `dir` → `SUPERVISOR_STEER_TARGET_ALIAS`；
   路径形态（绝对/含分隔符/`..`）→ `SUPERVISOR_STEER_TARGET_INVALID`；长度落在
   `[8,36)` 的前缀形态 → `SUPERVISOR_STEER_TARGET_AMBIGUOUS`；无目标 →
   `SUPERVISOR_STEER_TARGET_UNRESOLVED`。以上一律 fail-closed 拒绝，不投递。
2. **owner 查询改三态，并按错误码区分「确认非受管」与「无法确认」**：
   `identityForRun` 返回 `ownerState: "owned" | "unowned" | "unavailable"`。
   关键发现：`broker.readOwnerReceipt` 对未知 run **不返回 undefined，而是抛
   `code="unknown_run"`**（`root-broker-server.ts:496-502` → `authority-store.ts:44`），
   因此「明确非受管」只能由该错误码权威认定：

   - `unknown_run` → `unowned`（允许透传）；
   - 依赖缺失、`authority_store_unavailable`、`authority_lock_contention`、
     `cas_conflict`、`revoked`、`unsupported_layout`、无 code 的未知错误 →
     `unavailable` → `SUPERVISOR_OWNER_UNAVAILABLE` 拒绝。

   只有 `unowned` 才绕过控制面，`unavailable` 一律 fail-closed。
3. **接线层不再吞异常**：`subagent-runtime.ts` 的 `readOwnerReceipt` 在 broker 未就绪时抛
   `code="authority_store_unavailable"`（刻意不用 `unknown_run`，避免被误归为非受管），
   读取失败不再 `catch → undefined`。`resolveSupervisorControl` /
   `registerSupervisorRequest` 内部改为经三态读取，保持原有
   `SUPERVISOR_STALE_OWNER` / `SUPERVISOR_OWNER_UNAVAILABLE` 语义不变（不回归）。
4. **授权与投递使用同一 runId**：控制面 intent 的 `runId` 改用规范化目标，消除
   「授权 A、投递 B」。

## 验收

- 新增 7 条负向回归全部 RED→GREEN：id/runId 冲突、dir 别名、前缀形态、owner 查询抛异常、
  owner 依赖缺失、以及 5 种 broker 存储类错误码 —— 均被拒绝且 `rpc.steer` **零调用**。
- 3 条正向对照不回归：`readOwnerReceipt` 返回 undefined、以及抛 `unknown_run` 的精确
  runId 仍透传投递（原 `5039a40` 缺陷修复保持有效）；受管精确 runId（id 与 runId
  同值）仍走控制面并成功投递一次。
- **真实 Host 集成回归**：`test/subagent-steer-text-insertion.integration.mjs` 1/1 通过
  （steer 标记文本仍真正插入 child 会话并被消费）。中途曾一度因未区分 `unknown_run`
  而回归失败（`SUPERVISOR_OWNER_UNAVAILABLE`、`steerIssued:false`），已按错误码分类修正。
- 既有围栏用例不回归：`SUPERVISOR_REPLY_REQUIRED`、`SUPERVISOR_STALE_OWNER`、
  `SUPERVISOR_REQUEST_EXPIRED`、`SUPERVISOR_REQUEST_NOT_PENDING`、幂等回执。
- membrane **78/78** 绿；`npm test` 全量无回归；typecheck:root 与
  typecheck:subagents-enhanced 均通过。

## 已知边界（需明示）

1. `readOwnerReceipt` 将 **revoked / supersededTo** 也报为 `unknown_run`
   （`root-broker-server.ts:499`），因此已撤销/已被接管的旧 run 在本层会被归为
   `unowned` 而可透传。此时控制面已无 `ownerGeneration` 可校，STALE_OWNER 围栏本身
   亦无意义；实际投递仍受上游运行态与 steerable 校验约束。若要对 revoked 严格
   fail-closed，需 broker 提供可区分 `revoked` 与 `unknown_run` 的读取语义。
2. `supervisorControlPlane.enabled()` 为 false（broker 未就绪）时，steer 整体不走控制面
   ——这是 `5039a40` 之前的既有设计，不属本次引入，但意味着「broker 未就绪窗口内的
   steer 不受本仓围栏保护」。已记为后续观察项，需单独评估是否应在该窗口内 fail-closed。
