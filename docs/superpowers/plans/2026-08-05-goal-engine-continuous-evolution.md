# Goal Engine 持续演进与事故门禁实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Goal Engine 从“一次性完整计划执行器”升级为可跨 completed epoch、临时小修复与 compaction 持续恢复的工程上下文账本，同时修复 TokenRec 审计暴露的 dispatch identity、状态动作、人工选择、验收复现和进程生命周期缺口。

**Architecture:** 保持 exact-seven model-facing tools，通过 append-only continuity events、completed Goal reopen、`goal_amend` 的 context/discovery 语义以及 Extension lifecycle hooks 自动记录新发现。`goal_status` 发出一次性 action capability；subagent contract 在 tool_call 前做 hash 绑定；worktree/process 与 acceptance 验证复用 durable lifecycle owner，不把 Git 删除职责移入 Root Broker。

**Tech Stack:** Node.js ESM、TypeScript Pi Extensions、node:test、Git worktree、Pi `session_before_compact/before_agent_start/tool_call/tool_result` events、Root Broker terminal proof

## Global Constraints

- 精确暴露七个 Goal tools；不得新增 `goal_checkpoint`、`goal_reopen` 或 cleanup model-facing tool。
- 不复活 Plan Runner；不修改或执行归档 Plan Runner 产品代码。
- 每个逻辑修复先写中文六要素 `docs/bugs/bug-*.md`，再 tests-only RED，最后最小 GREEN。
- v1/v2 events 必须继续按历史语义 replay；新行为使用 v3 events，不改写历史日志。
- accepted task/evidence 永不可修改；completed Goal 只可通过添加新 task 进入新 epoch。
- 自动 continuity checkpoint 不保存凭据、完整 tool output 或未脱敏用户输入。
- Root Broker 提供 process ownership/terminal proof，不执行 Git worktree 删除。
- acceptance/validation workspace 依赖 `docs/superpowers/plans/2026-08-05-worktree-lifecycle-reclamation.md` 的 managed owner API；该外部依赖未完成时 Task 8 不得开始。
- `pi/settings.json` 保持用户修改且 SHA-256 为 `7b9c3ace7929e9c3a3e13dfb024188f55a619089f002fa754083971e60559adf`。

## 文件职责

| 文件 | 职责 |
|---|---|
| `scripts/lib/goal-engine/events.mjs` | v3 continuity/reopen/action/decision reducer 与 invariant |
| `scripts/lib/goal-engine/continuity.mjs` | candidate 选择、路径相交、脱敏 observation/checkpoint |
| `scripts/lib/goal-engine/action-offer.mjs` | status action capability 发放/消费纯逻辑 |
| `scripts/lib/goal-engine/human-decision.mjs` | 真实 input entry 与 orphan choice 绑定 |
| `scripts/lib/goal-engine/dispatch.mjs` | subagent-compatible contract envelope |
| `scripts/lib/goal-engine/executor-binding.mjs` | contract hash、runId、Root Broker terminal proof 绑定 |
| `scripts/lib/goal-engine/extension.mjs` | 七工具与 Pi lifecycle/tool hooks 接线 |
| `scripts/lib/worktree-lifecycle/**` | validation workspace、process-aware release（来自 worktree 计划） |
| `scripts/lib/subagent-dispatch/root-broker-server.ts` | terminal proof 只读查询接口 |
| `skill-overrides/using-goal-engine/SKILL.md` | 小问题 reopen、compaction recovery、action token 流程 |

## DAG

```text
G1 Event epoch/reopen ───────┐
                             ├──> G4 Continuity core ──┐
G3 Action capability ────────┘                         │
G3 Action capability ───────────> G5 Human decision ──┤
G2 Dispatch ABI ───────────────────────────────────────┼──> G6 Extension integration ──> G7 Executor terminal binding ──> G8 Validation/process release ──> G10 Full verification
G9 Shell broad-stage gate ─────────────────────────────┘                 │
Worktree lifecycle T2-T4 ────────────────────────────────────────────────┘
G6 ───────────────────────────────────────────────────────> G9 Skill/migration docs ───────────────────────────────────────────────┘
```

