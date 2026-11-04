# goal-runtime 可用性缺陷修复（①–⑤ + force-close）实现计划

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。只有整体交付终态全部验证通过，才算计划执行完成；未满足时持续修复与验证。执行方式由计划编写完成后的用户选择决定。

**目标：** 修复 2026-11-04 实测报告的全部五个阻塞缺陷（resume 血缘事实断裂、集成回执送达通道缺失、resume 交互反馈、cancel→replace 门死锁、内存态无清理出口），并提供 `/plan force-close` 与 `plan_force_close` 强制闭合能力，使异常路径下 agent 可重新绑定计划。

**架构：** 缺陷①+④走「goal 侧按 resume 血缘重绑 task.run 至最终 run」——血缘数据已在持久层（resume intents + workspace ledger），`PlanExecutionService` 增可选 `lineage` 查询（复用 host 侧 `resolveManagedResumeLineageOwner` 链解析先例），scheduler 三函数前置重绑；缺陷②走「durable 回执事件表 + 复用 D7 Host 泵 + `notifyExecutionFacts`」与 recovery intents 先例完全同构，goal 侧零改动；缺陷③⑤为 notify 修补、错误文案与 force-close 命令。

**技术栈：** TypeScript（Node ≥22.19.0 原生 type-stripping）、node:test（test/ 下 `.mjs`）、pi extension API（`pi.sendMessage`/`ctx.ui.notify`/`pi.appendEntry`）。

## 全局约束

- 仓库最低 Node 版本 `>=22.19.0`；production 代码一律 `.ts`；`.mjs` 仅用于 `test/` 下测试与 fixture。
- npm 只使用官方源 `https://registry.npmjs.org/`。
- `packages/pi-subagents-enhanced/extensions/` 是 Host 入口层：新函数紧邻既有同职责实现放置（`resolveManagedResumeLineageOwner` 先例即在该文件），不得新建全局 registry 或第二状态文件。
- TUI 精简边界：`ctx.ui.notify` 只做 UI 层人类可读投影，不得改写 agent 实际收到的消息、tool result 或 session 结构化 details。
- fail-closed 铁律：血缘解析失败/歧义/记录缺失一律维持现状 blocked 或返回 null，绝不降级为「找不到就当没发生」；superseded 判定只依据持久 resume intent 链 + workspace ledger 复核，绝不依据 blocker 文案。
- `sameRun` 身份校验（scheduler.ts:387）不得放宽；重绑只允许由持久血缘证据授权。
- 缺陷数据来源分类门禁：测试制造的异常数据不得触发 production 兼容分支（第 2 类只修测试）。
- 测试新增已获用户授权（2026-11-04「可以增加测试」），仅限本计划列明的测试文件与断言范围。
- 不得 git commit/push（未授权）；不得修改 `pi/settings.json`。
- **本计划不放置 goal-runtime.plan.v1 契约块**：修复对象是 goal-runtime 执行链本身（缺陷①②④正是 plan_execute 执行服务的事实链问题），用带缺陷引擎编排自身修复存在自指风险；执行走经典 Subagent-Driven 编排（本会话按 DAG 派发 + managed workspace 处置）。

## 输入来源

- 原始实测报告：`docs/investigations/2026-11-04-goal-runtime-usability-defects.md`
- 调研报告（行号级证据，实现以此为准）：
  - `docs/investigations/2026-11-04-goal-runtime-defect-1-4-resume-lineage-research.md`
  - `docs/investigations/2026-11-04-goal-runtime-defect-2-integration-receipt-channel-research.md`
  - `docs/investigations/2026-11-04-goal-runtime-defect-3-5-research.md`

## 整体交付终态

| ID | 必须成立的条件 | 验证方法与环境 | 通过判据 | 证据位置 | 覆盖任务 |
| --- | --- | --- | --- | --- | --- |
| F1 | 根仓与 pi-subagents-enhanced 类型检查通过 | `npm run typecheck`（本机，无网络） | exit 0 | 命令输出 | T1–T8 |
| F2 | 全量单元测试通过（含新增） | `npm test`（`node --test test/**/*.test.mjs`） | exit 0，新增测试文件全部被发现并 pass | 命令输出 | T1–T8 |
| F3 | goal-runtime 既有集成回归通过 | `node --test test/goal-runtime-runtime.integration.mjs test/goal-runtime-contract.test.mjs` | exit 0 | 命令输出 | T5, T6, T7, T8 |
| F4 | pi-subagents-enhanced package 测试通过（package 自有回归；T2/T3/T4 新增测试由 F2 覆盖） | `npm --prefix packages/pi-subagents-enhanced test` | exit 0 | 命令输出 | T1, T2, T3, T4 |
| F5 | 血缘重绑行为正确：旧 run 被 supersede 时 task.run 重绑最终 run、`supersededRunIds` 记录、`replaceCancelled` 门解锁、`retryTask` 可重绑；无血缘/解析失败时维持现状 blocked；sameRun 不放宽 | `node --test test/goal-runtime-lineage-rebind.test.mjs` | exit 0 且断言覆盖上述全部分支 | 测试文件 + 运行输出 | T2, T5 |
| F6 | 回执事件链路正确：队列终态锁内落盘且幂等、`queue.receipt-events` RPC 按 owner 过滤且只返回 pending、泵判定纯函数覆盖 notify/debt/delivered 分支、`recovery.status` 返回形状保持扁平数组不受影响 | `node --test test/integration-queue-receipt-events.test.mjs` | exit 0 且断言覆盖上述全部分支 | 测试文件 + 运行输出 | T3, T4 |
| F7 | force-close 行为正确：核实型（lineage+closed 全通过才闭合，否则拒绝并列原因）；盲闭合（置空 run 引用 + checkpoint 留痕 + 仅 cancelled 实例）；notify 行为（resume 非 actionable 提示、auto-pause 去重） | `node --test test/goal-runtime-force-close.test.mjs test/goal-runtime-continuity-notify.test.mjs` | exit 0 且断言覆盖上述全部分支 | 测试文件 + 运行输出 | T6, T8 |
| F8 | 文档落位：goal-runtime-v1.md 含运维四条澄清、resume 血缘与替换门、force-close、回执事件通道章节 | `grep -c "force-close\|force_close" docs/architecture/goal-runtime-v1.md` 及人工核对章节存在 | 计数 ≥2 且四条澄清原文可检索 | 文档文件 | T9 |

