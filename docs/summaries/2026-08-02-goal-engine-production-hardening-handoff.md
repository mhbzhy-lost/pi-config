# Goal Engine 生产化加固 Handoff

日期：2026-08-02

## 1. 当前结论

Goal Engine 的核心事件存储、DAG 调度、独立 worktree、跨轮次 lease 恢复、显式集成和审计链路已经通过真实业务仓验证，但尚不应宣称为“无人值守生产可用”。

当前建议的投入范围：

- 单机。
- 单 coordinator。
- 有人监督。
- Git 基线已提交。
- task 具有明确 `writePaths` 和验收命令。
- executor 失败时允许 coordinator 介入。

尚未满足的生产条件：

1. `goal_accept` 依赖 AGENTS 协议要求“先 integrate”，状态机本身尚未持久化并强制该事实。
2. `goal_status` 尚未返回机器可读的 `allowedActions` / `requiredNextAction`。
3. 当前只有 `pi/AGENTS.md` 中的简短协议，没有 Goal Engine coordinator 专用 Skill。
4. 专用 `executor` 从 pi-config 之外的业务仓 worktree 启动时，配置仓 Extension 路径解析仍会失败。
5. 当前状态持久化在目标仓本地 `.state/goal-engine/`，未设计多机或多 coordinator 一致性。

因此下一阶段目标不是继续增加工具数量，而是把真实运行中依赖 agent 记忆的跨工具不变量下沉到状态机，再补齐精简 AGENTS 入口、专用 Skill 和跨仓真实 Harness。

## 2. 已完成实现

Goal Engine 主实现提交：

```text
6fd8d05 feat(goal-engine): 增加独立长任务执行引擎 Extension
1c74bb7 fix(goal-engine): 恢复跨轮次 worktree 并忽略运行时产物
ac6d215 fix(goal-engine): 补全 docs 合同并回收失败 workspace
```

主要文件：

```text
scripts/lib/goal-engine/audit.mjs
scripts/lib/goal-engine/dispatch-ir.mjs
scripts/lib/goal-engine/dispatch.mjs
scripts/lib/goal-engine/events.mjs
scripts/lib/goal-engine/extension.mjs
scripts/lib/goal-engine/graph.mjs
scripts/lib/goal-engine/store.mjs
scripts/lib/goal-engine/workspace.mjs
scripts/goal-engine-audit.mjs
```

当前测试：

```text
test/goal-engine-audit.test.mjs
test/goal-engine-dispatch.test.mjs
test/goal-engine-events.test.mjs
test/goal-engine-extension.test.mjs
test/goal-engine-graph.test.mjs
test/goal-engine-workspace.test.mjs
```

`ac6d215` 上 Goal Engine 全量结果为：

```text
54 tests
54 pass
0 fail
```

## 3. 真实验证任务

验证目标仓：

```text
/Users/leshi.zhy/crash-analyzer
```

### 3.1 第一轮：新增崩溃统计功能

DAG：

```text
stats-core
   ├── dao-aggregation
   └── report-formatter
          \         /
           cli-command
```

验证能力：

- 真实 subagent 在独立 worktree 工作。
- 两个无依赖任务并行执行。
- coordinator 审查后提交 executor 成果。
- `settle -> integrate -> accept` 生命周期。
- failed attempt 清理和第二次 dispatch。
- 跨 Extension 实例恢复持久 lease。
- cherry-pick 回主 worktree。

第一轮功能测试通过，但独立审查在 Goal completed 后才执行，发现生产数据语义问题。由于 Goal 已终态，外部 evidence 无法回写；audit 为 `DEGRADED`。

该结果证明：

- Goal Engine 可以完成执行链路。
- 测试通过不能代替业务审查。
- 最终独立 review 必须在 DAG 中预先建模，不能在 Goal completed 后补做。

### 3.2 第二轮：生产语义修复

DAG：

```text
stats-semantics
   ├── processing-timing
   └── cli-resilience
          \         /
       independent-review
```

结果：

```text
4/4 tasks accepted
completion verdict: COMPLETE
Goal audit: HEALTHY
total events: 19
checkpoints: 4
failed attempts: 0
external evidence: true
signals: []
```

独立 reviewer 结果：