依赖理由：

- G4 只依赖 G1 的 projection contract 与 G3 的 action/debt shape，不依赖 Extension 大文件。
- G5 只依赖 G3 的 decision challenge/action offer，可与 G4 并行。
- G6 是唯一早期 Extension 集成热点，依赖 G1–G5 的稳定接口，避免多个任务并发修改 `extension.mjs`。
- G7 依赖 G2 的 canonical hash 与 G6 的 hook 注入点；Root Broker 只增加查询接口。
- G8 依赖 G7 的 runId/terminal proof和外部 worktree lifecycle T2–T4 的 owner/create/release API。
- G9 shell gate 可先独立实现；Skill 文档更新必须等待 G6 的真实 schema。

## 并行调度组（Wave）

- **Wave 1:** G1、G2、G3、G9a（shell broad-stage gate）
- **Wave 2:** G4、G5；同时执行 worktree lifecycle 计划的 T1/T2
- **Wave 3:** G6；同时继续 worktree lifecycle T3/T4/T5/T6
- **Wave 4:** G7、G9b（Skill/迁移文档）
- **Wave 5:** G8
- **Wave 6:** G10

Wave 不是派发屏障；所有前驱完成即可派发。

---

### Task G1: v3 Epoch、Discovery 与 Reopen Reducer

**Deps:** none

**WritePaths:**
- `docs/bugs/bug-goal-engine-completed-goal-cannot-capture-followups.md`
- `docs/bugs/bug-goal-completed-retains-stale-next-action.md`
- `scripts/lib/goal-engine/events.mjs`
- `scripts/lib/goal-engine/store.mjs`
- `test/goal-engine-events.test.mjs`

**Interfaces:**
- Produces events: `goal.discovery_recorded`、`goal.discovery_resolved`、`goal.continuity_checkpointed`、`goal.reopened`、`goal.contract_amended`
- Produces projection: `epoch`、`completionHistory`、`continuity`
- `goal.completed` clears `nextAction/blockedReason` and appends history

- [ ] **Step 1: 写两份根因文档**

记录 completed 后 `requireActive` 拒绝 amend、settle-only checkpoint 导致小修复在 compaction 丢失，以及 `goalCompleted()` 未清空过期 nextAction。

- [ ] **Step 2: 写 RED reducer tests**

```js
test("completed goal records discovery and reopens into a new immutable epoch", () => {
  let p = completedV3Goal();
  p = applyEvent(p, v3("goal.discovery_recorded", { id: "obs-1", summary: "follow-up", paths: ["src/a.ts"], source: "user_intent", sessionId: "s1" }));
  p = applyEvent(p, v3("goal.reopened", { reason: "Turn follow-up into a task", observationIds: ["obs-1"] }));
  p = applyEvent(p, v3("goal.amended", { reason: "Add follow-up task safely", addTasks: { t2: taskDef("src/a.ts") } }));
  assert.equal(p.epoch, 2);
  assert.equal(p.tasks.get("t1").status, "accepted");
  assert.equal(p.tasks.get("t2").status, "pending");
});
```

另断言 completed 后 `nextAction === null`，不能 update/remove accepted t1；`goal.contract_amended` 保存旧 metadata 摘要/proposal hash，缺用户 approval identity 时 reducer 拒绝。

- [ ] **Step 3: 验证 RED**

Run: `node --test test/goal-engine-events.test.mjs`

Expected: FAIL，事件不支持或 completed Goal 拒绝 continuity/reopen。

- [ ] **Step 4: 最小 GREEN 与 legacy replay**

v1/v2 projection 默认 epoch 1/空 continuity；只有 v3 允许 reopen。`goal.reopened` 必须要求 completed、全部旧 task accepted、至少一个 observation 被解析为 tasked。

- [ ] **Step 5: 验证并提交**

Run: `node --test test/goal-engine-events.test.mjs`