**完成规则：** 所有必要条件同时满足，且验证证据对应当前交付版本，才能标记计划执行完成；仅完成任务步骤不能替代终态验证。

**未满足时：** 在已授权范围内持续 `fix → test（验证）→ 对照终态`，修复后重验受影响条件；真实阻塞记录为未完成，并写明恢复下一步。

## DAG

```text
T1 (lineage 接口契约) ──> T2 (lineage 实现) ──> T4 (回执事件读取+泵)
                                  │                    │
                                  ├──> T8 (force-close) │
                                  │        │            │
T7 (reject 文案+prompt) ──> T5 (goal 血缘重绑) ──> T8    │
                                  │                     │
T3 (回执事件写入) ──> T4          │                     │
                                  │                     │
T6 (notify) ──────────────────> T8                     │
                                                        │
T4 + T5 + T8 ──> T9 (文档)
```

- T1→T2：接口契约（`PlanLineageResolution` 与可选 `lineage` 成员）。
- T1→T5：goal 侧消费可选方法（缺失时维持现状的类型基础）。
- T7→T5：两者均写 `src/goal-runtime/scheduler.ts`，写路径重叠需串行集成。
- T3→T4：T4 消费 T3 的事件记录格式与 durable 存储。
- T2→T4：两者均写 `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`，写路径重叠。
- T5→T8、T2→T8、T6→T8：force-close 复用 lineage（T2）与重绑/闭合语义（T5），并写 continuity.ts（T6 已改同文件）。
- T9 依赖 T4/T5/T8 的最终行为描述。

## Waves

- Wave 1：T1、T3、T6、T7（可并行，写路径互不重叠）
- Wave 2：T2、T5
- Wave 3：T4、T8
- Wave 4：T9

**关键路径：** T1/T7 → T5 → T8 → T9（T8 等 T2/T5/T6 三侧）。T3→T4 非关键路径。

---

### Task T1：PlanExecutionService 增加 lineage 接口契约

**Deps：** `none`

**WritePaths：**
- `packages/pi-subagents-enhanced/src/execution/index.ts`

**Resources：** `none`

**Files：**
- Modify：`packages/pi-subagents-enhanced/src/execution/index.ts:1-37`

**接口契约：**
- Consumes：`none`
- Produces（下游 T2/T5 消费的精确类型）：

```ts
export type PlanLineageResolution = {
  /** 血缘链解析出的当前 owner run；workspaceId/rootSessionId 与入参 ref 一致 */
  run: PlanRunRef;
  /** sourceRunId → … → 最终 runId 的完整链（含首尾） */
  chain: string[];
  /** true = ref.runId 已被血缘链上的后续 run 取代 */
  superseded: boolean;
};
// PlanExecutionService 增加可选成员（旧实现不实现该方法时类型仍合法）：
lineage?(ref: PlanRunRef): Promise<PlanLineageResolution | null>;
```

**终态关联：** `F1`、`F4`、`F5` 的类型基础。

**验收标准：**
- [ ] **步骤 1：核对接口现场**——读 `packages/pi-subagents-enhanced/src/execution/index.ts`，确认 `PlanExecutionService`（:26-37）与 `PlanRunRef`/`PlanRunFacts` 定义，记录行号。
- [ ] **步骤 2：最小实现**——按上方契约在 `PlanRunFacts` 之后新增 `PlanLineageResolution` 类型导出，在 `PlanExecutionService` 的 `subscribe` 成员后追加可选 `lineage?` 成员；不改动任何既有成员。
- [ ] **步骤 3：运行检查**——`npm --prefix packages/pi-subagents-enhanced run typecheck` 与 `npm run typecheck`，记录 exit（期望 0）。运行 `npm --prefix packages/pi-subagents-enhanced test` 确认无回归。

---

