# Goal Obligation Runtime 设计规格

> **状态：** R0 冻结合同（`dispatch-ir.v1` / `goal-runtime.v1`）。本文是实现 R1–R13 的稳定输入；实现不得以未记录的推断扩充该合同。
>
> **首发边界：** 仅 Manual Preview。R0–R13 固定采用 Subagent-Driven，禁止为本计划创建 `planned.v1` 或 `goal-runtime.v1` 自举 Goal；当前 `planned-goal` 完成前不得开始 R1 的 production 修改。

## 1. 代际能力与兼容边界

所有协议分支必须经 `generationCapabilities(schemaVersion)` 取得不可变能力对象，禁止散落以版本字符串作业务判断。

```ts
type GenerationCapabilities = Readonly<{
  taskContract: "legacy-commands" | "criteria-only";
  executorBinding: "legacy" | "strict";
  settlement: "legacy" | "dual-path";
  completion: "accept-auto" | "goal-finalize";
  conditions: boolean;
  executionRevision: boolean;
}>;
```

| generation | taskContract | executorBinding | settlement | completion | conditions | executionRevision |
|---|---|---|---|---|---|---|
| `goal-engine.event.v1/v2/v3` | `legacy-commands` | `legacy` | `legacy` | `accept-auto` | `false` | `false` |
| `planned.v1` | `criteria-only` | `strict` | `dual-path` | `accept-auto` | `false` | `false` |
| `goal-runtime.v1` | `criteria-only` | `strict` | `dual-path` | `goal-finalize` | `true` | `true` |

**冻结规则：** `planned.v1` 的 criteria-only 任务合同、strict Executor 绑定、dual-path settlement、最后一个 Task `accept` 后自动完成（accept-auto）永不改变。`goal-runtime.v1` 复用前三项，但 Task `accept` 仅更新 Task 与适用性，绝不完成 Goal；只有该 generation 的 `goal_finalize` 可追加完成事件。未知 generation 拒绝，不回退到 legacy。

历史 `goal-engine.event.v1/v2/v3` 的 capability 固定返回上述 union 内值；各历史 codec 仍按原代际 replay/mutate，禁止原地升级、混写或以字符串 fallback 代替 codec。Root model-facing ABI 仍精确为八个工具：`goal_init/status/dispatch/settle/integrate/accept/amend/finalize`；不得增加 `goal_observe`。

## 2. 初始化合同与派生形状

```ts
type RuntimeGoalInit = {
  objective: string;
  scope?: string[];
  non_goals?: string[];
  dod?: string[];
  execution: {
    schema: "goal-runtime.v1";
    tasks?: PlannedTask[];
    conditions?: GoalCondition[];
    write_policy: { allowed_paths: string[] };
    budgets: {
      max_observations: number;
      max_repairs: number;
      max_elapsed_minutes: number;
      max_no_progress: number;
    };
  };
};
```

逐字段合同如下：`objective` 是目标文字；`scope`、`non_goals`、`dod` 是受批准的范围、排除项和交付定义；`execution.schema` 必须逐字为 `goal-runtime.v1`；`tasks` 与 `conditions` 至少一项非空；`write_policy.allowed_paths` 是所有 Task 与修复的总写路径上限；四个 `budgets` 分别限制观察、修复、耗时和无进展次数。

旧顶层 `{ objective, tasks }` 仅创建 `planned.v1`。顶层 `tasks` 与 `execution` 同时出现时必须在 append 前拒绝。调用者不得提交 `profile` 或 `initialShape`；`initialShape` 只从规范化内容派生：仅 tasks 为 `planned`，仅 conditions 为 `convergent`，两者均有为 `hybrid`。

## 3. Obligation、Condition 与实体状态机

```ts
type ObligationRef = { kind: "task"; id: string } | { kind: "condition"; id: string };
type GoalCondition = {
  id: string;
  role: "terminal" | "invariant";
  enforcement: "pre_integrate" | "continuous" | "final";
  statement: string;
  observable: string;
  expected: string;
  depends_on: ObligationRef[];
  oracle_ref: string;
  environment_ref: string;
  fixture_refs: string[];
  invalidation: { paths: string[]; task_ids: string[] };
  remediation: {
    policy: "autonomous" | "user-approved";
    allowed_paths: string[];
    max_attempts: number;
  };
  stability:
    | { mode: "single"; require_fresh_environment: true }
    | { mode: "consecutive"; count: number; require_distinct_environment: true };
};
```