```text
68 targeted tests passed
597 unit tests passed
targeted Ruff passed
isolated CLI probe passed
verdict: ACCEPT
```

独立报告：

```text
/Users/leshi.zhy/crash-analyzer/reports/crash-stats-remediation-review.md
```

## 4. 真实运行暴露并已修复的问题

### 4.1 Extension 重建后 lease 丢失

问题文档：

```text
docs/bugs/bug-goal-engine-loses-worktree-lease-across-turns.md
```

修复：从 `.state/goal-engine/worktrees/*.lease.json` 恢复 lease，不再只依赖进程内 `activeLeases`。

### 4.2 `.pi-subagents/` 被判为脏工作区

问题文档：

```text
docs/bugs/bug-goal-engine-blocks-runtime-artifacts-in-worktree.md
```

修复：仅忽略未跟踪的 `.pi-subagents/` runtime artifact；普通未跟踪文件仍阻止 integrate。

### 4.3 docs-only dispatch 失败并遗留孤儿 worktree

问题文档：

```text
docs/bugs/bug-goal-engine-docs-dispatch-leaks-worktree.md
```

修复：

- docs-only 合同自动生成 `workflow.reason`。
- 合同编译或 dispatched event 写入失败时补偿释放 worktree、branch 和 lease。

## 5. 当前开放的生产阻塞

### 5.1 P0：专用 executor 无法跨业务仓启动

问题文档：

```text
docs/bugs/bug-executor-owner-extension-cwd-breaks-cross-repo-dispatch.md
```

根因：

```text
pi/agents/executor.md
```

中的：

```yaml
subagentOnlyExtensions: pi/child-extensions/root-session-owner.ts
```

会按 child 的业务仓 cwd 解析，而 Extension 及其相对 import 实际属于 pi-config。

真实表现：

- executor 在 session 创建和模型调用前失败。
- 在业务仓增加入口 symlink 只能推进到下一层相对 import 失败。
- 本次 Goal Engine 业务验证只能使用真实 `delegate` 作为兼容 executor。

禁止的临时方案：

- 不得把 pi-config broker 代码复制到业务仓。
- 不得长期保留 compatibility symlink。
- 不得移除 Root ownership guard。
- 不得把启动失败记为业务 task 代码失败。

该问题未修复前，不得声称 typed `executor` 跨仓生产链路可用。

### 5.2 P0：integrate 事实未进入事件状态机

当前 AGENTS 规定：

```text
settle -> integrate -> accept
```

但 projection 只知道：

```text
pending -> dispatched -> succeeded -> accepted
```

`goal_integrate` 操作 Git 和 workspace，却不追加可恢复的 integration/disposition event。因此：

- 新 coordinator 无法仅从 projection 证明 task 已 integrate。
- `goal_accept` 无法机械拒绝“未 integrate 的 succeeded task”。
- audit 无法验证主分支实际接收了哪个 executor commit。
- preserve/discard/integrate 的最终处置只存在于工具返回值和磁盘副作用中。

这是下一阶段最优先的 Goal Engine 状态机工作。

### 5.3 P1：缺少机器可读的下一步

`goal_status` 当前返回 status、runnable、progress 和 task 信息，但没有：

```json
{
  "allowedActions": ["goal_integrate"],
  "requiredNextAction": {
    "tool": "goal_integrate",
    "reason": "Task succeeded but workspace has not been integrated"
  }
}
```

agent 仍需从多段自然语言描述推断时序。

### 5.4 P1：缺少 Goal Engine coordinator Skill

当前 Skill 白名单：

```text
skill-overrides/skills.list
```

尚无：

```text
goal-engine-coordinator
```

现有 `pi/AGENTS.md` 已有 Goal Engine 基础协议，但没有完整覆盖：

- Goal DAG 设计。
- writePaths 并行分区。
- executor commit 要求。
- failed/blocked/preserve/retry 流程。
- compaction 恢复。
- 最终 external review 建模。
- audit verdict 解释。
- 常见 orphan/lease/worktree 故障处理。

## 6. 推荐架构

生产版本应采用四层责任模型。

### 6.1 第一层：运行时状态机

负责不可绕过的业务不变量，是唯一安全边界。

必须机械强制：