### Task T2：lineage 实现（链解析泛化 + service 挂载）

**Deps：** `T1`（理由：实现 T1 产出的 `lineage` 接口契约）

**WritePaths：**
- `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`
- `test/pi-subagents-lineage-resolution.test.mjs`

**Resources：** `none`

**Files：**
- Modify：`packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`（紧邻 `resolveManagedResumeLineageOwner`，约 :495-600 区域）
- Modify：`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`（service 绑定点，约 :2280-2296）
- Create（已授权测试）：`test/pi-subagents-lineage-resolution.test.mjs`

**接口契约：**
- Consumes：T1 的 `PlanLineageResolution` 与 `lineage?` 成员；既有 `resolveManagedResumeLineageOwner`（extensions/subagent-runtime.ts:502 起）的 intents 收集与逐跳校验模式。
- Produces：service 上的 `lineage(ref)` 实现，行为规格（全部 fail-closed）：

```ts
lineage(ref: PlanRunRef): Promise<PlanLineageResolution | null>
```
1. 装配前提：仅在本 root session 的 broker/workspaceService 装配可用时实现（与 `resolveManagedResumeLineageOwner` 同界；不可用返回 null）。
2. 收集 intents：从本 root session 拥有的 workspace records 定位 repositories，逐个 `recoveryStatus()`；过滤 `version === "integration-resume-intent.v1"`、`ownerScope.rootSessionId` 匹配、且 `workspaceId === ref.workspaceId`；按 `sourceRunId` 索引，同 source 取 `attempt` 最大者。
3. 起链：自 `ref.runId` 起，有效跳 = `state ∈ {activated, completed}` 且 `resumedRun?.runId` 为 string；环、深度 >16、`workspaceId/leaseId` 与首跳不一致 → 链在此截断。
4. 复核：链尾 `currentRunId` 必须满足 workspace ledger `readOwned(ref.workspaceId)` 的 `record.run?.runId === currentRunId` 且 owner/lease 匹配首跳；不满足返回 null。
5. 返回：`{ run: { …ref, runId: currentRunId }, chain, superseded: currentRunId !== ref.runId }`；无任何有效跳（ref.runId 即当前 owner 且复核通过）返回 `{ run: ref, chain: [ref.runId], superseded: false }`；intents 不可达/枚举失败/复核失败 → null。
6. 禁止：任何基于 blocker 文案或内存缓存的 superseded 判定。

- 挂载：在 service 绑定点（`bindPlanExecutionService` 调用处，extension.ts:2296 附近，首轮审阅已确认 `planExecution` 选项经 subagent-runtime.ts:889 传入 `createTypedSubagentExtension`，无需新参数）把 resolver 挂为 `lineage` 成员。核心链解析逻辑提为模块级导出纯函数 `resolvePlanExecutionLineage(intents, record, ref)`（输入过滤后的 intent 数组与 ledger record，输出 resolution|null；闭包内 resolver 只负责 intents 收集与复核后调用）——供测试直接 import（闭包函数不可 import，首轮审阅 S4）；诊断事件沿用 `managedResumeDiagnostic` 前缀风格（如 `plan-lineage-*`）。

**终态关联：** `F1`、`F4`、`F5`（重绑的解析来源）。

**验收标准：**
- [ ] **步骤 1：核对装配链**——读 `resolveManagedResumeLineageOwner` 全文与 `bindExecution`/`bindPlanExecutionService` 调用链，记录：resolver 可得的闭包依赖、装配参数通道、诊断函数名（`managedResumeDiagnostic`）。
- [ ] **步骤 2：实现**——按行为规格实现 `resolvePlanLineage(ref)`（新函数紧邻既有函数，workspaceId 限定起点变体）并在 service 挂载；诊断事件沿用 `managedResumeDiagnostic` 前缀风格（如 `plan-lineage-*`）。
- [ ] **步骤 3：运行检查**——`npm run typecheck`、`npm --prefix packages/pi-subagents-enhanced run typecheck`，记录 exit。
- [ ] **步骤 4：新增测试（已授权）**——`test/pi-subagents-lineage-resolution.test.mjs`（node:test，参考 `test/coordinator-proof-resume-supersession.test.mjs` 的 ledger/intents 模拟形态），断言：单跳 superseded=true 返回最终 run；多跳链；`state=failed/preserved` 的 intent 不构成跳（返回 superseded=false）；环/深度超限截断；ledger `record.run` 与链尾不一致 → null；ownerScope 不匹配的 intent 被过滤；无有效跳且复核通过 → `superseded=false` 非 null。运行 `node --test test/pi-subagents-lineage-resolution.test.mjs` 记录结果。

---

### Task T3：integration-queue 终态回执事件落盘

**Deps：** `none`

**WritePaths：**
- `packages/pi-subagents-enhanced/src/workspace/integration-queue.ts`
- `test/integration-queue-receipt-events.test.mjs`

**Resources：** `none`

**Files：**
- Modify：`packages/pi-subagents-enhanced/src/workspace/integration-queue.ts`（终态写入点：`completePrepared` 约 :322-336、`transition` 约 :443、`cancelItem` 约 :355-358、`settleDispositionQueue` 约 :422-456、`preserveByBinding` 约 :299-306）
- Create（已授权测试）：`test/integration-queue-receipt-events.test.mjs`

