# Goal Engine 持续演进与压缩恢复设计

日期：2026-08-05

## 1. 问题

当前 Goal Engine 把一个 Goal 等同于一次预先完备的计划：`goal_init` 固化 DAG，任务全部 accepted 后自动 `goal.completed`。这对封闭交付有效，但不适合长工程的真实反馈循环：

1. 初始计划完成后，用户发现一个“小问题”；Agent 认为不值得重新 writing-plans，也不创建新 Goal。
2. 小问题实施中继续发现问题，信息只存在于聊天、未提交改动或临时命令输出。
3. compaction、reload、session replacement 发生后，摘要可能遗漏这些新发现；因为没有 active Goal，`goal_status` 也不会恢复它们。
4. 当前 `goal_amend` 只能修改 active Goal，且描述把它限制为“人类改范围/blocked”；completed Goal 不能重新打开。
5. 当前 checkpoint 只由 `goal_settle` 间接产生；探索期、任务间和完成后的跟进没有可靠 checkpoint。

原 Goal Contract 的 `feature-list.json`、`recovery.md`、`amendments.jsonl`、checkpoint reminder 和 compaction recovery guard 已证明“持续上下文账本”有价值。新设计应把这些语义吸收到 Goal Engine，而不是复活第二套状态系统。

## 2. 设计目标

- 保持恰好七个 model-facing tools：`goal_init/status/dispatch/settle/integrate/accept/amend`。
- Goal 既是任务 DAG，也是同一工程目标的持久演进账本；一次完成只是 epoch 里程碑，不是不可逆墓碑。
- 小问题不要求先写完整计划；可以直接用 `goal_amend(add_tasks=[单任务])` 持久化。
- Agent 即使忘记 amend，第一次相关写操作也会被 continuity gate 拦截并把 discovery 持久化。
- compaction 前自动写入确定性 continuity checkpoint；compaction/reload 后自动注入恢复摘要，并要求先 `goal_status`。
- 已 accepted 任务和历史 evidence 永远不可改写；新发现只能进入新任务/新 epoch。
- 无关工作可以显式标记 out-of-scope，不被旧 Goal 永久锁住。
- 保持 append-only events、并发 writer lock、Git/workspace fail-closed 和 legacy replay。

## 3. 推荐模型：可重开的 Goal Epoch

不增加新的“Project/Engagement”顶层实体。现有 Goal 变为多 epoch 日志：

```text
epoch 1: created → tasks → completed
                          │
                          ├─ discovery(out-of-scope) → resolved
                          └─ discovery(related) → reopened(epoch 2)
                                                → add tasks
                                                → tasks
                                                → completed
```

### 3.1 Projection 新字段

```js
{
  epoch: 1,
  completionHistory: [
    { epoch: 1, verdict: "COMPLETE", completedAt, eventVersion }
  ],
  coordinationState: "ready" | "needs_triage" | "blocked" | "recovery_required" | "watching" | "quiescent",
  sessionBindings: [{ sessionId, leafId, state: "watching" | "detached", boundAt }],
  continuity: {
    observations: {
      "obs-...": {
        id,
        summary,
        paths,
        source: "user_intent" | "mutation_gate" | "compaction" | "tool_error",
        status: "untriaged" | "tasked" | "out_of_scope" | "duplicate",
        taskId: null,
        sessionId,
        observedAt,
        resolvedAt: null,
        reason: null
      }
    },
    lastCheckpoint: {
      sessionId,
      reason: "manual" | "threshold" | "overflow" | "reload" | "shutdown",
      modifiedFiles,
      nextAction,
      occurredAt
    }
  },
  actionOffer: null | {
    id,
    projectionVersion,
    tool,
    params,
    consumed: false,
    offeredAt
  },
  pendingHumanDecision: null | {
    id,
    kind: "orphan_disposition",
    choices: ["discard", "preserve"],
    recordedChoice: null,
    userEntryId: null
  }
}
```

`completed` 仍表示当前 epoch 已完成；它不再禁止 continuity events。只有添加新 task 才触发 `goal.reopened` 并回到 `active`。

### 3.2 新事件

- `goal.session_bound` / `goal.session_detached`：只让绑定 session 的 follow-up 触发 continuity gate，避免仓库级误锁。
- `goal.discovery_recorded`：Extension 自动或 `goal_amend` 显式记录发现。
- `goal.discovery_resolved`：将发现关联 task，或标为 out-of-scope/duplicate/new_goal/deferred。
- `goal.contract_amended`：经真实用户批准后 append-only 修改 Objective/Scope/Non-Goals/DoD，并保存 proposal hash 与旧值摘要。
- `task.block_resolved`：workspace 已释放后将 blocked task retry，或冻结旧 task并新增 replacement；修复当前 graph 要求 amend、reducer 又拒绝 blocked task 的死路。
- `goal.continuity_checkpointed`：compaction/reload/shutdown 前的最小恢复快照。
- `goal.reopened`：completed → active，`epoch += 1`，保留 completionHistory。
- `goal.action_offered` / `goal.action_consumed`：把 status 的 machine action 变成一次性 capability。
- `goal.human_decision_requested` / `goal.human_decision_recorded`：持久绑定 orphan 的真实用户选择。

