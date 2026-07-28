# Goal Contract: footer-native-child-conversation

## Objective
完成 Footer 原生 Child Conversation 实施计划并取得自动化、SDK reload 与真实 iTerm2 验收证据

## Why
恢复未完成的 TUI 改造，同时保持 typed subagent runtime 隔离和三行 footer

## Scope
- 执行 docs/superpowers/plans/2026-07-28-footer-native-child-conversation.md 的剩余 Task 1-6
- 使用 dispatch-ir.v1 subagent-driven 实施，每个逻辑切片严格 TDD
- 保留 native Fleet fallback、read-only child browser 和 custom footer ownership

## Non-Goals
- 不修复 docs/bugs/bug-pi-tui-dynamic-refresh-clears-scrollback.md 描述的主会话物理 scrollback 架构问题
- 不暴露 upstream pi-subagents 模型资源或工具定义
- 不修改 node_modules 作为持久修复

## Invariants
- Do not silently rewrite Objective, Scope, Non-Goals, Invariants, or Definition of Done.
- Treat .state/goal-contract/registry.json and this goal directory as the local execution state.

## Missing Context Boundary
The agent does not know hidden stakeholder intent, external runtime state, or
prior decisions unless they are written in this contract, the current user
message, tracked planning documents, or evidence.jsonl.

The agent must not infer unstated scope expansion from chat summaries.

## Definition of Done
- [x] 原生 SessionManager/components 渲染、完整 viewport 按键、active/history footer 和生命周期 teardown 按计划实现
- [x] 计划列出的聚焦测试全部通过且 git diff --check 通过
- [x] fresh SDK 连续 reload 无 extension errors 且每次低于 1 秒
- [x] 真实 iTerm2 验收矩阵完成并回填证据；无法自动化的用户交互必须明确标为待用户确认，不能声称 complete

## Verification
| Claim | Evidence required | Command/artifact |
| --- | --- | --- |
| 运行计划 Task 6 Step 2 的完整聚焦测试命令 | command or artifact evidence | `运行计划 Task 6 Step 2 的完整聚焦测试命令` |
| 运行真实 SDK reload probe | command or artifact evidence | `运行真实 SDK reload probe` |
| 执行 Task 6 Step 5 的 iTerm2 验收矩阵 | command or artifact evidence | `执行 Task 6 Step 5 的 iTerm2 验收矩阵` |

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
- Non-Goals are executable boundaries, not advisory preferences.
- A wrapper, harness, replay, compile-only task, or subprocess wall-clock must
  not satisfy a full benchmark or end-to-end outcome claim unless this contract
  is amended before implementation.
- If the required producer/source manifest is absent, report `not_run`,
  `incomplete`, or `missing_evidence`; do not infer the business outcome from
  runner traces.

## Drift Detectors
Run these checks before the next slice and before any completion claim:

| Detector | Invalid when | Required action |
| --- | --- | --- |
| no-harness-owned-business-stages | A full benchmark path adds harness-owned subprocess business stages instead of reading producer output. | Mark scope drift and propose an amendment before continuing. |
| no-full-latency-without-source-trace | A dashboard or trend reports full conversion p95/p99 without source_trace/PipelineRun evidence. | Mark the result invalid or not_run/incomplete. |
| runner-trace-diagnostic-only | runner_trace, wrapper wall-clock, replay, compile-only, or partial task evidence satisfies a full benchmark DoD item. | Move the claim to diagnostic evidence and keep the benchmark incomplete. |
| no-heuristic-collected-usage | Heuristic token or cost estimates are labeled collected. | Mark usage as estimated or missing_evidence. |

## Slice Ordering Gate
Slices must establish the authority surface before building downstream views or
integrations. If a later slice is attempted before its required predecessors,
mark the goal `needs_amendment` or `blocked`.

| Gate | Requires first | Blocks until satisfied | Reason |
| --- | --- | --- | --- |
| protocol-before-dashboard | source-of-truth schema, read-only ingest, producer manifest example | dashboard, trend, full benchmark gate, producer integration | A visible dashboard must not be built on wrapper-derived business facts. |
| gate-before-integration | full benchmark validity rules, negative tests for forbidden evidence | D2/DX producer rollout, autonomous execution handoff | Producer integrations must enter through the same evidence authority contract. |

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