**接口契约：**
- Consumes：`none`
- Produces（T4 消费的 durable 记录格式，与 recovery intents 同目录同形态）：

```ts
type IntegrationReceiptEvent = {
  version: "integration-receipt-event.v1";
  eventId: string;                 // `${queueItemId}:${state}`
  queueItemId: string;
  workspaceId: string;
  leaseId: string;
  childRunId: string | null;       // rebind 后的最终 run
  ownerScope: { kind: "standalone-subagent"; rootSessionId: string }; // 取自队列项字段，步骤 1 核对实际字段名
  repositoryId: string;
  state: "completed" | "preserved" | "cancelled";
  attempt: number;
  revision: number;
  candidateHead?: string;
  integrationIntentId?: string;
  workspaceDispositionReceiptId?: string;
  completedAt?: string; preservedAt?: string; cancelledAt?: string;
  delivery: { state: "pending" | "delivered" | "debt"; attempts: number; reason?: string };
};
```

- 存储：`integration-queue/queue-receipt-events.json` 索引 + 每事件一文件 `receipt-event-<eventId>.json`（与 resume intents 存储形态并列；不混用 `disposition-settlement-index.json`）。
- 写入规则：全部挂点在既有 `ledger.withLock` 临界区内追加事件（与 `completePrepared` 既有「锁内匹配关闭 resume intent」同原则）；幂等键 `queueItemId + state`，已存在则跳过；初始 `delivery: { state: "pending", attempts: 0 }`；不改变任何既有终态写入行为。

**终态关联：** `F1`、`F4`、`F6`。

**验收标准：**
- [ ] **步骤 1：核对挂点与队列项字段**——逐一读上述五个终态写入点，记录各点可得的字段来源（ownerScope/leaseId/attempt/revision 的实际字段名），确认锁边界。
- [ ] **步骤 2：实现**——新增事件写入辅助函数（锁内调用）+ 事件存储读写；五个挂点接入。
- [ ] **步骤 3：运行检查**——`npm --prefix packages/pi-subagents-enhanced run typecheck`，记录 exit；`npm --prefix packages/pi-subagents-enhanced test` 无回归。
- [ ] **步骤 4：新增测试（已授权）**——`test/integration-queue-receipt-events.test.mjs`：completed/preserved/cancelled 各落一事件（字段断言）；同一 `queueItemId+state` 重复终态写入不产生第二事件（幂等）；事件不影响既有终态写入（对照无事件时代的行为断言）。运行 `node --test test/integration-queue-receipt-events.test.mjs` 记录结果。

---

### Task T4：回执事件读取 RPC + Host 泵送达

