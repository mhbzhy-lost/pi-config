# Goal Contract: plan-ir-v3-complete-capsule-contract

## Objective
按顺序完成两份已批准计划：先交付 pi-plan.v3、plan-ir.v3、worktree 外 revision store、单写者事件协议、Plan amendment 与全链路消费者迁移；再删除独立 Standalone Host，以 Root session 内扁平 `pi-subagents` RPC runtime 承载 Plan Runner 和 Executor，并通过全部门禁。

## Why
消除批准语义丢失、多事实源、事件竞态和不可恢复 amendment，使 Plan Capsule 具备可审计、可重放的完整合同。

## Scope
- 严格执行 `docs/superpowers/plans/2026-07-29-plan-ir-v3-complete-capsule-contract.md` 的 Task 1-9。
- IR 计划 Task 9 完成后，严格执行 `docs/superpowers/plans/2026-07-29-plan-runner-flat-rpc-remove-thin-host.md` 的 Task 1-10。
- 保留 pi-plan.v1/v2、plan-ir.v1/v2 与 legacy event replay 兼容。
- 使用 TDD，所有生产逻辑改动前先观察对应测试按预期失败。
- 使用 Subagent-Driven 无人值守执行；每个 Task 独立派发、审查、验证和提交，直到两份计划全部完成。

## Non-Goals
- 不修改 `pi/npm/node_modules/pi-subagents/**`，不依赖 fanout-child、re-root 或 runtime 二级 child 身份。
- 不提供 Root B 对 Root A Plan Runner/Executor 的 attach、resume 或继续管理。
- 不采用 `pi-worktree` 替代 Plan/Attempt workspace 控制面。
- 不迁移 plan-runner-dispatch Skill 的 v3 作者指引。
- 不修改或回退 pi/settings.json 的既有用户改动。

## Invariants
- Do not silently rewrite Objective, Scope, Non-Goals, Invariants, or Definition of Done.
- Treat .state/goal-contract/registry.json and this goal directory as the local execution state.

## Missing Context Boundary
The agent does not know hidden stakeholder intent, external runtime state, or
prior decisions unless they are written in this contract, the current user
message, tracked planning documents, or evidence.jsonl.

The agent must not infer unstated scope expansion from chat summaries.

## Definition of Done
- [ ] IR v3 计划 Task 1-9 全部实现并逐项验证。
- [ ] 薄 Host 退役计划 Task 1-10 全部实现并逐项验证。
- [ ] IR v3 计划 Execution Contract 的 8 条 verification 全部通过。
- [ ] 真实 flat runtime Harness 证明 Plan Runner/Executor 同属 Root session、无 fanout parent metadata、Supervisor roundtrip、Root graceful shutdown 的 terminal-proof 顺序与异常退出无 orphan。
- [ ] 生产代码不再包含 Standalone Host、keeper、persisted Host handle 或跨 Root attach。
- [ ] 外部 review 无未解决的高置信度阻断项。
- [ ] `npm test`、`npm run doctor`、两份计划的聚焦测试与 `git diff --check` 全部通过，且未修改 pi/settings.json。

## Verification
| Claim | Evidence required | Command/artifact |
| --- | --- | --- |
| node --test test/plan-document.test.mjs test/plan-ir.test.mjs test/plan-ir-schema.test.mjs test/plan-revision-store.test.mjs | command or artifact evidence | `node --test test/plan-document.test.mjs test/plan-ir.test.mjs test/plan-ir-schema.test.mjs test/plan-revision-store.test.mjs` |
| node --test test/plan-event-writer.test.mjs test/plan-events.test.mjs test/plan-projection.test.mjs test/plan-amendment.test.mjs | command or artifact evidence | `node --test test/plan-event-writer.test.mjs test/plan-events.test.mjs test/plan-projection.test.mjs test/plan-amendment.test.mjs` |
| node --test test/plan-coordinator.test.mjs test/plan-gates.test.mjs test/plan-attempt-validator.test.mjs test/plan-integration-queue.test.mjs | command or artifact evidence | `node --test test/plan-coordinator.test.mjs test/plan-gates.test.mjs test/plan-attempt-validator.test.mjs test/plan-integration-queue.test.mjs` |
| node --test test/plan-launcher-extension.test.mjs test/plan-capsule-extension.test.mjs test/plan-runner-dependencies.test.mjs | command or artifact evidence | `node --test test/plan-launcher-extension.test.mjs test/plan-capsule-extension.test.mjs test/plan-runner-dependencies.test.mjs` |
| PI_REAL_BIN="$(command -v pi)" node --test test/plan-parallel-harness.integration.mjs | command or artifact evidence | `PI_REAL_BIN="$(command -v pi)" node --test test/plan-parallel-harness.integration.mjs` |
| PI_REAL_BIN="$(command -v pi)" node --test test/plan-flat-runtime-harness.integration.mjs | command or artifact evidence | `PI_REAL_BIN="$(command -v pi)" node --test test/plan-flat-runtime-harness.integration.mjs` |
| node --test test/root-subagent-broker-protocol.test.mjs test/root-subagent-broker.test.mjs test/plan-executor-tool-boundary.test.mjs | command or artifact evidence | `node --test test/root-subagent-broker-protocol.test.mjs test/root-subagent-broker.test.mjs test/plan-executor-tool-boundary.test.mjs` |
| no Standalone Host production references | command or artifact evidence | `rg -n "plan-host-runtime|pi-plan-host-keeper|host-handle.json|hostRunId|processIdentity|standaloneRootService|subagents-rpc-client.mjs" scripts pi test` |
| npm test | command or artifact evidence | `npm test` |
| npm run doctor | command or artifact evidence | `npm run doctor` |
| git diff --check | command or artifact evidence | `git diff --check` |