`statement/observable/expected` 分别表达义务、可观察对象和预期；引用字段只可指向 Host 注册的 oracle、environment、fixture，合同不得保存 executable、args、env 值、token、cookie、authorization header、完整日志或 shell command。依赖边只允许 `TaskRef → Condition` 与 `ConditionRef → Condition`，不得令 Planned Task 依赖 Condition；循环、重复 ID、未知引用均拒绝。

`invariant + pre_integrate` 必须真正在 integrate 前观察；不能前置的 invariant 必须标为 `continuous` 或 `final`。`invalidation.paths=[]` 表示任何 repository source/config 变化都失效。`remediation.allowed_paths` 必须是总 write policy 子集。`single` 仅限 Host 声明 `deterministic=true` 且用户批准的合同；否则使用 `consecutive` 且 `count >= 2`、证据来自不同环境。

Task 状态机保持现有 FSM；`accepted` 是不可改写的历史事实，不因代码、环境或证据变化回退。其当前 revision 适用性独立为 `applicable | superseded | reverify_required`。Condition 状态机为 `inactive → unsatisfied → observing → satisfied`，并可因失效进入 `stale`、因不可判定进入 `blocked`；上游 stale/failed 级联使下游证据不可 fresh。Finding 只由 Host 的 failed evidence 产生，状态为 `open | repairing | reverification | resolved | rejected_by_user`。Repair Episode 是 Finding 与 remediation Task 的因果容器，状态为 `active | waiting_for_tasks | reverifying | resolved | blocked | cancel_pending | cancelled`；Task accepted 只令 Episode 进入复验，不能自行解决 Finding。取消先进入 durable `cancel_pending`；仅在关联 owned tasks/runs 全部 terminal，且每个受影响 workspace/resource 都有 quarantine 或 release proof 后，才可进入 `cancelled`。

## 4. Runtime projection 与权威事件

```ts
type RuntimeProjectionFields = {
  runtimeGeneration: "goal-runtime.v1";
  initialShape: "planned" | "convergent" | "hybrid";
  executionRevision: number;
  executionContractHash: string;
  readiness: "draft" | "ready" | "needs_clarification" | "environment_blocked" | "unsafe_to_run";
  runtimeState: "draft" | "awaiting_user_approval" | "calibrating" | "active" | "suspended" | "attention_required" | "ready_for_finalization";
  writePolicy: { allowedPaths: string[] };
  taskApplicability: Map<string, { revision: number; state: "applicable" | "superseded" | "reverify_required"; reason: string | null }>;
  conditions: Map<string, ConditionState>;
  observationRuns: Map<string, ObservationRunState>;
  findings: Map<string, FindingState>;
  repairEpisodes: Map<string, RepairEpisodeState>;
  suspension: SuspensionState | null;
  convergenceBudget: ConvergenceBudgetState;
};
```

Projection 由 append-only 事件重放或快照恢复，内存 Map/Priority Promise 不构成 authority。生命周期为 `draft → readiness_ready → awaiting_user_approval → calibrating → active`；暂停或注意状态不得绕过批准恢复。用户批准必须绑定 canonical contract hash、base HEAD、session 和 proposal ID。Cycle 0 使用普通 Observation 协议验证 adapter/reset/resource/environment 是否可判定，但业务失败不产生产品 Finding。

投影中各 Map value 的逐字段冻结如下：