```bash
git add docs/bugs/bug-goal-engine-completed-goal-cannot-capture-followups.md docs/bugs/bug-goal-completed-retains-stale-next-action.md scripts/lib/goal-engine/events.mjs scripts/lib/goal-engine/store.mjs test/goal-engine-events.test.mjs
git commit -m "feat(goal-engine): 支持完成目标按纪元重新开启"
```

---

### Task G2: Dispatch Contract ABI Envelope

**Deps:** none

**WritePaths:**
- `docs/bugs/bug-goal-dispatch-contract-hash-conflicts-with-subagent-schema.md`
- `scripts/lib/goal-engine/dispatch-ir.mjs`
- `scripts/lib/goal-engine/dispatch.mjs`
- `test/goal-engine-dispatch.test.mjs`

**Interfaces:**
- Produces:

```js
splitDispatchEnvelope(ir) => {
  contract: DispatchIRWithoutHash,
  contractHash: string
}
```

- `contract` keys exactly match `dispatch-ir.v1` subagent typed schema；hash stays in envelope/projection

- [ ] **Step 1: 记录 ABI 根因**

说明 `compileCodingDispatchIR` 返回 top-level `hash`，而 subagent schema拒绝 unknown field，导致“原样交付”不可能；TokenRec 删除 hash 不是自由选择。

- [ ] **Step 2: 写 RED**

```js
const { contract, contractHash } = splitDispatchEnvelope(compileTaskContract(...));
assert.equal(Object.hasOwn(contract, "hash"), false);
assert.equal(compileCodingDispatchIR(contract, { cwd }).hash, contractHash);
assert.deepEqual(Object.keys(contract).sort(), EXPECTED_SUBAGENT_KEYS);
```

- [ ] **Step 3: 验证 RED**

Run: `node --test test/goal-engine-dispatch.test.mjs`

Expected: FAIL，helper 不存在或 contract 仍含 hash。

- [ ] **Step 4: 最小 GREEN**

canonical hash 算法保持不变；只分离 transport envelope，不改变 rendered Executor prompt 中的 SHA-256。

- [ ] **Step 5: 验证并提交**

```bash
node --test test/goal-engine-dispatch.test.mjs
git add docs/bugs/bug-goal-dispatch-contract-hash-conflicts-with-subagent-schema.md scripts/lib/goal-engine/dispatch-ir.mjs scripts/lib/goal-engine/dispatch.mjs test/goal-engine-dispatch.test.mjs
git commit -m "fix(goal-engine): 对齐派发契约与 Subagent ABI"
```

---

### Task G3: 一次性 Status Action Capability

**Deps:** none

**WritePaths:**
- `docs/bugs/bug-goal-engine-required-next-action-is-not-enforced.md`
- `scripts/lib/goal-engine/action-offer.mjs`
- `test/goal-engine-action-offer.test.mjs`

**Interfaces:**
- Produces:

```js
issueActionOffer(projection, machineAction, sessionId) => eventData
verifyAndConsumeActionOffer(projection, { token, tool, params, sessionId }) => eventData
```

- Token binds goalId、projection version、tool、required params、sessionId、random nonce

- [ ] **Step 1: 记录根因**

记录 TokenRec 在 settle error 明确要求 status 后直接 subagent，以及多条 settle→integrate→accept 连调；文本 requiredNextAction 不是门禁。

- [ ] **Step 2: 写 RED**

测试一次 offer 只能消费一次、参数/goal/session/version 漂移被拒、失败 mutation 已消费 token 后必须重新 status。

- [ ] **Step 3: 验证 RED**

Run: `node --test test/goal-engine-action-offer.test.mjs`

Expected: FAIL，模块不存在。

- [ ] **Step 4: 最小 GREEN**

使用 `randomUUID()` nonce 和 canonical SHA-256；token 本身不含 secret，不依赖进程内 Map。offer/consume 都由后续 G6 作为 append-only event 持久化。

- [ ] **Step 5: 提交**

