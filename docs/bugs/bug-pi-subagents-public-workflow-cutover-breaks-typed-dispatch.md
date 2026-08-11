# pi-subagents 公共工作流切换使 typed dispatch 失效

## 现象

将运行时从 `pi-subagents@0.37.2` 升级到 `0.45.x` 后，现有 typed RPC spawn 被拒绝：它仍发送顶层 `agent`、`task` 和 `clarify:false`，而新版只接受非空的 `workflowScript`。

## 根因

`0.45.x` 将公开 execution 面切换为受限 workflow interpreter。顶层 direct execution、chain/parallel 和 clarify UI 都被拒绝；child 必须由 `runs.run(key, { agent, task, ... })` 启动。现有 coding acceptance 还声明 `level:"verified"` 却没有真实 `verify` 命令，违反新版 acceptance 校验。

## 影响

coding 与 generic dispatch 无法启动；即使外层 workflow 获得 `runId`，它也不是 Executor leaf。若将外层 id 交给 Root Broker、Goal binding、title registry 或 terminal proof，会把 workflow 与真正子进程混淆。

## 不变量

上游 workflow ABI 不暴露给模型。项目私有 adapter 只能生成一个异步、无 worktree、无 mission 的 leaf workflow；coding leaf 使用 `checked` acceptance，绝不伪造 verify。leaf identity 只可来自同 session、同 workflow key、同 parent workflow id 的 `subagent:async-started` 事件，缺失或冲突时 fail closed。

## 修复策略

新增私有 workflow transport adapter：安全序列化既有 Dispatch IR/generic task 到固定 `runs.run(...)` 脚本，移除公开顶层 `agent/task/title/clarify`。RPC reply 只提供 workflow root 候选；adapter 缓冲并关联 lifecycle event 后才将 leaf `runId/asyncDir` 交给 Root Broker、Goal 与标题系统。

## 回归测试

在受控 `node:vm` 中实际执行生成的脚本，验证含换行、引号和反引号的 task 原样到达唯一 child，且无法注入脚本。验证早到 event、错误 parent、identity 冲突、缺少 asyncDir 与超时均不会生成 leaf binding。真实 Pi `0.45.2` integration 另行验证 RPC 和 child 生命周期 artifact。
