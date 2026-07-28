# Goal Contract: plan-runner-pi-subagents-parallel-harness

## Objective
按批准计划将 Plan Runner 迁移为Standalone Plan Runner加薄Host Runtime，并以pi-subagents公开RPC作为Executor后端的确定性并行Harness

## Why
为 Crash Fix V2 等大型计划提供隔离 writer、向上通信、验证、串行集成和可恢复执行能力

## Tracked Plan
- `docs/superpowers/plans/2026-07-24-plan-runner-pi-subagents-parallel-harness.md`
- 计划由当前 `pi-plan.v1` parser 验证为 14 个 Task、30 条依赖边。

## Scope
- 执行 docs/superpowers/plans/2026-07-24-plan-runner-pi-subagents-parallel-harness.md 的 14 个 Task
- 保留 Plan event、IR、Gate 与 validatedHead 作为编排事实源
- 使用 per-attempt worktree、资源锁、正式wait、native Supervisor、durable Plan Control和Integration Queue
- 保留只启动和监管Standalone Plan Runner的薄Host Runtime；Executor生命周期全部委托官方pi-subagents

## Non-Goals
- 不执行 Agent 生成的编排脚本
- 不修改 Crash Fix V2 业务代码
- 不长期保留自建Executor Runtime；薄Host只管理Standalone Plan Runner生命周期
- 不自动 merge 或 push 用户仓库

## Invariants
- Do not silently rewrite Objective, Scope, Non-Goals, Invariants, or Definition of Done.
- Treat .state/goal-contract/registry.json and this goal directory as the local execution state.

## Missing Context Boundary
The agent does not know hidden stakeholder intent, external runtime state, or
prior decisions unless they are written in this contract, the current user
message, tracked planning documents, or evidence.jsonl.

The agent must not infer unstated scope expansion from chat summaries.

## Definition of Done
- [x] 真实pi-subagents Standalone兼容性硬门禁通过
- [x] 每个并行 Attempt 使用独占 worktree 且越界修改被拒绝
- [x] Executor AttentionRequest 可经native Supervisor和durable Plan Control两级往返
- [x] 唯一 Integration Queue 串行推进 accumulator HEAD
- [x] 通用自建Executor Runtime删除、薄Host边界冻结且完整故障矩阵通过
- [x] 四类 Gate 对同一 clean HEAD 通过并产生 validatedHead

## Verification
| Claim | Evidence required | Command/artifact |
| --- | --- | --- |
| npm test | command or artifact evidence | `npm test` |
| npm run doctor | command or artifact evidence | `npm run doctor` |
| PI_REAL_BIN="$(command -v pi)" npm run test:subagents | command or artifact evidence | `PI_REAL_BIN="$(command -v pi)" npm run test:subagents` |
| PI_REAL_BIN="$(command -v pi)" npm run test:plan-harness | command or artifact evidence | `PI_REAL_BIN="$(command -v pi)" npm run test:plan-harness` |
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
| 1 | plan_event_and_git | source | Plan领域状态、Attempt所有权、result commit、accumulator HEAD、validatedHead | Append-only Plan event与受控Git命令共同证明领域迁移和文件结果。 |
| 2 | pi_subagents_lifecycle | runtime | runId、asyncDir、sessionId、运行状态、Supervisor transport | 只证明执行Runtime事实，不产生Task accepted或Plan validated。 |
| 3 | deterministic_test | build | parser、reducer、workspace、锁、验证、集成和故障矩阵行为 | 只证明覆盖场景，不替代真实Runtime兼容门禁。 |
| 4 | independent_review | review | 架构、安全、恢复和完整性finding | Critical或Important finding未清零时不能完成。 |
| 5 | status_projection | environment | 观察和诊断 | status.json、widget和dashboard是可再生投影，不能驱动迁移。 |

## Architectural Red Lines
- Agent不得生成或执行编排脚本，也不得直接调用`subagent`派发Attempt。
- Standalone Plan Runner不得带`PI_SUBAGENT_CHILD`或fanout环境，不得deep import或重建pi-subagents内部服务。
- 薄Host只能管理Standalone Plan Runner，不能派发Executor或产生Plan accepted/integrated/validated事实。
- 并行writer不得共享cwd；每个Attempt必须有独占worktree、base commit和owner token。
- `pi-subagents worktree:true`不得替代Harness workspace allocator。
- status projection、RPC文本、stdout或dashboard不得成为Plan领域事实源。
- `dispatch-requested`但无唯一run事实时不得自动重试spawn。
- Integration Queue之外的组件不得写accumulator worktree。
- 通用自建Executor Runtime不得作为迁移失败后的长期fallback；薄Host不属于Executor Runtime。

## Drift Detectors
Run these checks before the next slice and before any completion claim:

| Detector | Invalid when | Required action |
| --- | --- | --- |
| no-agent-owned-dispatch | Plan Agent或Executor直接调用`subagent`、改变cwd、worktree或dispatch参数。 | 标记scope drift并停止派发。 |
| unique-attempt-workspace | 两个active Attempt具有相同canonical cwd、branch或owner token。 | 立即block Plan并保留全部workspace。 |
| no-runtime-authority-collapse | RPC文本、stdout、widget或status projection被用于产生accepted、integrated或validated。 | 撤销该结论并从Plan event、artifact和Git重新投影。 |
| no-automatic-uncertain-retry | `dispatch-requested`缺少唯一run binding时再次spawn。 | 标记协议违规并停止计划。 |
| single-integration-writer | 非Integration Queue修改accumulator或自动rebase/cherry-pick。 | 中止集成并验证accumulator HEAD。 |
| no-legacy-runtime-fallback | 兼容门禁失败后继续扩展通用`spawnPiAgent`派发Executor。 | 设置goal为blocked，要求修复或升级pi-subagents能力；薄Host只能管理Plan Runner。 |

## Slice Ordering Gate
Slices must establish the authority surface before building downstream views or
integrations. If a later slice is attempted before its required predecessors,
mark the goal `needs_amendment` or `blocked`.

| Gate | Requires first | Blocks until satisfied | Reason |
| --- | --- | --- | --- |
| compatibility-before-adapter | Task 1真实0.37.0、TypeBox、RPC active status、正式wait、Supervisor、Standalone session重建和`nestedEvents=0`门禁 | Task 2至Task 14 | 禁止在不兼容Runtime上继续投入或恢复自建Executor Runtime。 |
| contracts-before-dispatch | Task 2至Task 6的IR、事件、workspace、锁和backend | Coordinator直接并行派发 | spawn前必须能够证明授权和所有权。 |
| validation-before-integration | Attempt validator及负向测试 | Integration Queue接收结果 | 未验证commit不得进入accumulator。 |
| fault-matrix-before-deletion | Standalone迁移、薄Host边界和真实故障矩阵 | 删除通用Executor Runtime | 保留一次可回退的实施窗口，但不长期双运行。 |
| full-gates-before-completion | 自动测试、Doctor、真实集成和独立审查 | goal complete | 各证据lane不能相互替代。 |

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
- 未来Pi、pi-subagents或TypeBox版本是否继续保持当前RPC、lifecycle session file和Supervisor语义；版本变化必须重跑兼容门禁。
- macOS/Node没有pidfd式原子signal；重复`processIdentity`核验将竞态收窄并fail closed，但不能提供内核级原子句柄保证。
- 上游nested event replay超过1000文件的缺陷何时修复；当前Executor无`subagent`能力且真实门禁要求`nestedEvents=0`。