`goal.completed` 必须清空 `nextAction`、`blockedReason` 和 action offer，并追加 completionHistory。

## 4. 七工具语义演进

### `goal_status`

- 仍是恢复权威入口。
- 返回 epoch、completionHistory、untriaged discoveries、lastCheckpoint、candidate completed Goal。
- 对唯一机器动作生成一次性 `action_token`；后续 mutation 必须携带该 token。
- 若需要人类选择，不生成 mutation token，只返回 `pendingHumanDecision`。

### `goal_amend`

新增可选字段，不新增工具：

```js
{
  operation: "patch_active" | "resolve_blocked" | "triage" | "reopen_completed" | "detach_session",
  reason,
  basis: { epoch, discovery_ids? },
  add_tasks?, remove_tasks?, update_tasks?,
  update_goal?: { objective?, scope?, non_goals?, dod?, proposal_hash, approval_entry_id },
  context_update?: {
    summary,
    discoveries?: [{ id?, summary, paths?, evidence? }],
    decisions?: [string],
    next_action?: string
  },
  resolve_discoveries?: [{
    id,
    disposition: "tasked" | "out_of_scope" | "duplicate",
    task_id?,
    reason
  }],
  action_token
}
```

规则：

- active Goal：可增加新发现任务；不要求先重写完整 writing plan。
- blocked task：使用 `operation=resolve_blocked`，仅在 workspace 已释放时允许 `retry` 或 `supersede + replacement`，不得用普通 pending patch 绕过。
- `update_goal` 会改变 Objective/Scope/Non-Goals/DoD，必须绑定真实用户批准的 proposal hash；Agent 不能仅凭自己的判断调用。
- completed Goal：只有 `add_tasks` 且所有 untriaged discovery 已随 amendment 解析时，原子追加 `goal.reopened` + `goal.amended`；旧 accepted tasks 不变。
- 仅 out-of-scope/duplicate 解析时不 reopen。
- 仍禁止修改 accepted/dispatched/succeeded task。

### 其他 mutation tools

`goal_dispatch/settle/integrate/accept/amend` 必须携带上一次 `goal_status` 生成的 `action_token`。token 在 handler 进入时先以 append-only event 消耗；即使后续预检失败，也必须重新 status，消除“报错后跳过 requiredNextAction”。

`goal_init` 是唯一不需要 token 的 mutation；`goal_status` 负责发 token。

## 5. 自动 Continuity Gate

### 5.1 Goal 选择

Extension 在同一 Git root 中按以下顺序选 candidate：

1. 唯一 active Goal；
2. 最近 completed 且写入路径与 Goal scope/历史 task writePaths 相交的 Goal；
3. 多个候选时 fail closed，仅注入候选列表，要求显式 `goal_id`。

### 5.2 `before_agent_start`

- active Goal：注入 goalId/epoch/version/machine action/未解析 discoveries。
- completed-watching Goal 的绑定 session 收到新用户 entry 时，按 entry ID 幂等追加 untriaged discovery；不自动判断相关/无关，也不自动 reopen。
- recent completed Goal：注入“当前 epoch 已完成但可 reopen；先 status→triage/amend”。
- compact/reload 后：附加 lastCheckpoint，并明确“摘要不是权威，先 goal_status”。

### 5.3 `tool_call` 写门禁

对以下写入口做 preflight：

- built-in `write` / `edit`；
- coding `subagent` 的 `boundaries.writePaths`；
- shell-policy 已分类为文件/Git mutation 的 `bash`。

当绑定 session 存在 recovery latch/untriaged discovery，或路径与 active Goal 相交但没有对应 task/action token 时：

1. 追加 `goal.discovery_recorded`，保存脱敏后的用户意图摘要、路径和 session identity；
2. block 当前写调用；
3. 返回 `goal_status → goal_amend(add_tasks=...)` 或 `resolve_discoveries(out_of_scope)` 的具体恢复动作。

读取、搜索、测试和纯诊断不阻塞。无关工作通过 out-of-scope/new_goal resolution 或 `detach_session` 解锁，不要求旧 Goal 永久占用整个仓库。`goal_amend` 与 edit/write 同一批出现时仍阻断写操作，必须等 amendment durable 后下一轮再写。

## 6. Compaction 与 Session 恢复

### `session_before_compact`

对 active Goal 或存在 continuity debt 的 recent completed Goal：

