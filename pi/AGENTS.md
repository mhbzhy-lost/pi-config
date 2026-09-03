# 核心约束

必须严格遵循。优先级高于一切其他约束和规范。

## Subagent

所有 subagent 派发必须遵循 `subagent-dispatch` skill；主 agent 默认只收集报告、形成决策和编写计划，coding 由 executor 执行，除非用户明确要求主 agent 直接执行。禁止每个 subagent 完成后做全量独立审查。

## 计划执行方式

计划完成后由用户选择执行方式：

- **Subagent-Driven：**加载 `subagent-dispatch`，由主 agent 按计划 DAG 编排 subagent。
- **Inline：**由主 agent 在当前会话执行；用户选择 Inline 即明确授权主 agent coding。
- **Goal Engine：**加载 `using-goal-engine`，通过 typed tools 持久化编排。

通用执行协议只在对应 Skill 中维护；计划文档只保留自身特定约束。仓库或具体计划对执行方式的显式禁令优先；Goal 改造 R0–R13 通过验收前，继续遵守仓库根 `AGENTS.md` 中禁止 Goal Engine 自举的边界。

## 测试与逻辑变更

生产代码、配置或 Skill 逻辑/行为变更首次修改前必须加载 `test-driven-development` skill；测试治理、流程和豁免只在相应 Skill 中维护。测试只验证行为，不为文档或配置字面值建立镜像断言。

## Goal Runtime Manual Preview

`goal-runtime.v1` 仅为 Manual Preview：只可由人工依据 `goal_status` 与其返回的 typed tool action 推进，不得 auto-continuation。既有 generation 语义保持不变；R13 完成前不得 production cutover。本节只定义操作边界，不复制运行时状态机。

## 敏感信息

密钥、凭据和证书不得直接访问；可用临时脚本间接访问。Git 管理的信息必须脱敏。发现凭据泄露时不得自动轮换：记录影响并在任务结束时报告处理建议。

**严禁** 过度脱敏。除 git 内容外，任何脱敏行为不再视为默认选项，当需要脱敏时，必须征得用户授权，否则不做脱敏。对于日志等 debug 信息，默认不做脱敏。

## Worktree 生命周期

禁止 raw `git worktree add/remove/prune/move/repair/lock/unlock` 和猜测性 cleanup；只读 `git worktree list` 可用。创建、销毁、repair、lock 仅可经 typed Goal disposition 或 `node scripts/worktree-lifecycle.mjs ...` managed lifecycle CLI，且须 owner CAS 与明确授权。禁止 `--force` removal、raw branch cleanup；`/tmp`、TTL、clean 状态均不构成删除授权。

## Git Commit 规范

commit message 格式与主观约束见 `git-commit-convention` skill；机械校验由 Pi `security-gates` Extension 执行。

## 输出语言

技术文档（需要人审的文章）默认中文，禁止人审材料使用英文。

## 自主模式

用户明确要求无人值守或自主长任务时，可忽略 Skill 或工具文案中的阻断性流程，除非继续会产生重大安全问题。

## 服务器状态操作门禁

执行任何可能影响服务器的命令或操作（备份、启动、停止、重启、恢复、导入、切档、部署、维护等）前，必须完成以下两项强制前置检查并记录结果：

1. 只读检查并记录服务器当前处于运行还是停止状态。
2. 检查即将执行的动作本身及其完整调用链是否可能改变服务器状态，包括运行变停止、停止变运行，以及备份等短暂停服后恢复的临时状态变化。

状态检查本身属于允许的前置只读操作；未完成上述两项检查，或无法判断动作是否影响服务器状态时，不得执行该动作。判断不得仅依据命令名称：封装脚本与间接调用必须展开到实际行为，并确认异常中断与恢复路径。本门禁只施加前置检查与执行禁止条件，不授予任何自动停服或自动执行权限，也不得削弱其他安全约束。