```bash
git add docs/bugs/bug-goal-engine-required-next-action-is-not-enforced.md scripts/lib/goal-engine/action-offer.mjs test/goal-engine-action-offer.test.mjs
git commit -m "feat(goal-engine): 为机器动作签发一次性能力"
```

---

### Task G4: Continuity Candidate、Observation 与 Compaction Snapshot

**Deps:** G1, G3

**WritePaths:**
- `scripts/lib/goal-engine/continuity.mjs`
- `test/goal-engine-continuity.test.mjs`

**Interfaces:**
- Produces:

```js
selectContinuityCandidate({ projections, cwd, paths })
buildDiscovery({ userText, paths, sessionId, source })
buildContinuityCheckpoint({ projection, sessionId, reason, modifiedFiles, userEntryId })
formatRecoveryInjection(projection)
```

- [ ] **Step 1: 写 RED**

覆盖唯一 active、最近 completed path overlap、多候选歧义、无关路径、secret redaction、2KB 上限、modifiedFiles 去重和 deterministic output。

- [ ] **Step 2: 验证 RED**

Run: `node --test test/goal-engine-continuity.test.mjs`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 最小 GREEN**

脱敏至少覆盖 `Authorization/Cookie/Bearer/*_TOKEN/*_KEY`；不保存 tool output。多候选返回 `ambiguous`，不得自行选择。

- [ ] **Step 4: 提交**

```bash
git add scripts/lib/goal-engine/continuity.mjs test/goal-engine-continuity.test.mjs
git commit -m "feat(goal-engine): 构建持续上下文与压缩快照"
```

---

### Task G5: Orphan 与 Goal 元数据的真实人工决策绑定

**Deps:** G3

**WritePaths:**
- `docs/bugs/bug-goal-engine-orphan-choice-is-not-bound-to-user-input.md`
- `scripts/lib/goal-engine/human-decision.mjs`
- `test/goal-engine-human-decision.test.mjs`

**Interfaces:**
- Produces:

```js
recordHumanChoice({ inputEvent, challenge, sessionId })
hashGoalMetadataProposal({ objective, scope, nonGoals, dod })
```

- 仅接受 source=`interactive|rpc` 的真实 user input；extension 注入消息不可授权
- Objective/Scope/Non-Goals/DoD amendment 必须绑定用户批准的 proposal hash

- [ ] **Step 1: 记录根因并写 RED**

TokenRec 用户只说“看 status”，Agent 自行 discard。测试要求只有 challenge 之后、同 session、精确 choice 的用户 input 才生成 recorded decision；另测试 Agent 未展示 metadata proposal 或用户只说“继续”时不能修改 Objective/Scope/Non-Goals/DoD。

- [ ] **Step 2: 验证 RED**

Run: `node --test test/goal-engine-human-decision.test.mjs`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 最小 GREEN**

允许规范化的 `discard/丢弃` 与 `preserve/保留`，但包含两者、引用旧消息或 extension source 均拒绝。

- [ ] **Step 4: 提交**

```bash
git add docs/bugs/bug-goal-engine-orphan-choice-is-not-bound-to-user-input.md scripts/lib/goal-engine/human-decision.mjs test/goal-engine-human-decision.test.mjs
git commit -m "fix(goal-engine): 将孤儿处置绑定真实用户选择"
```

---

### Task G6: 七工具与 Pi Lifecycle Hook 集成

**Deps:** G1, G2, G3, G4, G5

**WritePaths:**
- `scripts/lib/goal-engine/extension.mjs`
- `pi/extensions/goal-engine.ts`
- `test/goal-engine-extension.test.mjs`
- `test/goal-engine-runtime.integration.mjs`
- `test/helpers/pi-host.mjs`

**Interfaces:**
- Consumes: G1–G5 全部纯接口
- Produces: v3 `goal_status/goal_amend` schema、action_token gate、compact/reload recovery hooks

- [ ] **Step 1: 扩展 mock Pi 并写 RED**

Mock 必须支持 `input/before_agent_start/tool_call/session_before_compact/session_compact/session_start`。测试场景：