- 未 succeeded，拒绝 integrate。
- 未 integrated，拒绝 accept。
- discard/preserve 的 workspace 不允许 accept 为成功任务。
- task 已 accepted 后拒绝再次操作 lease。
- dispatch 中间失败自动补偿外部资源。
- external-review task 存在时，未 accepted 不得完成 Goal。

### 6.2 第二层：typed tools

负责局部参数、前置状态、立即副作用和返回结果。

工具描述不应重复完整 coordinator 手册，但必须明确：

- 当前什么状态可调用。
- 成功后状态如何变化。
- 失败是否有副作用。
- 下一步通常调用什么工具。

### 6.3 第三层：精简 AGENTS.md

始终加载，只保存硬规则和 Skill 激活条件。

建议目标文本：

```markdown
## Goal Engine

当 `goal_status` 返回活跃 Goal 时，进入 coordinator 模式并加载
`goal-engine-coordinator` Skill。

硬约束：

1. 新会话或 compaction 后首先调用 `goal_status`
2. 只 dispatch `runnable` 中的 task
3. coding task 必须使用 `goal_dispatch` 返回的合同和 worktree
4. 成功路径固定为 `settle -> integrate -> verify -> accept`
5. failed task 必须 settle，再 discard/preserve，之后才能 retry
6. 最终独立审查必须在 Goal DAG 中建模
7. 不得从对话摘要推断 Goal 状态
8. 不得手工编辑 `.state/goal-engine/` 绕过事件状态机
```

最终文字应与实际状态机一致；若未实现独立 verify 状态，不得提前在 AGENTS 中承诺。

### 6.4 第四层：goal-engine-coordinator Skill

建议新增：

```text
skill-overrides/goal-engine-coordinator/SKILL.md
```

并加入：

```text
skill-overrides/skills.list
```

Skill 应包含：

1. 适用与不适用场景。
2. Git/基线/工作区前置检查。
3. Goal DAG 和 `writePaths` 设计方法。
4. 标准成功生命周期。
5. 并行 dispatch 规则。
6. executor 合同和 commit 要求。
7. coordinator diff/test/review 清单。
8. failed、blocked、discard、preserve、retry 流程。
9. compaction 和进程重启恢复。
10. human amendment 流程。
11. external review/evidence 设计。
12. completion verdict 和 audit 信号解释。
13. lease/worktree/orphan 常见故障恢复。
14. 真实示例，但不得绑定 crash-analyzer 私有业务语义。

标准路径应明确写成：

```text
成功：
dispatch -> executor -> review -> commit -> settle(succeeded)
-> integrate -> verify -> accept

失败重试：
dispatch -> executor failed -> settle(failed)
-> discard -> dispatch attempt N+1

外部验收：
implementation tasks accepted
-> dispatch independent-review
-> settle(external_review, source=external)
-> integrate report -> accept -> audit
```

## 7. 推荐任务 DAG

```text
T1 integration-events-and-accept-guard
   -> T2 status-next-action-projection
      -> T3 agents-protocol-refresh
      -> T4 coordinator-skill

T5 cross-repo-executor-extension-resolution

{T1, T2, T3, T4, T5}
   -> T6 real-production-harness-and-external-review
```

T3 与 T4 在 T2 协议稳定后可并行。T5 与 T1/T2 可并行，但 T6 必须等待全部完成。

## 8. Task 级实施要求

### Task 1：持久化 workspace disposition 和 integration 事实

建议写入范围：

```text
scripts/lib/goal-engine/events.mjs
scripts/lib/goal-engine/extension.mjs
scripts/lib/goal-engine/audit.mjs
scripts/lib/goal-engine/workspace.mjs
test/goal-engine-events.test.mjs
test/goal-engine-extension.test.mjs
test/goal-engine-audit.test.mjs
```

推荐事件：

```text
task.workspace_disposed
```

建议数据：

```json
{
  "taskId": "t1",
  "attempt": 1,
  "action": "integrated",
  "strategy": "cherry-pick",
  "executorHead": "...",
  "originHead": "...",
  "branch": "ge/...",
  "workspacePath": "..."
}
```

`action` 至少覆盖：

```text
integrated
discarded
preserved
```

projection 建议增加：

