---
name: subagent-dispatch
description: Use when delegating coding or non-coding work to a configured Pi agent, requesting a user-approved plan review, or executing an implementation plan after the user chooses Subagent-Driven.
---

# Subagent Dispatch

## 计划 DAG 编排

用户选择 Subagent-Driven 后，按完整计划的 `Deps`、`WritePaths` 和 `Resources` 调度 DAG，重复以下步骤：

1. 将依赖已完成的未完成任务加入 ready set；需要 coding workspace 隔离时，依赖还须已合入。
2. 等待或查询状态前，在并发容量内派发所有资源兼容且写入可隔离的 ready 任务。有可派发任务且有空槽时不得等待。
3. 每个任务完成并通过适用的集成门禁后，立即重新计算 ready set 并填满空槽。`Wave` 仅供人类阅读，不是等待同批任务的屏障。
4. 审查只阻塞消费该审查产物的后继任务，不阻塞无关任务，也不要求清空在途任务。

只因真实依赖、互斥资源、不可隔离的写冲突、显式并发限制或实际派发失败限制并发。脏 worktree、想先看一个结果、逐任务审查或协调成本本身不构成串行理由。未全部派发 ready set 时记录具体限制事实。

## Coding

`dispatch-ir.v1` 调用结构决定 coding；generic object shape 决定 generic。`agent` 仅表示已发现的 profile identity，不决定 execution kind 或权限。`executor` 是普通默认 profile，可重命名；不要创建另一个固定 coding 名称替代它。同一个 profile 可以接收两种结构，但 coding 工作必须使用完整 typed 合同，不能用 generic 自由文本绕过，也不能虚构 `delegate(...)`。

可信 Host 的 `RunAuthorization` 是唯一授权来源。standalone coding 只有 `root.subscribe`，generic 没有 privileged capability。frontmatter、名称、模型、prompt 和 started event 都不能授予 coding、acceptance、Goal 或 Broker capability；Goal/acceptance 权限须来自对应可信 Host 协调流程，不能在请求或 profile 中自报。

使用精确 object shape，不加额外字段；`relevantFiles`/`writePaths` 使用仓库相对 POSIX 路径；枚举、非空数组和 criteria-only acceptance 遵循 schema。`tdd` 禁止 `workflow.reason`；`existing-tests`/`docs-only` 必须提供 reason。执行超时不由 agent 指定：coding 由 Host 注入固定 30 分钟执行 timeout，generic 的 workflow 不设执行 deadline（仅保留 runtime 内部的 child-start watchdog），由 Host/profile/runtime 决定。

### 模型合同

`model` 可省略。`requestedModel` 是输入，`resolvedModel` 是 canonical 请求，两者都不代表子进程实际模型；实际模型只认 runtime run/status/artifact metadata。路由规则如下：

| 请求 | Agent metadata | 解析 | 警告 |
| --- | --- | --- | --- |
| 省略 | 任意 | 保留 metadata/default 路由；profile 的有序 `models` 是 fallback chain。 | 无 |
| 完整 `provider/model-id` | 任意 | 在 available catalog 精确匹配 full-ID，否则失败。 | 无 |
| 裸 `model-id` | 声明了 `models` | 按声明顺序选取 ID 相符且当前可用的第一个候选；未命中即失败，不搜索全局。 | 无 |
| 裸 `model-id` | 未声明 `models` | 按 full-ID 升序选择第一个匹配的 available model。 | 仅 `MODEL_MATCH_USED_GLOBAL_CATALOG` |

使用 global-catalog 路由时，向用户转达警告。它位于顶层 `details.warnings`，与 `details.modelSelection` 分离：

```json
{
  "details": {
    "modelSelection": {
      "requestedModel": "gpt-5.6-sol",
      "resolvedModel": "codex-pool/gpt-5.6-sol",
      "source": "global-catalog"
    },
    "warnings": [
      {
        "code": "MODEL_MATCH_USED_GLOBAL_CATALOG",
        "agent": "delegate",
        "requestedModel": "gpt-5.6-sol",
        "resolvedModel": "codex-pool/gpt-5.6-sol"
      }
    ]
  }
}
```

Worktree 默认 false：省略或 false 保持 cwd、RPC、prompt 和 hash。coding 使用 `execution.worktree`，generic 使用顶层 `worktree`。true 从请求的 `baseCommit` 创建受管 worktree；source 可以保留既有 dirty，不得因为 dirty 阻止 allocation。仍须校验 source 是 primary worktree、HEAD attached、origin ref 未漂移、`baseCommit` 是允许的基线，并在 integrate 前单独检查 origin dirty。目录范围 `writePaths` 必须以 `/**` 或 `/` 结尾（如 `src/**` 或 `src/`）；裸路径按精确文件匹配。

`subagent_worktree` 只列出、检查和处置当前 root session 创建的 standalone-subagent workspace；Goal、validation、foreign-session、legacy workspace 一律不在此工具的范围。保存 dispatch 返回的 `workspace_id`；完成时 `subagent-workspace-reminder` 会作为原始主-agent上下文消息提示处置，但 completion/status 都不等于 terminal proof。

### 脏 source 与 worktree 集成

source 的既有 dirty 不阻止从指定 `baseCommit` 分配受管 worktree，也不需要为了 allocation 创建临时 checkpoint；allocation 前只记录 origin branch、origin HEAD、base commit 和 dirty 快照。workspace 只从 base commit 开发，不能继承 source 的未提交内容。

