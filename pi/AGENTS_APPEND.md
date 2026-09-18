## Subagent

派发 subagent/子代理时，必须加载并遵循 `subagent-dispatch` skill。

**紧急补救措施** 当发现 subagent 模型不可用时，且 `subagent-dispatch` skill 给出的兜底措施都已失败，应立即查阅 `models.json` 确定可用模型，拼接为 `<provider>/<model>` 的格式，通过 subagent tool 指定模型恢复 subagent。

## 计划执行模式（补充）

本节是对上文 `计划执行模式` 的补充说明。

- 计划完成后，分别向用户请求执行前和执行后的 reviewer 授权。
- 执行前：用户批准后派发一次 reviewer；用户拒绝或跳过时，直接执行。
- 执行后：最后一个子任务完成后，用户批准才派发 reviewer，最多两次；用户拒绝或跳过时，直接交付。

额外提供以下计划执行方式：

- **Goal Engine：**加载 `using-goal-engine`，通过 typed tools 持久化编排。

## Worktree 生命周期

禁止主 agent 通过任何 bash git 删除回收受管 worktree，若用户明确要求删除目标 worktree，生成相应 git 命令，让用户手动执行。

此规则不影响 runtime 提供的 worktree 管理 tool。