```json
{
  "workspace": {
    "attempt": 1,
    "disposition": "integrated",
    "executorHead": "...",
    "originHead": "..."
  }
}
```

核心门禁：

- `goal_integrate` 必须在 Git 操作成功后追加 disposition event。
- `goal_accept` 必须读取 projection，只有 `succeeded + integrated` 可通过。
- no-commit workspace 不得返回 integrated；应明确失败或设计 `no_changes` disposition，并为其定义 accept 规则。
- discard/preserve 后不能把同一 succeeded attempt 直接 accept。
- Extension 重建后，仅凭 events/projection 就能判断是否已 integrate。

注意：事件追加和 Git 副作用不具备数据库事务。必须为“Git 已成功、event 写入失败”的恢复策略写 RED；不能只覆盖 happy path。

### Task 2：机器可读状态和下一步

建议写入范围：

```text
scripts/lib/goal-engine/extension.mjs
scripts/lib/goal-engine/graph.mjs
test/goal-engine-extension.test.mjs
test/goal-engine-graph.test.mjs
```

`goal_status` 每个 task 至少返回：

```text
status
attempt
workspace disposition
allowedActions
requiredNextAction
blockingReason
```

示例：

```json
{
  "status": "succeeded",
  "allowedActions": ["goal_integrate", "goal_settle"],
  "requiredNextAction": {
    "tool": "goal_integrate",
    "params": {"action": "integrate"},
    "reason": "Executor result is succeeded but not integrated"
  }
}
```

要求：

- `allowedActions` 必须由 projection 推导，不从内存 lease 推导。
- compact 后新 Extension 实例返回相同结果。
- 多个 runnable task 的下一步必须可分别表达。
- terminal Goal 返回空 allowedActions。

### Task 3：精简 AGENTS Goal 协议

写入范围：

```text
pi/AGENTS.md
```

这是纯文档任务，但必须等待 Task 1/2 的真实状态机和字段名稳定。

要求：

- 保留 coordinator 激活条件。
- 增加 Skill 加载条件。
- 只写硬约束，不复制 Skill 全文。
- 不描述尚未实现的工具或状态。
- 与 `goal_status.requiredNextAction` 的语义一致。

### Task 4：新增 coordinator Skill

建议写入范围：

```text
skill-overrides/goal-engine-coordinator/SKILL.md
skill-overrides/skills.list
skill-overrides/README.md
test/doctor.test.mjs
test/skill-whitelist-extension.test.mjs
```

如果仓库已有 Skill 测试 fixture 或 snapshot，应按现有模式扩展，不新增平行白名单机制。

Skill 必须通过压力场景验证：

1. 用户催促立即执行，agent 仍先 `goal_status`。
2. compact 摘要声称 task 已完成，但 projection 显示 dispatched，agent 以 projection 为准。
3. executor 返回“测试通过”但无 commit，agent 不直接 integrate/accept。
4. succeeded task 尚未 integrate，agent 不能 accept。
5. Goal 需要外部验收，agent 把 reviewer 建模为最终 task。
6. dispatch 失败留下疑似 workspace 时，agent 不手工删 state，而按恢复协议处理。

### Task 5：修复跨仓 executor Extension 解析

权威问题文档：

```text
docs/bugs/bug-executor-owner-extension-cwd-breaks-cross-repo-dispatch.md
```

修复必须保持配置仓模块身份和相对 import 语义，不能只让入口 `access()` 通过。

最低真实 RED：

- 创建不含 `pi/child-extensions` 和 `scripts/lib/subagent-dispatch` 的临时 Git 业务仓。
- 从该业务仓 worktree 启动真实 typed executor。
- 证明 owner Extension 成功加载。
- 证明 Root ownership subscription/grant 生效。
- 证明 child 正常 shutdown/dispose。

必须覆盖：

- 普通跨仓 executor。
- Root broker grant 尚未就绪时的有界重试。
- Root closing/socket EOF。
- session shutdown 幂等 dispose。
- child 不加载 `fanout-child`，不获得嵌套 subagent 权限。

### Task 6：真实生产 Harness 与外部复审

目标：使用 typed `executor`，不再使用 delegate 兼容路径，完成一个跨仓、多 task、含失败重试和外部审查的真实 Goal。