- 从 `preparation.fileOps.modifiedFiles`、当前 projection、最新用户 entry identity 构造定长、脱敏 checkpoint；
- append `goal.continuity_checkpointed`；
- append 失败时取消 compaction并设置 `recovery_required` latch，不能静默丢状态；
- 不替换 Pi 默认摘要，不把完整 tool output 或凭据写入 Goal state。

### `session_compact`

- 用 `pi.sendMessage(..., { deliverAs: "nextTurn" })` 注入持久恢复提示；
- 内容只含 goalId、epoch、checkpoint id、untriaged discoveries 和“先 goal_status”。

### `session_start` / `before_agent_start`

- reload/resume/fork 后从 Goal event log 重建，不依赖 extension 内存；
- fork 共享读取历史 checkpoint，但新 mutation 仍经过 writer lock/version/action token。

## 7. Dispatch Contract ABI 与 Executor 绑定

当前 `compileCodingDispatchIR()` 返回带 `hash` 的对象，但 `subagent` typed schema 不接受 `hash`。因此“原样交付”在 ABI 上不可能，TokenRec 会话删除 hash 是被 schema 迫使的。

修复：

```js
{
  contract: { /* 精确匹配 dispatch-ir.v1 typed schema，不含 hash */ },
  contract_hash: "sha256...",
  workspace: { ... }
}
```

- Goal projection 保存 `contract_hash`。
- `tool_call(subagent)` hook 对输入重新 canonicalize/hash；taskId 命中 Goal task时必须与 projection hash 完全一致，否则 block。
- `tool_result(subagent)` 取得 runId 后 append `task.executor_bound`。
- `tool_call` 是早期诊断；subagent runtime 的 execute-time spawn identity resolver 必须再次从 Goal dispatch ticket核对 taskId/cwd/attempt/hash，防止后加载 hook 改参绕过。
- `goal_settle` 必须查到该 runId 的 official terminal proof；不能只信 completion prose。

## 8. Worktree 与 Acceptance 证明

这部分依赖 worktree lifecycle 基础设施：

- dispatch lease 记录 Goal task、contract hash、subagent runId、runner/child process identity。
- integrate/release 前检查 worktree 下无 active process cwd；发现验收启动的 App/Server 时 fail closed。
- acceptance command 由受控 process group 运行，结束/超时后统一 teardown。
- accept 前在独立 validation workspace 对 integrated commit 复跑 commands；workspace 不继承 Executor 新增的 ignored/untracked 文件。
- task acceptance 可声明 `setup_commands`；validation workspace 先运行这些命令再运行 acceptance commands。未声明时不得静默复制 origin/Executor 的 ignored runtime dependencies。

## 9. 兼容与迁移

- v1/v2 events 继续按历史语义 replay；缺失字段默认 `epoch=1`、空 continuity/history。
- 历史 blocked task 首个 v3 recovery event映射为 `coordinationState=blocked`，允许 typed `resolve_blocked`，不改写旧事件。
- 历史 completed Goal 第一次新 amendment 时追加 v3 `goal.reopened`，不改写旧日志。
- 旧调用无 action token只允许只读 `goal_status`；status 返回迁移后的 token schema。
- exact-seven ABI 测试必须继续断言工具名集合完全相等。
- 不迁移或复活 `.state/goal-contract` runtime；只把其 recovery/feature-list/checkpoint 语义迁入 Goal Engine。

## 10. 不采用的方案

### 每个小问题创建新 Goal

依赖 Agent 主观判断“小问题何时足够大”，正是当前失败点；还会造成 Goal 碎片和恢复歧义。

### 永不 completed 的单一 Goal

会失去里程碑和验收边界，active registry 永久污染；任务全绿也无法表达一个稳定版本。

### 新增 `goal_checkpoint` / `goal_reopen` 工具

会破坏 exact-seven ABI，并增加模型选错工具的概率。checkpoint/reopen 可以分别由 Extension hook 和 `goal_amend` 承担。

### 完全依赖 compaction summary

摘要不是结构化状态，无法机械验证 DAG、evidence、workspace ownership 或 human decision；只能作为恢复提示。

## 11. 完成判据

- completed-watching Goal 的绑定 session 收到后续用户消息即持久化 discovery；第一次写入在 triage 前被 block。
- 单任务 `goal_amend` 可原子 reopen completed Goal，旧 accepted evidence 不变，epoch 递增。
- threshold/overflow/manual compaction 后第一轮可从 Goal event log恢复 discovery、next action 和 modified paths。
- 任何 mutation 都不能跳过最新 status action token；失败尝试会消费 token。
- orphan discard/preserve 没有真实用户 input event 时不可执行。
- Goal dispatch 输出可直接作为 subagent typed input；任意字段漂移都在 tool_call 和 execute-time spawn resolver 两处被阻止。
- settle 前有 official terminal proof；release 前无 owner process；accept 在 clean validation workspace 复跑。
- 全部功能继续只暴露七个 Goal tools，legacy logs 可重放，writer concurrency tests 全绿。