```ts
type ConditionState = { definition: GoalCondition; status: "inactive" | "unsatisfied" | "observing" | "satisfied" | "stale" | "blocked"; supportingEvidenceIds: string[]; lastObservationRunId: string | null; invalidationReason: string | null };
type ObservationRunState = { runId: string; conditionId: string; cycle: number; phase: "requested" | "lease_allocated" | "process_bound" | "terminal" | "recorded" | "released" | "cleanup_debt"; allocationId: string | null; leaseReceiptHash: string | null; processIdentityHash: string | null; terminalProofHash: string | null; evidenceId: string | null };
type FindingState = { findingId: string; conditionId: string; observationRunId: string; fingerprint: string; status: "open" | "repairing" | "reverification" | "resolved" | "rejected_by_user"; episodeId: string | null };
type RepairEpisodeState = { episodeId: string; conditionId: string; findingIds: string[]; remediationTaskIds: string[]; status: "active" | "waiting_for_tasks" | "reverifying" | "resolved" | "blocked" | "cancel_pending" | "cancelled"; cancellation: { ownedTaskIds: string[]; ownedRunIds: string[]; terminalProofRefs: string[]; workspaceClosureProofRefs: string[]; resourceClosureProofRefs: string[]; resourceDebt: boolean } | null };
type SuspensionState = { suspensionId: string; reason: "interactive_steer" | "follow_up" | "abort" | "execution_amendment" | "host_pause"; affectedTaskIds: string[]; affectedRunIds: string[]; requestedAt: string; resourcesQuarantined: boolean };
```

权威 runtime 事件固定为：

```text
goal.runtime_drafted, goal.runtime_readiness_recorded, goal.runtime_approval_recorded,
goal.runtime_activated, goal.runtime_suspended, goal.runtime_resumed,
condition.observation_requested, condition.observation_lease_allocated,
condition.observation_process_bound, condition.observation_terminal,
condition.observation_recorded, condition.observation_released,
condition.evidence_invalidated, finding.recorded, finding.status_changed,
repair.episode_opened, repair.task_linked, repair.reverification_requested,
repair.episode_resolved, repair.episode_cancel_requested, repair.episode_cancelled,
task.applicability_changed,
execution.amendment_proposed, execution.amendment_approved,
execution.amendment_capability_consumed, execution.amendment_applied,
goal.final_review_started, goal.final_review_recorded, goal.completed
```

事件 payload 按以下字段组冻结（每项另含 `goalId`、`executionRevision`、`contractHash`、`recordedAt` 和 schema/actor authority）：

| 事件组 | payload 必填字段 |
|---|---|
| drafted/readiness/approval/activated | `runtimeInit`（仅 drafted）、`readiness`/原因、`proposalId`、`proposalHash`、`baseHead`、`sessionId`、`userEntryId`、capability digest |
| suspended/resumed | `suspensionId`、`reason`、`affectedTaskIds`、`affectedRunIds`、stop/quarantine proof 引用 |
| observation requested/lease/process/terminal/recorded/released | `runId`、`conditionId`、`cycle`，以及依阶段加入 `worldSnapshotHash`、`resourceClaimsHash`、`allocationId`/`leaseReceiptHash`、`processIdentityHash`、`terminalProofHash`、`artifactRef`、`evidenceId`、`releaseReceiptHash` |
| evidence invalidated/applicability changed | `conditionId` 或 `taskId`、旧 evidence/适用性、目标状态、原因、触发 Snapshot/revision 引用 |
| finding/repair | `findingId`、`conditionId`、`runId`、`evidenceId`、`fingerprint`、`episodeId`、关联 remediation task IDs/runs、旧/新状态与原因；取消请求另含 terminal proof、workspace quarantine/release proof、resource quarantine/release proof 与 `resourceDebt` |
| amendment proposed/approved/capability consumed/applied | `proposalId`、`proposalHash`、变更摘要 hash、旧/新 revision、challenge/session/userEntry、capability nonce digest、affected entity 与 reconciliation result |
| final review started/recorded/completed | `reviewId`、manifest/state/world hash、base/head、approval 引用、review result hash/severity、`completionVerdict` |

Observation identity 一律使用 `runId`：`ConditionState.lastObservationRunId`、`FindingState.observationRunId`、`ObservationRunState.runId` 与 observation/finding/repair event payload 均指向同一 `runId`；不得使用未定义的 `observationId`。`allocationId` 在 `requested` 为 `null`，仅自 `lease_allocated` 起非空。

payload 不得含调用者提供的 command、verdict、Finding 正文、process terminal proof 或最终 evidence hash。`record_observation` 仅接收 run/condition/artifact 引用，Host 重读 artifact 后派生 verdict。`failed` 以外的 verdict 不创建 Finding。`ready_for_finalization` 是 projection 动态派生状态，禁止新增权威 ready 事件。

## 5. Current World Snapshot 与新鲜度