建议 DAG 至少包含：

```text
core
  ├── branch-a
  └── branch-b
       \      /
       integration
           |
    independent-review
```

必须注入并验证：

1. 至少两个并行 task。
2. 至少一次 Extension 重建后继续 integrate。
3. 至少一次 executor 失败、discard、attempt N+1。
4. 至少一个 docs-only reviewer task。
5. 至少一次 Git 成功/事件恢复边界测试。
6. 最终 external evidence。
7. audit 为 `HEALTHY` 且 signals 为空。
8. worktree、branch、lease 全部清理。

最终必须由独立 reviewer 检查：

- 代码不变量。
- 恢复语义。
- audit 证据。
- 无 orphan 资源。
- AGENTS、Skill、tool schema 和运行时行为一致。

## 9. TDD 与验证要求

所有逻辑变更必须先加载 `test-driven-development` Skill，严格 RED -> GREEN -> REFACTOR。

Bug 修复必须先写：

```text
docs/bugs/bug-<摘要>.md
```

最低门禁：

```bash
node --test test/goal-engine-*.test.mjs
node --test test/doctor.test.mjs
node --test test/skill-whitelist-extension.test.mjs
npm run doctor
```

跨仓 executor 修复必须额外运行真实 Pi/子进程 Harness；只 mock `access()`、只做路径单测或只在 pi-config cwd 运行不算验收。

不要直接复用本 handoff 中的旧测试数字作为新 HEAD 证据。任何 Goal Engine、subagent runtime、agent profile、Extension 或 Skill 白名单变化后，都必须在冻结的新 HEAD 上重新运行对应门禁。

## 10. 禁止的捷径

- 不得认为 tool description 足以替代状态机门禁。
- 不得只改 AGENTS/Skill，而不让 `goal_accept` 拒绝非法状态。
- 不得手工编辑 `.state/goal-engine/events.jsonl` 或 projection 制造完成状态。
- 不得通过复制/symlink 配置仓 Extension 到业务仓解决跨仓 executor。
- 不得把 generic `delegate` 验证描述成 typed executor 验证。
- 不得在 Goal completed 后才补 external review，再声称 evidence 已进入事件流。
- 不得在 executor 无 commit 时把 workspace 当作已 integrated。
- 不得回退当前工作区中与本任务无关的 Plan Runner、Settings、Skill 或 Goal Contract 修改。

## 11. 接手后的第一步

1. 阅读本 handoff。
2. 阅读 `pi/AGENTS.md` 当前 Goal Engine 协议。
3. 阅读三个已修 Goal Engine bug 文档和跨仓 executor 开放 bug 文档。
4. 运行 `goal_status`；若存在活跃 Goal，以 projection 为唯一进度来源。
5. 检查当前 `git status`，保护所有已有未提交修改。
6. 为 Task 1 建立新的 Goal 或实施计划。
7. 加载 TDD Skill，先写 integration event/accept guard 的 RED。
8. 不要先写 AGENTS 或 Skill；先稳定运行时协议，再写指导层。

推荐的第一个 RED：

```text
新 Extension 实例读取一个 task=succeeded、没有 workspace disposition event 的 projection，
调用 goal_accept 必须失败；追加 integrated disposition event 后，同一 accept 才成功。
```

该 RED 能直接固定下一阶段最关键的生产不变量。

## 12. Definition of Done

只有全部满足以下条件，才能把 Goal Engine 标记为无人值守生产候选：

- integration/disposition 事实持久化并可恢复。
- `goal_accept` 机械拒绝未集成 task。
- `goal_status` 返回机器可读 allowed actions 和 required next action。
- 精简 AGENTS 与 coordinator Skill 均存在且通过白名单/doctor。
- typed executor 可从外部业务仓 worktree 启动。
- 真实跨仓 Harness 覆盖并行、失败重试、重启恢复、docs review 和外部 evidence。
- 新冻结 HEAD 上 Goal Engine、Skill、doctor、真实 Harness 全部通过。
- 独立 reviewer 无高/中风险发现。
- 最终 audit 为 `HEALTHY`，signals 为空。
- 所有临时 worktree、branch、lease 和 child process 已清理。
