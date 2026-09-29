## Subagent

**紧急补救措施** 当发现 subagent 模型不可用时，应立即查阅 `models.json` 确定可用模型，拼接为 `<provider>/<model>` 的格式，通过 subagent tool 指定模型恢复 subagent。

### 派发格式

coding（修改仓库文件）：`{agent, task, writePaths, acceptance:{criteria}}` 必填，`{title, model, worktree, cwd}` 可选。
generic（纯文本/调研）：`{agent, task}` 必填，`{title, model}` 可选。

```js
// coding
subagent({ agent: "executor", task: "修复登录 bug", writePaths: ["src/auth/**"], acceptance: { criteria: ["测试通过"] }, worktree: true });
// generic
subagent({ agent: "reviewer", task: "审阅当前 diff 并报告风险" });
```

### 计划 DAG 编排

用户选择 Subagent-Driven 后，按完整计划的 `Deps`、`WritePaths` 和 `Resources` 调度 DAG：

1. 将依赖已完成的未完成任务加入 ready set；需要 coding workspace 隔离时，依赖还须已合入。
2. 在并发容量内派发所有资源兼容且写入可隔离的 ready 任务。有可派发任务且有空槽时不得等待。
3. 每个任务完成并通过适用的集成门禁后，立即重新计算 ready set 并填满空槽。`Wave` 仅供人类阅读，不是等待同批任务的屏障。

只因真实依赖、互斥资源、不可隔离的写冲突、显式并发限制或实际派发失败限制并发。脏 worktree、想先看一个结果、逐任务审查或协调成本本身不构成串行理由。

### 派发适合性

派发前核对：任务的正确完成状态是否依赖执行中发现的新信息。是 → 探索型任务（先派只读诊断，产出报告落盘，修复任务引用报告原文）；否 → 执行型任务（正常派发）。

- 主 agent 刚亲自读取过原始证据且变更点单一明确时，直接 inline 修复，不派发。
- 粒度上限是一次派发一个精确变更：blocker、high、测试分属不同派发。
- 预计执行时长（含测试）必须低于 30 分钟 watchdog；修复与真实运行不得打包进同一派发。
- child 环境不继承 skills（PI_SUBAGENT_INHERIT_SKILLS=0）："加载 skill" 的落地方式是把 skill 文件路径写入 task 并要求执行者先 read。coding 派发涉及生产变更时，task 必须包含 TDD skill 路径。

| 粒度 | 可派发 |
|---|---|
| 微（单点修复，根因已定位） | ✅ 附报告原文 |
| 小（单模块功能） | ✅ |
| 中（跨模块端到端） | ✅ 附架构上下文 |
| 大（多阶段） | 先拆解 |

### 派发停止条件（Escalation）

每次派发必须在 task 中包含停止条件：列出发现什么情况时应停下通过 contact_supervisor 询问而不是继续执行。通用停止条件：

- 前提与现场证据矛盾时；
- 需要写入 writePaths 之外的文件时；
- 任务的验收标准与实际观测不可能同时满足时。

### 模型分级

- 用户明确指定模型时，遵照用户指令。
- 使用裸 model-id 进行模型选择；裸名解析失败不是正常 fallback：停止派发并报告。
- review 任务使用 review 档（`reviewer`）；复杂开发使用 primary 档（`delegate`）；确定性执行使用 deterministic 档（`executor`）。
- 档位能力不足时降优先级拆小任务，不升档。

### Worktree 选择

- 并发写入同一仓库优先 `worktree: true`（隔离基线 + Auto Integration 串行 publish）。
- 只读任务、写路径互不重叠、或单 child 任务不需要 worktree。
- 用户明确禁止 worktree 时不得使用。
- `writePaths` 文法：仓库相对 POSIX 路径，精确路径（`src/a.ts`）或末尾 `/**` 的递归目录（`src/**`）；不允许尾随 `/`、glob 通配符、`.`/`..`、绝对路径。

### Workspace 处置

`worktree: true` 的 dispatch 返回 `workspace_id`。完成后按此顺序处置：

```js
subagent_worktree({ action: "status", workspace_id: workspaceId })
subagent_worktree({ action: "dispose", workspace_id: workspaceId, disposition: "integrate", action_token: actionToken })
// 或 preserve 暂留后 release
subagent_worktree({ action: "release", workspace_id: workspaceId })
```

- `status` 返回 `action_token`、`allowed_dispositions` 与 `integrate_blocked_reasons`；只信任这些值。
- integrate/discard 完成处置；preserve 暂留，之后手动 release。
- origin dirty 时不得自动 stash/reset/覆盖；向用户报告并等待决定。
- 禁止 raw git worktree 命令操作 managed workspace。

### 生命周期

- dispatch 后不 sleep/poll；完成通知自动到达。
- `status` 仅限用户要求、干预或诊断。
- `interrupt` 后用 `resume` 恢复；stopped 不可恢复。
- completion/status 不等于 terminal proof。

### 安全边界

- 不输出 token/credential/authorization 内容。
- TUI 只渲染精简投影，不改写 raw payload。

### Reviewer 逐次批准

每次实际派发 reviewer 前必须取得用户明确批准。禁止自动、默认或隐式派发。选择 Subagent-Driven 不等于批准审阅。

## 计划执行模式（补充）

本节是对上文 `计划执行模式` 的补充说明。

- 计划完成后，分别向用户请求执行前和执行后的 reviewer 授权。
- 执行前：用户批准后派发一次 reviewer；用户拒绝或跳过时，直接执行。
- 执行后：最后一个子任务完成后，用户批准才派发 reviewer，最多两次；用户拒绝或跳过时，直接交付。

## Worktree 生命周期

禁止主 agent 通过任何 bash git 删除回收受管 worktree，若用户明确要求删除目标 worktree，生成相应 git 命令，让用户手动执行。

此规则不影响 runtime 提供的 worktree 管理 tool。

## 模型黑名单

主 agent 与 subagent 均不使用 deepseek 系列模型。