1. completed Goal 后 `edit` 相交路径被 block并记录 discovery；
2. `goal_amend(add_tasks + resolve_discoveries + action_token)` 原子 reopen epoch 2；
3. out-of-scope resolution 不 reopen并解锁无关路径；
4. compaction 写 checkpoint，下一轮注入 goalId/epoch并要求 status；
5. mutation 没 token、错 token、重放 token均拒绝；
6. `update_goal` 未绑定真实用户批准的 proposal hash 时拒绝，批准后 append `goal.contract_amended`；
7. exact tool names 仍是七个。

- [ ] **Step 2: 验证 RED**

Run: `node --test test/goal-engine-extension.test.mjs test/goal-engine-runtime.integration.mjs`

Expected: FAIL，缺 hook/schema/action token。

- [ ] **Step 3: 最小 GREEN**

`goal_status` 发 offer event后返回 token；mutation handler第一步 append consume event，再做业务预检。`goal_amend` 在 completed 上先验证完整 candidate，再原子 append reopen/amend/resolve 事件序列。

- [ ] **Step 4: overflow/reload 真实 Host GREEN**

用 Pi Host fixture触发 `session_before_compact(reason=overflow, willRetry=true)`；新 extension instance从 event log恢复，不能依赖 module Map。

- [ ] **Step 5: 提交**

```bash
git add scripts/lib/goal-engine/extension.mjs pi/extensions/goal-engine.ts test/goal-engine-extension.test.mjs test/goal-engine-runtime.integration.mjs test/helpers/pi-host.mjs
git commit -m "feat(goal-engine): 自动持久化发现并恢复压缩上下文"
```

---

### Task G7: Subagent Contract Hash、runId 与 Terminal Proof

**Deps:** G2, G6

**WritePaths:**
- `docs/bugs/bug-goal-engine-settle-lacks-executor-terminal-binding.md`
- `scripts/lib/goal-engine/executor-binding.mjs`
- `scripts/lib/goal-engine/events.mjs`
- `scripts/lib/goal-engine/extension.mjs`
- `scripts/lib/subagent-dispatch/root-broker-server.ts`
- `scripts/lib/subagent-dispatch/root-broker-registry.ts`
- `test/goal-engine-executor-binding.test.mjs`
- `test/root-subagent-broker.test.mjs`
- `test/goal-engine-extension.test.mjs`

**Interfaces:**
- Root Broker produces read-only:

```ts
getOwnedRun(runId: string): OwnedRun | undefined
getTerminalProof(runId: string): ProcessTerminalProof | undefined
```

- Goal events: `task.executor_bound { taskId, attempt, runId, contractHash, asyncDir }`

- [ ] **Step 1: 记录根因与写 RED**

测试 Goal contract title/context 任一字符变化时 `tool_call(subagent)` 被 block；精确 contract通过。subagent result绑定 runId；terminal proof缺失/identity conflict时 settle失败，observed proof才成功。

- [ ] **Step 2: 验证 RED**

Run: `node --test test/goal-engine-executor-binding.test.mjs test/root-subagent-broker.test.mjs test/goal-engine-extension.test.mjs`

Expected: FAIL，缺查询接口/binding event/hash preflight。

- [ ] **Step 3: 最小 GREEN**

Root Broker 只暴露冻结副本查询，不开放 Map或Git操作。Goal hook对 taskId命中才校验；非 Goal subagent不受影响。

- [ ] **Step 4: 提交**

```bash
git add docs/bugs/bug-goal-engine-settle-lacks-executor-terminal-binding.md scripts/lib/goal-engine/executor-binding.mjs scripts/lib/goal-engine/events.mjs scripts/lib/goal-engine/extension.mjs scripts/lib/subagent-dispatch/root-broker-server.ts scripts/lib/subagent-dispatch/root-broker-registry.ts test/goal-engine-executor-binding.test.mjs test/root-subagent-broker.test.mjs test/goal-engine-extension.test.mjs
git commit -m "fix(goal-engine): 绑定执行契约运行与终止证明"
```

---

### Task G8: Clean Validation Workspace 与 Process-aware Release