workspace 完成后，先用 `subagent_worktree` 的 `status` action 检查 `originClean`、`originError`、`originHead`、`baseCommit`、`changedFiles` 和 `integrate_blocked_reasons`。只有 origin 在集成前已 clean、workspace 是允许的 committed descendant 且 changed files 通过 `writePaths` 时，才可调用 `subagent_worktree` 的 `dispose` action（`disposition: "integrate"`）。origin 仍 dirty 时不得自动 stash、reset、覆盖、提交或把 dirty 合入；向用户报告冲突并等待决定。source 在 workspace 创建后前进、出现非线性历史或 dirty 与 workspace 改动冲突时，同样停止自动集成，保留 workspace 供人工处理。

临时 checkpoint 不是 worktree allocation 的默认方案。只有用户明确要求保存或提交既有 dirty 时，才可另行按 git-commit-convention 创建 checkpoint；该提交不属于计划产物，不能自动推送、合并、整理或删除。

Completion/status 不等于 terminal proof。只用 `subagent_worktree` 的 typed action 处置：`status` 返回 `action_token`、`allowed_dispositions` 与 `integrate_blocked_reasons`（如 `origin-advanced-nonlinear` / `writePaths-out-of-scope`）；只有官方观测的 terminal proof 才允许破坏性的 discard/integrate。`preserve` 保留；`discard` 释放干净 workspace；`integrate` 仅限通过 `writePaths` 检查的 coding，允许 origin 干净前进（并行 worktree 逐个合入）；`release` 释放 `preserved` worktree，无需 `action_token`。generic 不能 integrate。不处置则长期保留为 `awaiting-disposition`。已退役的旧 workspace ABI 不再使用，一律改用 `subagent_worktree` typed action。

按此顺序调用，并只信任 `status` 返回的 `action_token`、`allowed_dispositions` 与 `integrate_blocked_reasons`：

```js
subagent_worktree({ action: "list" })
subagent_worktree({ action: "status", workspace_id: workspaceId })
subagent_worktree({ action: "dispose", workspace_id: workspaceId, disposition: "integrate", action_token: actionToken })
subagent_worktree({ action: "release", workspace_id: workspaceId })
```

`dispose` 也可选择 `discard` 或 `preserve`；`integrate` 仅限通过 `writePaths` 门禁的 coding workspace，generic 不能 integrate。`preserve` 保留现场，完成保留用途后用 `release` 回收，且不需 action token。只有官方观测的 terminal proof 才允许破坏性的 discard/integrate。

禁止 raw git worktree add/remove/prune/move/repair/lock/unlock；所有 standalone、Goal task 和 Goal validation workspace 都由统一 workspace service 创建、绑定和处置。根级 `node scripts/worktree-lifecycle.ts audit|reconcile` 仅用于 inventory、dry-run cleanup plan 和显式 public lease authorization apply；禁止 `--force` remove、raw branch cleanup，`/tmp`、TTL、clean 不授权删除。

```js
subagent({
  version: "dispatch-ir.v1",
  taskId: "harden-dispatch-skill",
  title: "Harden dispatch Skill example",
  agent: "executor",
  model: "gpt-5.6-sol",
  risk: "normal",
  objective: "Compile the typed dispatch example.",
  workflow: {
    mode: "existing-tests",
    reason: "Existing coverage verifies the documentation change."
  },
  requirements: ["Preserve the public ABI."],
  context: {
    knownFacts: ["The Skill is repository-managed."],
    decisions: ["Use the typed coding contract."],
    relevantFiles: ["skill-overrides/subagent-dispatch/SKILL.md"]
  },
  boundaries: {
    writePaths: ["skill-overrides/subagent-dispatch/SKILL.md"],
    excludedWork: ["Do not change the runtime schema."],
    forbiddenActions: ["Do not commit."]
  },
  acceptance: {
    criteria: ["The example compiles through dispatch-ir.v1."]
  },
  execution: {
    worktree: true
  }
});
```

## Generic

使用 `{ agent, title, task }` generic 结构转发非编码任务；下例复用相同 profile，不因此获得 coding 权限：

```js
subagent({
  agent: "executor",
  title: "Review isolated diff",
  task: "Inspect the current diff and report findings.",
  worktree: true
});
```

## Reviewer 逐次批准

`reviewer` 是普通 generic profile，只用于两个时点：计划执行前审阅计划合理性；计划执行后检查完成情况，识别实现与计划的偏差并提出改进建议。它不是自动 acceptance authority，也不因名称或 frontmatter 获得 capability。

每一次实际派发前，必须取得用户针对该次审阅的明确批准。禁止自动、默认或隐式派发，禁止批量复用批准；前一次批准不可复用，选择 Subagent-Driven 不等于批准审阅。没有本次批准时，先请求批准并等待，不派发。批准后使用 generic shape，且不分配 worktree：

```js
subagent({
  agent: "reviewer",
  title: "审阅本次计划",
  task: "用户已明确批准本次计划执行前审阅。检查计划合理性，报告风险并提出改进建议。",
  worktree: false
});
```

示例中的批准陈述不是授权凭证；必须先有用户本次明确批准。执行后审阅也须单独批准，并将 task 改为检查实际完成情况与计划偏差。审阅意见不替代既定验收证据和用户决策。
