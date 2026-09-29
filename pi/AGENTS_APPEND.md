## Subagent

派发 subagent/子代理时，必须加载并遵循 `subagent-dispatch` skill。

**紧急补救措施** 当发现 subagent 模型不可用时，且 `subagent-dispatch` skill 给出的兜底措施都已失败，应立即查阅 `models.json` 确定可用模型，拼接为 `<provider>/<model>` 的格式，通过 subagent tool 指定模型恢复 subagent。

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

## Subagent Dispatch 运行时约束

### 派发
- coding（修改仓库文件）必须提供 `writePaths` 和 `acceptance.criteria`。
- generic（纯文本/调研）只需 `agent` 和 `task`。
- 并发写入同一仓库的子任务应使用 `worktree: true` 隔离。
- 用户明确禁止 worktree 时不得使用。

### 生命周期
- dispatch 后不 sleep/poll；完成通知自动到达。
- `status` 仅限用户要求、干预或诊断。
- `interrupt` 后用 `resume` 恢复；stopped 不可恢复。

### Workspace 处置
- `worktree: true` 返回 `workspace_id`。
- 完成后：`subagent_worktree({action:"status"})` → integrate/discard 完成处置，或 preserve 暂留后 release。
- 不使用 raw git worktree 命令。

### 安全边界
- 不输出 token/credential/authorization 内容。
- TUI 只渲染精简投影，不改写 raw payload。
- completion/status 不等于 terminal proof。

### Reviewer 批准
- 每次实际派发 reviewer 前必须取得用户明确批准。