```ts
type CurrentWorldSnapshot = {
  repo: { root: string; head: string; branch: string | null; trackedDirty: string[]; untracked: string[]; sequencer: string | null };
  adapters: Array<{ ref: string; version: string }>;
  environments: Array<{ ref: string; fingerprint: string; available: boolean }>;
  fixtures: Array<{ ref: string; fingerprint: string; available: boolean }>;
  resources: Array<{ key: string; holders: string[]; capacity: number }>;
  activeRuns: Array<{ runId: string; kind: "executor" | "observation"; state: string }>;
  capturedAt: string;
};
```

每次 `goal_status`、mutation 与 `goal_finalize` 前都捕获 Snapshot。`repo` 的 root/HEAD/branch、tracked dirty/untracked、sequencer 是 Git 权威；其他数组分别是注册 adapter 版本、环境/fixture 指纹和可用性、lease 资源持有量、owned active run。任一捕获失败、Git status 未知、相关 dirty/untracked、non-ancestor、sequencer 存在、adapter/environment/fixture 不可用或资源 identity 冲突，均 fail closed，不能解释为 fresh。

Evidence 必须绑定 goal、condition、execution revision、contract/condition hash、HEAD、adapter/environment/fixture identity、run、terminal proof 和 artifact。路径或 Task 失效、上游 Condition stale/failed、合同/环境变化均级联失效；只有完整证明不相交才保留 fresh。stability history 必须能逐项审计 single 或连续次数、顺序、不同环境与最后 mutation 后的证据。

## 6. 用户执行能力、暂停与修订

```ts
type UserExecutionCapability = {
  prefix: "goal-user-capability.v1";
  goalId: string;
  executionRevision: number;
  proposalId: string;
  proposalHash: string;
  sessionId: string;
  userEntryId: string;
  nonce: string;
  singleUse: true;
};
```

它使用不同于 `goal-action.v1:` 的前缀与验证器；每个字段精确匹配，跨 session、过期 revision 或重复消费一律拒绝。`execution.amendment_capability_consumed` 必须与 apply batch 原子提交。active Goal 收到 interactive steer、follow-up、abort 或 execution amendment 时，先 durable suspend 并撤销 action offer；随后仅对绑定 Goal/task/attempt/run/lease 的 owned process 执行 typed stop，取得 official terminal proof。受影响 workspace 只能 quarantine/preserve/discard，旧结果不得 integrate。

## 7. Observation durable crash 合同

Observation 固定生命周期：`requested → lease_allocated → process_bound → terminal → recorded → released`。外部副作用前必须已有 durable intent；恢复时 lease 与 process identity 是 authority，不依赖内存 Promise。服务接口固定为：

```js
prepareManagedValidation(input)       // durable intent，不启动进程
startManagedValidation(prepared)      // 绑定 process identity
inspectManagedValidation(receipt)     // 只读状态/proof
recoverManagedValidation(receipt)     // adopt/terminal/cleanup-debt 决定
releaseManagedValidation(receipt)     // owner-CAS release
```

| 阶段 | durable authority | 允许重试 | 恢复输入 | 成功事件 | 无法证明时的 cleanup-debt 结果 |
|---|---|---|---|---|---|
| `requested` | 已持久化 request（runId、conditionId、world/contract identity、resource claims） | 同一 run 仅幂等检查；未分配 lease 可重试 prepare | request event、当前 projection、Snapshot | `condition.observation_requested` | request/资源意图无法对应时不启动；标记 cleanup debt，保留可能 reservation 并进入 attention |
| `lease_allocated` | allocationId、lease receipt hash 与 owner-CAS lease | 可重试 inspect/allocate；不得重复取得第二 lease | request、allocationId、lease receipt、资源 inventory | `condition.observation_lease_allocated` | lease owner/capacity 无法证明时不得 release 或启动；隔离资源并记 cleanup debt |
| `process_bound` | lease receipt 加 process identity hash | 可重试 inspect/adopt；不得重新启动未知旧进程 | lease receipt、process identity、owner/run binding | `condition.observation_process_bound` | identity 未知或 owner 不匹配时不 record/release；typed stop/隔离可证明资源，留下 cleanup debt |
| `terminal` | official terminal proof hash 与绑定的 process identity | 可重试 inspect terminal；不得把 timeout/内存结果当 terminal | process identity、lease receipt、terminal proof/artifact reference | `condition.observation_terminal` | 进程终态不能证明时保持 lease、不得 record；cleanup debt/attention，待 recover 或人工处置 |
| `recorded` | terminal proof、artifact 与 Host 重新派生的 evidence/verdict | 同 artifact+run 幂等 record 一次 | terminal proof、artifact ref、world Snapshot、condition/revision identity | `condition.observation_recorded` | artifact/evidence 关联不可证明时不产生 verdict/Finding、不释放资源；记录 cleanup debt |
| `released` | owner-CAS release receipt，且 terminal/record 已存在 | release 幂等；不得在 active process 上重试释放 | receipt、terminal proof、record event、资源 inventory | `condition.observation_released` | release 成功无法证明时资源保持保守占用，标 cleanup debt；不得假定零资源 |