**Deps:** G7；外部依赖 worktree lifecycle plan Task 2（managed API）、Task 3（Goal allocation intent）、Task 4（cleanup debt）

**WritePaths:**
- `docs/bugs/bug-goal-engine-accepts-workspace-dependent-on-ignored-files.md`
- `scripts/lib/goal-engine/acceptance-runner.mjs`
- `scripts/lib/goal-engine/workspace.mjs`
- `scripts/lib/goal-engine/extension.mjs`
- `scripts/lib/worktree-lifecycle/managed-worktree.mjs`
- `test/goal-engine-acceptance-runner.test.mjs`
- `test/goal-engine-workspace.test.mjs`
- `test/worktree-lifecycle-managed.test.mjs`

**Interfaces:**
- Produces:

```js
runAcceptanceInValidationWorkspace({ repoRoot, commit, commands, owner, timeoutMs })
```

- Process group必须在 success/failure/timeout 后 terminal；release前 inventory 无 active cwd owner

- [ ] **Step 1: 记录根因与写 RED**

以 TokenRec task1 fixture复现：Executor worktree有 ignored `Tests/.../.gitkeep` 时命令通过，但 commit validation workspace失败。另建后台 child fixture，断言 process活着时 release被拒，runner teardown 后才允许。

- [ ] **Step 2: 验证 RED**

Run: `node --test test/goal-engine-acceptance-runner.test.mjs test/goal-engine-workspace.test.mjs test/worktree-lifecycle-managed.test.mjs`

Expected: FAIL，accept不复跑或release忽略进程。

- [ ] **Step 3: 最小 GREEN**

Validation workspace从 integrated commit创建，不复制 Executor ignored/untracked 文件；显式 dependency setup属于 task contract，缺失即失败。command运行在独立 process group，finally终止并验证 birth identity。

- [ ] **Step 4: 提交**

```bash
git add docs/bugs/bug-goal-engine-accepts-workspace-dependent-on-ignored-files.md scripts/lib/goal-engine/acceptance-runner.mjs scripts/lib/goal-engine/workspace.mjs scripts/lib/goal-engine/extension.mjs scripts/lib/worktree-lifecycle/managed-worktree.mjs test/goal-engine-acceptance-runner.test.mjs test/goal-engine-workspace.test.mjs test/worktree-lifecycle-managed.test.mjs
git commit -m "fix(goal-engine): 在干净工作树复验并阻止活跃进程释放"
```

---

### Task G9a: 禁止 Agent 宽泛暂存并误收并发文件

**Deps:** none

**WritePaths:**
- `docs/bugs/bug-shell-policy-allows-broad-agent-staging.md`
- `scripts/lib/shell-policy.mjs`
- `test/shell-policy.test.mjs`

**Interfaces:**
- Agent shell禁止：`git add -A`、`git add .`、`git commit -a`
- 允许显式 `git add path1 path2`；用户 `!` shell不受 Agent policy影响

- [ ] **Step 1: 记录根因与写 RED**

记录 TokenRec 并发会话用 `git add -A` 把另一个会话刚创建的计划文档收入 `96d9410`。写 table-driven tests覆盖命令组合和 quoted path。

- [ ] **Step 2: 验证 RED**

Run: `node --test test/shell-policy.test.mjs`

Expected: FAIL，宽泛 staging 当前允许。

- [ ] **Step 3: 最小 GREEN 与提交**

```bash
node --test test/shell-policy.test.mjs
git add docs/bugs/bug-shell-policy-allows-broad-agent-staging.md scripts/lib/shell-policy.mjs test/shell-policy.test.mjs
git commit -m "fix(git): 阻止 Agent 宽泛暂存并发文件"
```

---

### Task G9b: Skill、Doctor 与旧 Goal Contract 语义迁移

**Deps:** G6

**WritePaths:**
- `skill-overrides/using-goal-engine/SKILL.md`
- `pi/AGENTS.md`
- `scripts/doctor.mjs`
- `test/using-goal-engine-skill.test.mjs`
- `test/doctor.test.mjs`
- `docs/superpowers/specs/2026-08-05-goal-engine-continuous-evolution-design.md`