## Evidence & Runtime Lanes
Source projects:
- pi-config

Do not collapse preview, publish, runtime, eval, environment, and review evidence
into one generic verdict. A green source diff, compile, smoke test, evaluator
score, or review note proves only its own lane.

| Lane | Purpose |
| --- | --- |
| source | Code, diff, design, and repository artifact evidence. |
| build | Compile, lint, typecheck, package, and generated-config evidence. |
| runtime | Runtime logs, device/simulator state, session events, screenshots, and generated artifacts. |
| delivery | Preview, publish, release, final manifest, and downstream handoff evidence. |
| eval | Evaluator, benchmark, task suite, score, policy decision, and behavior report evidence. |
| environment | Auth, credentials, toolchain, cloud device, sandbox, and external-service blocker evidence. |
| review | Code review, security review, cross-review, user correction, and residual-risk evidence. |

Blocker taxonomy:
- environment_auth
- toolchain
- device_runtime
- external_service
- missing_evidence
- scope_conflict
- review_rejected

## Evidence Authority Ladder
When evidence sources conflict, use the highest-ranked source that is authorized
for the claim. Lower-ranked sources may be recorded as diagnostic evidence but
must not satisfy a higher-authority Definition of Done item.

| Rank | Source | Lane | Authorized claims | Notes |
| --- | --- | --- | --- | --- |
| 1 | source_trace | eval | full benchmark outcome, full conversion latency | Producer-owned phase boundary, PipelineRun, source trace, or equivalent source-of-truth manifest. |
| 2 | usage_report | eval | token usage, cost, provider/runtime usage | Provider or runtime usage report. Heuristic estimates must not be marked collected. |
| 3 | source_artifact | source | artifact shape, schema compatibility, producer output existence | Generated files, manifests, reports, schemas, or source artifacts. |
| 4 | runner_trace | environment | diagnostic wall-clock, subprocess health, wrapper failure | Runner/subprocess traces are diagnostic only unless the contract explicitly promotes them through an amendment. |
| 5 | heuristic_estimate | review | speculative estimate | May explain uncertainty; must not satisfy collected metrics or full benchmark claims. |

## Architectural Red Lines
- Harness/revision store 是 Plan Markdown 到 IR 的唯一 compiler；Main Agent 和 Plan Runner 禁止直接提交 IR JSON。
- 只有一套持久化领域 IR；selector view 不得拥有独立版本、hash 或持久化身份。
- 原始 Plan 精确字节和每个 revision artifact 不得覆盖；`plan.created/plan.amended` 是 committed revision 的唯一权威。
- 所有 Plan event append 必须经过单 Event Writer 的 reducer-before-append 与 projection-version CAS。
- accepted/integrated Task 的局部 full 合同不可改写；active effective hash 改变必须 supersede 旧 Attempt。
- IR v3 计划完成前不得开始薄 Host 退役实现；Host 退役后 Root session 是 Plan Runner/Executor 唯一生命周期 owner。
- `pi-subagents` runtime 保持扁平；Plan Runner frontmatter 不声明 builtin `subagent`，项目 adapter 注册后再激活；不得加载 fanout-child、re-root、修改上游 package 或向 upstream spawn 注入 caller parent/depth。
- Root B 不得 attach/resume Root A 的 Plan run；领域嵌套只由 Plan event、dispatch authorization 和 broker ownership 表达。
- 不得修改或回退 `pi/settings.json`。

## Drift Detectors
Run these checks before the next slice and before any completion claim:

| Detector | Invalid when | Required action |
| --- | --- | --- |
| single-compiler | Main Agent、Plan Runner 或 tool 参数直接构造 IR JSON。 | 停止实现并回到 Harness compiler 边界。 |
| single-domain-ir | 新增第二套带版本/hash/持久化身份的 Task IR。 | 标记 scope drift，改为无身份 selector view。 |
| revision-authority | 覆盖 revision 文件，或由 `current.json` 而非事件决定 committed revision。 | 标记实现无效并修复为不可变 artifact + event commit。 |
| event-cas | 任一 Plan event 绕过单写者、reducer-before-append 或 expected projection version。 | 阻止该 slice 完成，补齐 writer 接线和并发测试。 |
| historical-task-contract | amendment 修改或删除 accepted/integrated Task 的局部 full 合同。 | 拒绝 amendment；使用新增 repair Task。 |
| unrelated-settings | diff 包含本目标未授权的 `pi/settings.json` 变化。 | 不回退用户改动，但从本目标提交和完成声明中排除。 |
| host-before-ir | IR v3 Task 9 未完成时修改 Root broker、Plan Runner child dispatch 或删除 Host。 | 停止 Host 任务，恢复 IR DAG，直到 Task 9 门禁通过。 |
| nested-runtime | 新实现加载 fanout-child、re-root、修改 `PI_SUBAGENT_DEPTH` 或向 upstream spawn 传 parent metadata。 | 标记实现无效，恢复为 Root broker 扁平 forwarding。 |
| cross-root-resume | Root B 读取 persisted handle 并 attach/resume Root A run。 | 删除跨 session 管理路径，改为明确 unsupported。 |
| orphan-runtime | Root graceful/abnormal shutdown 后 Plan Runner 或 Executor 仍存活。 | 阻止完成，修复 broker ordered drain 或 ownership socket。 |

## Slice Ordering Gate
Slices must establish the authority surface before building downstream views or
integrations. If a later slice is attempted before its required predecessors,
mark the goal `needs_amendment` or `blocked`.

| Gate | Requires first | Blocks until satisfied | Reason |
| --- | --- | --- | --- |
| document-before-ir | pi-plan.v3 canonical contract | plan-ir.v3 compiler/selectors | IR 不能编译尚未冻结的文档语义。 |
| identity-before-amendment | revision store + Event Writer + revision events | plan_amend | 更新协议必须建立在不可变 artifact 和事件 CAS 之上。 |
| amendment-before-consumers | committed revision 与 supersede 恢复 | Coordinator、Queue、Gate 迁移 | 消费者必须只读取当前 event-committed revision。 |
| focused-before-full | Task 1-8 focused tests | Harness、全量测试、doctor、外部 review | 最终证据不能替代每个行为 slice 的 RED/GREEN。 |
| ir-before-flat-runtime | IR v3 Task 1-9 和 Execution Contract verification | Root broker、child adapter、Host 删除 | 避免 Coordinator/Capsule 在两个架构迁移中并发改写。 |

## Compaction Recovery Guard
Compacted chat summaries are recovery hints, not source-of-truth state. After a
context compression, resume only after reading:

1. `.state/goal-contract/registry.json`
2. this goal's `recovery.md`
3. `state.json`
4. `goal-contract.md`
5. `feature-list.json`
6. last 20 lines of `evidence.jsonl`

If these files are missing, conflict with the summary, or show multiple active
goals without an explicit `goal_id`, stop as `needs_recovery` or
`needs_amendment`. Do not continue from the compressed summary alone.

## Claim Thresholds
| Term | Required threshold |
| --- | --- |
| complete | all Definition of Done items have passing evidence |
| substantial progress | at least one named slice is completed or one blocker is removed |
| blocked | blocker remains after listed recovery attempts |
| scope drift | current action changes Objective, Scope, Non-Goals, Invariants, or Definition of Done |

## Confidence Labels
- [Evidence-Backed]: directly proven by command, diff, artifact, test, log, screenshot, or explicit user-provided fact.
- [Reasonable-Inference]: supported by evidence but not directly proven.
- [Speculative]: plausible, but missing required evidence.

## Stop Conditions
- Complete when all Definition of Done items have evidence.
- Blocked when required evidence cannot be produced with available tools.
- Needs amendment when a material branch or goal contradiction appears.

## Recovery Entry
On every resume or compaction continuation, read in order:
1. `.state/goal-contract/registry.json`
2. this goal's `recovery.md`
3. `state.json`
4. `goal-contract.md`
5. `feature-list.json`
6. last 20 lines of `evidence.jsonl`

If multiple active goals exist in the registry, require an explicit `goal_id`.

## Change Policy
The agent may propose amendments but must not silently rewrite Objective, Scope,
Non-Goals, Invariants, or Definition of Done.

## What This Contract Cannot Tell Us
- Whether external stakeholders accept the plan.
- Whether untracked runtime state outside this state root has changed.
- Whether team-shared design docs are current unless linked and verified.