`cleanup_debt` 是 projection 的阻断/注意结果而非成功阶段；它禁止 completion 与相关新行动，直到可恢复地 inspect、typed cleanup 或经权威处置闭合。资源竞争通过 lease claims（key/mode/capacity/reset）调度，绝不伪装为 obligation DAG 依赖。

## 8. Verdict、终审与手动边界

```ts
type ObservationVerdict =
  | { kind: "passed"; evidenceId: string }
  | { kind: "failed"; evidenceId: string; failureCode: string; findingFingerprint: string }
  | { kind: "inconclusive"; evidenceId: string; reason: string }
  | { kind: "infrastructure_error"; reason: string };
```

verdict 只从 Host adapter artifact 派生；Agent 不提交 command 或 verdict。仅 `failed` 物化产品 Finding；`inconclusive` 与 `infrastructure_error` 进入 blocked/attention。

`goal_finalize` 仅对 `goal-runtime.v1` 生效，并且是纯账本、Snapshot、资源和可恢复外源 review 检查：**不得调用 Observation adapter、不得启动新 Observation、不得重跑业务 Oracle。**若 Condition stale，`goal_status` 必须先签发普通 observation action；最后一次业务复验也走普通 Condition 生命周期。

完成谓词必须同时满足：

```text
所有 applicable planned/remediation Task 已 accepted 或显式 superseded
AND 所有 required Condition 在当前 Snapshot 有 fresh supporting evidence
AND 每个 stability policy 可由 evidence history 独立审计
AND 无 open/repairing/reverification Finding
AND 无 active/blocked/cancel_pending Repair Episode，且无任何 `cancelled` Episode 的 `cancellation.resourceDebt`
AND 无 active observation/executor/workspace/process/resource/cleanup debt
AND 无 suspension、pending human decision 或未分诊 discovery
AND execution revision/capability/action offer 当前有效
AND 可恢复外源 final review 无 Critical/Important
```

Manual Preview 不宣称无人值守自治；auto-continuation 必须在 M2 后另立计划，并复用 `nextObligationAction()` 与本完成谓词，不得另造状态语义。

## 9. 旧计划处置核验

下列标题处状态已核验且与本规格一致，故不作冗余改写：

- `2026-08-07-convergent-goal-execution.md`：醒目“已取代”，不得派发 Task。
- `2026-08-05-goal-finalization-gate.md`：醒目“已取代”，旧 v4/改变 Planned 完成语义假设废弃，不得派发 Task。
- `2026-08-05-goal-idle-continuation-guard.md`：醒目“暂停执行”，待 Manual Preview 后按 obligation frontier 重写，不得派发 Task。

## Repair 审批账本（R10A）

Repair 的权威事件为 `repair.challenge_created`、`repair.user_decision_recorded`、`repair.capability_consumed` 和 `repair.task_linked`。challenge 固化 goal/revision/contract/base head、episode/condition/有序 finding、action/subject、task 身份、session、时间和 challengeHash；decision 固化 Pi entry 哈希、分支绑定、choice/approved parity 与 decisionId。`authorize_task` 只能以 `goal.amended → capability_consumed → task_linked` 单一批次物化；nonce 明文仅存在 S3 临时 capability，账本只保存 digest。S1 使用 `buildRemediationTaskCandidate` 重建稳定 candidate，S2 记录真实用户 entry，S3 消费 capability；三者均不得改变 exact-eight Goal ABI。