**Interfaces:**
- 文档流程：小问题 `status → amend(single task)`，无需 writing-plans；completed Goal相关写入先 reopen
- Doctor报告 continuity debt、stale action offer、unresolved human decision

- [ ] **Step 1: 写 docs tests RED**

断言 Skill包含 epoch/reopen、single-task amendment、compaction recovery、action token、out-of-scope resolution；同时继续包含 typed-only/orphan/workspace禁令。

- [ ] **Step 2: 验证 RED**

Run: `node --test test/using-goal-engine-skill.test.mjs test/doctor.test.mjs`

Expected: FAIL，文档和 Doctor缺新语义。

- [ ] **Step 3: 最小 GREEN**

明确 `.state/goal-contract` 只作历史参考，不作为第二 runtime；恢复顺序改为 Goal projection → continuity checkpoint → observations → task DAG/evidence。

- [ ] **Step 4: 提交**

```bash
git add skill-overrides/using-goal-engine/SKILL.md pi/AGENTS.md scripts/doctor.mjs test/using-goal-engine-skill.test.mjs test/doctor.test.mjs docs/superpowers/specs/2026-08-05-goal-engine-continuous-evolution-design.md
git commit -m "docs(goal-engine): 规范持续演进与压缩恢复流程"
```

---

### Task G10: 迁移、真实 Pi Canary 与独立复审

**Deps:** G7, G8, G9a, G9b

**WritePaths:**
- `docs/summaries/2026-08-05-goal-engine-continuous-evolution-verification.md`
- `test/goal-engine-runtime.integration.mjs`
- `test/pi-runtime.integration.mjs`

**Interfaces:**
- Produces: exact-seven ABI、legacy replay、reopen/compaction、contract hash、terminal/process/validation 证据

- [ ] **Step 1: Legacy 与并发回归**

Run:

```bash
node --test test/goal-engine-events.test.mjs test/goal-engine-extension.test.mjs test/goal-engine-workspace.test.mjs test/goal-engine-runtime.integration.mjs
node --test test/root-subagent-broker.test.mjs test/pi-subagents-runtime.integration.mjs
```

- [ ] **Step 2: 真实 Pi 连续演进 canary**

在临时 Git repo：初始化两任务 Goal并完成 epoch 1；发送一个相关“小修复”用户输入；直接 edit应被 block并生成 observation；用单 task amendment reopen epoch 2；触发 manual 与 overflow compaction；reload 后 status恢复 observation/action；完成 epoch 2。

- [ ] **Step 3: 真实 contract/terminal/validation canary**

验证 Goal `contract` 可不改一字传给 subagent；改 title 的调用被 block；Executor terminal前 settle被拒；ignored-only fixture在 validation workspace失败；后台 process存在时 release失败。

- [ ] **Step 4: 全仓与 Doctor**

Run:

```bash
npm test
npm run doctor
git diff --check
```

确认唯一既有安装期前置若仍存在，必须单列且不能把真实 startup integration误报为失败。

- [ ] **Step 5: 两轮上限独立复审**

第一轮审查状态机降级、token replay、session/fork、secret redaction、Root Broker权限、process identity、validation cleanup；只有真实 Critical/Important 修复后运行第二轮。

- [ ] **Step 6: 记录并提交**

```bash
git add docs/summaries/2026-08-05-goal-engine-continuous-evolution-verification.md test/goal-engine-runtime.integration.mjs test/pi-runtime.integration.mjs
git commit -m "test(goal-engine): 验证持续演进与压缩恢复闭环"
```

**Acceptance Commands:**

```bash
node --test test/goal-engine-*.test.mjs test/root-subagent-broker.test.mjs test/shell-policy.test.mjs
node --test test/goal-engine-runtime.integration.mjs test/pi-runtime.integration.mjs test/pi-subagents-runtime.integration.mjs
npm test
npm run doctor
git diff --check
```
