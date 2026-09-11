## Subagent

所有 subagent 派发必须遵循 `subagent-dispatch` skill；主 agent 默认只收集报告、形成决策和编写计划，除非用户明确要求主 agent 直接执行。

禁止每个 subagent 完成后做全量独立审查。

**紧急补救措施** 当发现 subagent 模型不可用时，应立即查阅 `models.json` 确定可用模型，拼接为 `<provider>/<model>` 的格式，通过 subagent tool 指定模型恢复 subagent。

## 对计划文档的附加要求

计划文档在编写完成后，必须派发独立 `reviewer` subagent 进行且仅进行一次审查，主 agent 根据审查意见修改计划后正常执行。

计划在执行完毕后，即最后一个子任务执行完毕后，必须派发 `reviewer` subagent 对整体完成情况进行一次审查，最多两次，主 agent 根据审查意见做修复后向用户报告计划执行结果。

为保证主 agent 不会遗漏计划完成后的 review 阶段，要求在计划文档当中必须写明 **计划完成后派发 reviewer 执行一次 review。**

额外提供以下计划执行方式：

- **Goal Engine：**加载 `using-goal-engine`，通过 typed tools 持久化编排。

## Goal Runtime Manual Preview

`goal-runtime.v1` 仅为 Manual Preview：只可由人工依据 `goal_status` 与其返回的 typed tool action 推进，不得 auto-continuation。既有 generation 语义保持不变；R13 完成前不得 production cutover。本节只定义操作边界，不复制运行时状态机。

## Worktree 生命周期

禁止通过任何 bash git 操作清理 worktree，若用户明确要求清理，生成相应 git 命令，让用户手动执行。