**Deps：** `T3`（理由：消费其事件记录格式与 durable 存储）；`T2`（理由：两者均写 `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`，串行避免写冲突）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts`
- `packages/pi-subagents-enhanced/src/workspace/coordinator-client.ts`
- `packages/pi-subagents-enhanced/src/workspace/integration-queue.ts`
- `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`
- `test/integration-queue-receipt-events.test.mjs`

**Resources：** `none`

**Files：**
- Modify：`packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts`（新 RPC 注册，参照 `queue.audit` 约 :373-376 与 `recovery.resume-delivered` 约 :477-485 的注册风格）
- Modify：`packages/pi-subagents-enhanced/src/workspace/coordinator-client.ts`（client 具名方法 + 重放白名单，:84-108、:127-134）
- Modify：`packages/pi-subagents-enhanced/src/workspace/integration-queue.ts`（事件读取/回写 delivered 方法）
- Modify：`packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`（D7 泵约 :121-152）
- Modify（已授权测试，T3 创建）：`test/integration-queue-receipt-events.test.mjs`

**接口契约：**
- Consumes：T3 的 `IntegrationReceiptEvent` durable 存储。
- Produces：
  1. 新 RPC `queue.receipt-events`（**独立方法，不改 `recovery.status` 返回形状**——首轮审阅确认 recovery.status 返回扁平数组且有四个按数组消费的调用方（resume 泵 :132-133、lineage 收集 :524-528、inspect :960-961、:1080-1081），改对象形状会静默破坏）：按 `ownerScope.rootSessionId` 过滤、只含 `delivery.state === "pending"`；`queue.audit` 聚合返回全部回执事件（含 delivered/debt）供运维审计。
  2. 新 RPC `queue.receipt-event-delivered`（入参 `{ eventIds: string[]; state: "delivered" | "debt"; reason?: string }`）：更新事件 delivery 至指定状态并递增 `attempts`；未知 eventId 报错。coordinator-client.ts 补具名 client 方法（风格同 `resumeDelivered` :100-107）并加入 `COORDINATOR_CLIENT_REPLAYABLE_METHODS` 幂等重放白名单（:127-134）。
  3. Host 泵 `pumpReceiptEvents`（`pumpResumeHandoffs` 同一 5s 定时器内或兄弟函数，同 `closing/pumpBusy/!lazy.hasClient()` 门控，daemon 缺位空转）：经 client 拉取 pending 事件，逐事件处理：`childRunId === null` → 回写 `debt` + `reason: "child-run-unavailable"`（终态，不再重试）；否则 `broker.notifyExecutionFacts(event.childRunId)` 成功后回写 `delivered`；回写 RPC 失败保持 `pending` 下轮重试（重复 notify 幂等无害，at-least-once）。
  4. 泵的事件处理判定提为**模块级导出纯函数**（输入事件数组与 childRunId 可用性，输出 `{ toNotify: …; toDebt: …; deliveredIds: … }`）供直接单测；泵接线保持薄层。
- goal 侧零改动（subscribe listener 已全量 reconcile；事实由 `inspect` 权威拉取，`receiptMatches` 分支已投影 integration completed+receipt）。

**终态关联：** `F1`、`F4`、`F6`。

**验收标准：**
- [ ] **步骤 1：核对**——读 `queue.audit`/`pumpResumeHandoffs` 现实现与 coordinator-client.ts 方法定义/重放白名单结构，记录返回体结构与泵门控条件。
- [ ] **步骤 2：实现**——按接口契约完成三处改动；RPC 注册风格与既有 `recovery.resume-delivered` 一致。
- [ ] **步骤 3：运行检查**——`npm run typecheck`、`npm --prefix packages/pi-subagents-enhanced run typecheck`，记录 exit。
- [ ] **步骤 4：新增测试（已授权）**——在 `test/integration-queue-receipt-events.test.mjs` 追加：`queue.receipt-events` 按 owner 过滤且只返回 pending（delivered/debt 不返回）；回写 delivered 后不再返回；`recovery.status` 返回形状不变（仍为扁平 intents 数组，receiptEvent 记录不出现在其中）；泵判定纯函数断言：childRunId=null → 归入 toDebt；childRunId 有效 → 归入 toNotify 且成功后 deliveredIds 含之；回写失败（模拟 RPC 错误）→ 事件保持 pending（下轮重试语义）。运行 `node --test test/integration-queue-receipt-events.test.mjs` 记录结果。

---

### Task T5：goal 侧血缘重绑（refreshRuns / replaceCancelled / retryTask）

**Deps：** `T1`（理由：消费 `lineage?` 可选接口的类型契约）；`T7`（理由：两者均写 `src/goal-runtime/scheduler.ts`，串行避免写冲突）

**WritePaths：**
- `src/goal-runtime/contract.ts`
- `src/goal-runtime/scheduler.ts`
- `test/goal-runtime-lineage-rebind.test.mjs`

**Resources：** `none`

**Files：**
- Modify：`src/goal-runtime/contract.ts:92-101`（TaskState）
- Modify：`src/goal-runtime/scheduler.ts`（`refreshRuns` 约 :378-430、`replaceCancelled` 约 :342-377、`retryTask` 约 :566-596）
- Create（已授权测试）：`test/goal-runtime-lineage-rebind.test.mjs`

**接口契约：**
- Consumes：T1 的 `lineage?` 与 `PlanLineageResolution`。
- Produces：
  1. `TaskState` 新增可选字段 `supersededRunIds?: string[]`（旧快照无此字段解码为 undefined，天然兼容；步骤 1 核对 session-state.ts 解码是否需要同步放行该字段）。
  2. scheduler 内部辅助 `resolveLineageRun(execution, ref)`：`execution.lineage` 存在则调用，异常吞掉返回 null（诊断日志），缺失返回 null。
  3. `refreshRuns` 重绑逻辑：对每个 task，`inspect(task.run)` 返回**降级 facts**（`terminal === "unknown" && blocker !== null`）时调 `resolveLineageRun`：
     - `null` 或 `superseded === false` → 维持现状（blocked 语义不变）；
     - `superseded === true` → 经既有 `change()`/`assertTask` 串行化路径持久化重绑：`run = resolution.run`、`supersededRunIds = [...(task.supersededRunIds ?? []), task.run.runId]`（去重）、`attempt/dispatchKey/workspaceId` 不变；随后对最终 run 重新 `inspect` 并走既有 apply 逻辑。注意（首轮审阅 S5）：apply 的 previous.run 身份比对守卫（scheduler.ts:404-406）会在重绑后跳过本轮投影，重绑时须同步把本轮 previous 基线更新为最终 run，或直接以最终 run facts 走 apply（步骤 1 按现场结构选定）。
  4. `replaceCancelled`：:358 逐任务 `inspect` 前，先 `resolveLineageRun` + 内存态重绑（本函数内不持久化——计划即将被替换），再对最终 run `inspect` 判 `closed`。
  5. `retryTask`：inspect 前同样解析重绑（经 `change()` 持久化）。
  6. `sameRun` 守卫（:387）与 `closed`（:69-72）定义不动。

**终态关联：** `F1`、`F3`、`F5`。

**验收标准：**
- [ ] **步骤 1：核对**——读 `refreshRuns`/`replaceCancelled`/`retryTask`/`change()`/`assertTask` 与 session-state.ts 对 TaskState 未知字段的解码策略（严格解码则需同步加字段），记录行号。
- [ ] **步骤 2：实现**——按接口契约完成；诊断信息经 scheduler 既有诊断通道。
- [ ] **步骤 3：运行检查**——`npm run typecheck`；`node --test test/goal-runtime-runtime.integration.mjs test/goal-runtime-contract.test.mjs` 记录 exit 与既有失败基线（若基线本有失败，记录并区分，不得新引入）。
- [ ] **步骤 4：新增测试（已授权）**——`test/goal-runtime-lineage-rebind.test.mjs`（mock execution adapter，参考 `test/goal-runtime-runtime.integration.mjs` 的 `adapter()` 双打形态，扩展 mock 支持 `lineage`）：断言 (a) 降级 facts + lineage superseded → task.run 重绑最终 run、supersededRunIds 记录旧 id、blocker 解除；(b) lineage 返回 null → 维持 blocked 且 ref 不变；(c) lineage superseded=false → 维持 blocked；(d) cancel 后 replaceCancelled：重绑后 inspect(最终run) closed → 门通过（不再 GOAL_CANCELLED_REPLACEMENT_REQUIRED）；(e) retryTask 重绑路径；(f) lineage 抛异常 → 吞掉返回 null、状态不变；(g) facts.run 身份与 task.run 不符且 lineage 不可用 → 维持既有拒绝/降级路径（RUN_IDENTITY_MISMATCH 或现状 blocked），验证 sameRun 未被放宽；(h) 含 supersededRunIds 的快照经 session-state 解码可往返（写入→重读一致），不含字段的旧快照解码为 undefined。运行 `node --test test/goal-runtime-lineage-rebind.test.mjs` 记录结果。

---

### Task T6：缺陷③ notify（resume 非 actionable 提示 + auto-pause 提示去重）

**Deps：** `none`

**WritePaths：**
- `src/goal-runtime/continuity.ts`
- `test/goal-runtime-continuity-notify.test.mjs`

**Resources：** `none`

**Files：**
- Modify：`src/goal-runtime/continuity.ts`（`/plan` handler 约 :141-160、input handler 约 :163-171）
- Create（已授权测试）：`test/goal-runtime-continuity-notify.test.mjs`

**接口契约：**
- Consumes：`runtime.status(session).next`（`next.kind ∈ {advance,retry,verify,wait,blocked}` 判定，见 `src/goal-runtime/index.ts:208-209`）与 `describeGoalNextAction`（index.ts:143-157，步骤 1 核对导出形态）。
- Produces：
  1. resume 分支：`control(session, "active", null)` 成功后，读 `runtime.status(session)`；`next.kind ∈ {wait, blocked}` 时输出一行 `ctx.ui.notify(text, "info")`，文案含人类可读的 next 原因（复用 `describeGoalNextAction` 或 `next.reason`）与「已恢复；当前无可推进事实，事实变化后将自动续跑，无需重复 resume」；actionable kind 不输出。既有 JSON 状态输出（:157）保留。
  2. input handler：`control(paused)` 成功后 `ctx.ui.notify("Goal 已因新用户消息自动暂停；/plan resume 恢复", "info")`；去重：continuity.ts 模块级 `WeakMap<GoalRuntimeSession, string | null>` 记录 `lastAutoPauseNotifiedReason`（不扩展 index.ts 的 GoalRuntimeSession 类型，首轮审阅 S1），同一 reason 只提示一次，`control(active)` 成功路径重置。
  3. notify 仅 UI 投影，不进入 transcript、不改 JSON 输出结构。

**终态关联：** `F3`、`F7`。

**验收标准：**
- [ ] **步骤 1：核对**——读 `/plan` handler 与 input handler 全文、`describeGoalNextAction` 导出、session 对象可挂字段位置。
- [ ] **步骤 2：实现**——按契约完成两处。
- [ ] **步骤 3：运行检查**——`npm run typecheck`；`node --test test/goal-runtime-runtime.integration.mjs` 无回归。
- [ ] **步骤 4：新增测试（已授权）**——`test/goal-runtime-continuity-notify.test.mjs`：若可复用 joint-session harness（`test/helpers/joint-upgrade-session.mjs`）则集成断言 `ctx.ui.notify` 调用；否则把去重判定提取为纯函数（如 `shouldNotifyAutoPause(session, reason)`）单测。断言：resume 后 next=wait/blocked 各提示一次且含原因文案；next=advance 不提示；连续两条用户消息只提示一次 auto-pause；resume 成功后去重状态重置（下一条用户消息再提示）。运行 `node --test test/goal-runtime-continuity-notify.test.mjs` 记录结果。

---

### Task T7：缺陷⑤ reject 文案 + 派发 prompt 收尾指引

**Deps：** `none`

**WritePaths：**
- `src/goal-runtime/scheduler.ts`

**Resources：** `none`

**Files：**
- Modify：`src/goal-runtime/scheduler.ts:342-377`（三处 `GOAL_CANCELLED_REPLACEMENT_REQUIRED` reject，约 :350、:354、:360）与 `prompt()`（约 :440-448）

**接口契约：**
- Consumes：`none`
- Produces：
  1. 三处 reject 文案统一为（保留既有错误码前缀）：说明「被拒实例持有于当前会话内存与 session 分支索引，删除存盘文件不影响本会话判定」；处置路径「① `/plan force-close` 或 `plan_force_close` 核实闭合后重新 plan_execute；② 若 session 文件已删除，重启会话后旧 goal 随会话消失，可直接重新 plan_execute」。
  2. `prompt()` 生成的派发任务文本末尾追加一行收尾指引：「结束前必须在 worktree 内将全部交付物显式 git add 并 git commit；未提交的 run 终结后集成队列无法发布你的工作。」

**终态关联：** `F3`。

**验收标准：**
- [ ] **步骤 1：核对**——读三处 reject 与 `prompt()` 现文，记录行号。
- [ ] **步骤 2：实现**——按契约改文案；错误码不变（`GOAL_CANCELLED_REPLACEMENT_REQUIRED` 仍为前缀，供既有测试匹配）。
- [ ] **步骤 3：运行检查**——`npm run typecheck`；`node --test test/goal-runtime-runtime.integration.mjs test/goal-runtime-contract.test.mjs` 记录 exit（若既有测试断言旧文案全等，同步调整该断言为包含错误码子串——属随已授权生产修复同步调整既有断言）；`grep -c "force-close" src/goal-runtime/scheduler.ts` ≥1（reject 文案含处置指引）且 `grep -c "git add" src/goal-runtime/scheduler.ts` ≥1（prompt 收尾指引）。

---

### Task T8：force-close（核实型 typed 工具 + 盲闭合 /plan 子命令）

**Deps：** `T2`（理由：核实型消费 lineage 实现）；`T5`（理由：复用血缘重绑与 closed 语义，且同写 scheduler.ts）；`T6`（理由：同写 continuity.ts）

**WritePaths：**
- `src/goal-runtime/scheduler.ts`
- `src/goal-runtime/continuity.ts`
- `src/goal-runtime/index.ts`
- `test/goal-runtime-force-close.test.mjs`

**Resources：** `none`

**Files：**
- Modify：`src/goal-runtime/scheduler.ts`（新增 forceClose 逻辑）
- Modify：`src/goal-runtime/continuity.ts`（`/plan` handler 加 `force-close` 分支，约 :141-160）
- Modify：`src/goal-runtime/index.ts`（注册 `plan_force_close` 工具，注册形态参照 `plan_retry` 约 :422-433；首轮审阅确认工具注册仅在 index.ts，`pi/extensions/goal-runtime.ts` 为薄引导层不承载注册，不修改）
- Create（已授权测试）：`test/goal-runtime-force-close.test.mjs`

**接口契约：**
- Consumes：T2 `lineage`、T5 `resolveLineageRun`/`closed`、T6 的 continuity 结构。
- Produces：
  1. scheduler 新增 `forceCloseTasks(session, opts)`：
     - 状态门：仅 `status === "cancelled"` 实例允许（其余状态拒绝 `GOAL_NOT_CANCELLED`）。
     - 模式 A（核实型，`mode: "verified"`）：对每个有 run 的 task：`resolveLineageRun` → 重绑 → `inspect(最终 run)` 必须 `closed(fact)`；任一任务不满足 → 整体拒绝 `FORCE_CLOSE_VERIFICATION_FAILED`，错误信息逐任务列出未闭合原因与建议（改走 `/plan force-close` 人工路径）；全部通过 → 经 `change()` 持久化重绑 + checkpoint 留痕（mode、时间、planId、逐任务最终 runId），此后 `replaceCancelled` 门自然通过。
     - 模式 B（盲闭合，`mode: "manual"`）：把每个有 run 任务的 `run/dispatchKey/workspaceId` 置 null、`status` 非 accepted/blocked 的置 `blocked` 且 `blocker = "FORCE_CLOSED_BY_ADMIN"`，`terminalProofRef/integrationReceiptRef` 保留原值（历史事实不篡改）；经 `store.update` 追加（不删历史）；checkpoint 留痕同上（mode=manual）。
     - 两种模式写入前 `runtime.assertCurrent(session)` / `assertIdentity` 等价校验（步骤 1 按现场 API 定）。
  2. typed 工具 `plan_force_close`（仅 index.ts 注册，参照 `plan_retry` :422-433 的 `pi.registerTool` 形态）：参数 `{ force_confirm: string }`（必须精确等于当前 planId，否则拒绝 `FORCE_CLOSE_CONFIRM_MISMATCH`）；仅实现模式 A（核实型）；工具描述声明「仅核实型闭合，核实不通过时拒绝；人工断言闭合使用 /plan force-close」。
  3. `/plan force-close` 子命令（continuity.ts）：`ctx.ui.confirm("将对已取消计划执行人工强制闭合（跳过自动核实，不可回滚）。继续？")` 确认后走模式 B；拒绝则中止；完成后输出 `runtime.status(session)` JSON。`/plan` 用法文案更新为 `/plan pause | resume | cancel | force-close | status`。

**终态关联：** `F1`、`F3`、`F7`。

**验收标准：**
- [ ] **步骤 1：核对**——读 scheduler 既有 change/assertTask/store.update 用法、index.ts 工具注册形态（`plan_retry` 为参照）、`ctx.ui.confirm` 类型（types.d.ts:548 附近）、GoalCheckpoint 字段结构，记录行号。
- [ ] **步骤 2：实现**——按契约完成四处。
- [ ] **步骤 3：运行检查**——`npm run typecheck`；`node --test test/goal-runtime-runtime.integration.mjs test/goal-runtime-contract.test.mjs` 无回归。
- [ ] **步骤 4：新增测试（已授权）**——`test/goal-runtime-force-close.test.mjs`（mock execution adapter，同 T5 形态）：断言 (a) 模式 A 全 closed → 成功、task.run 已重绑、checkpoint 含留痕、随后 replaceCancelled 通过；(b) 模式 A 任一任务 lineage null 或 facts 非 closed → `FORCE_CLOSE_VERIFICATION_FAILED` 且逐任务原因、状态不变；(c) force_confirm 不匹配 → `FORCE_CLOSE_CONFIRM_MISMATCH`；(d) 非 cancelled 状态 → `GOAL_NOT_CANCELLED`；(e) 模式 B → run/dispatchKey/workspaceId 置 null、blocker=FORCE_CLOSED_BY_ADMIN、历史 entry 未删除（session 条目只增）、replaceCancelled 无 run 分支通过；(f) ui.confirm 拒绝 → 无任何写入。运行 `node --test test/goal-runtime-force-close.test.mjs` 记录结果。

---

### Task T9：文档落位（运维语义 + 血缘/替换门 + force-close + 回执通道）

**Deps：** `T4`（理由：描述其最终通道行为）；`T5`（理由：描述重绑与替换门语义）；`T8`（理由：描述 force-close 用法）

**WritePaths：**
- `docs/architecture/goal-runtime-v1.md`

**Resources：** `none`

**Files：**
- Modify：`docs/architecture/goal-runtime-v1.md`（新增「运维语义与异常处置」章节）

**接口契约：**
- Consumes：T2/T4/T5/T8 的实现行为。
- Produces：文档章节，内容必须覆盖：
  1. 运维四条澄清（源自原报告，已被调研核实）：集成队列发布目标=本地 origin 仓 main 不推 GitHub（排查看本地 main reflog）；rebase 后原提交对象不可达≠代码丢失（以队列台账 candidateHead 为准）；父侧 integrate 返回 CHILD_OWNS_INTEGRATION 是护栏；child 必须在 run 终结前在自己 worktree 内提交（否则队列项停留 resumable 走 handoff 人工接管）。
  2. resume 血缘与替换门：工具路径复活后 goal 侧按 resume intent 链重绑 task.run 的机制、`supersededRunIds` 审计字段、fail-closed 边界（解析失败维持 blocked）。
  3. force-close：`plan_force_close`（核实型，agent 可用）与 `/plan force-close`（盲闭合，人工确认）的边界与留痕。
  4. 回执事件通道：`integration-receipt-event.v1` → D7 泵 → `notifyExecutionFacts` 唤醒，at-least-once 语义。
  5. resume 交互：非 actionable notify、auto-pause 护栏语义（不解析自然语言授权）。

**终态关联：** `F8`。

**验收标准：**
- [ ] **步骤 1：核对**——读 goal-runtime-v1.md 现有章节结构，确定新章节插入位置（建议在既有使用/控制章节之后）。
- [ ] **步骤 2：撰写**——按契约五点成文，中文，行号/字段名与实现一致（以 T2/T4/T5/T8 的最终代码为准）。
- [ ] **步骤 3：验证**——`grep -c "force-close" docs/architecture/goal-runtime-v1.md` ≥1；人工核对四条澄清原文可检索。

---

## 执行说明

- 计划经首轮 reviewer 审阅（2026-11-04）并完成修订：阻塞项 B1（T5 补 session-state.ts 写路径与解码改造）、B2（T4 补 coordinator-client.ts 写路径与 client 方法/重放白名单）、B3（改为独立 RPC `queue.receipt-events`，不改 recovery.status 返回形状）已采纳；建议 S1-S9 全部采纳（T6 WeakMap、T8 移除 pi/extensions/goal-runtime.ts、T2 纯函数导出、T5 apply 基线与 sameRun 断言、T4 泵判定纯函数与 pending/debt 语义、F4/F6 判据对齐、T7 grep 断言）。
- 执行方式：经典 Subagent-Driven 编排（本计划不含 goal-runtime.plan.v1 契约块，理由见全局约束末条）。
- coding 派发均带 `writePaths` 与本任务合同；同仓并发写重叠文件的任务已通过 Deps 串行化（T7→T5、T2→T4、T6/T5/T2→T8），无需额外 worktree 隔离。
- 各任务停止条件：发现现场代码与本计划行号/结构前提矛盾（先记录偏差，行号漂移按语义定位继续；结构性矛盾则停止上报）；需要写声明路径外文件；类型检查/测试基线出现计划外失败且无法归因于本任务改动。
