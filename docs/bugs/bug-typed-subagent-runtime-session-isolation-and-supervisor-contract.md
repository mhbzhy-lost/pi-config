# Bug：Typed Subagent Runtime 的会话隔离与 Supervisor 合同不完整

## 1. 现象

独立评审发现五个可复现问题：同一 Node 进程创建第二个 AgentSession 会 dispose 第一个 runtime；supervisor target 缺失时 lifecycle error 会被 Pi 捕获但工具仍保持 active；项目 schema 暴露 upstream parent closure 必然拒绝的 `send/ask`；skill 示例使用已禁用的 `reviewer`；兼容测试继承 child markers 时误把 root runtime 当作已加载。

## 2. 影响

并存 SDK session 会互相破坏 RPC 和 supervisor；upstream breaking change 后模型仍看到不可用工具；模型可生成 schema 合法但必失败的 supervisor 调用，或派发不存在的 generic agent；测试结果依赖调用者环境。

## 3. 稳定复现

使用同一个 cleanup store、两个不同 fake Pi 实例连续调用 `createTypedSubagentExtension()`，第二次创建后第一个 RPC client 已 disposed。用真实 ExtensionRunner 启动一个不提供 supervisor target 的 fake bootstrap，`bindExtensions()` 只向 `onError` 报错并继续，active tools 仍包含 `subagent_supervisor`。当前静态 schema 包含 `send/ask`，而 upstream `buildParentIntercomTool().execute()` 对二者无条件抛错。设置 `PI_SUBAGENT_CHILD=1` 后单跑兼容测试，项目 runtime 按设计跳过但测试仍查找 supervisor。

## 4. 证据

`scripts/lib/subagent-dispatch/extension.mjs` 使用 `globalThis[CLEANUP_KEY]` 单槽保存 disposer，并在任何新实例创建时清理旧值。Pi `ExtensionRunner.emit()` 捕获 handler error 并通过 error listener 报告，不传播为 session 启动失败。`native-supervisor-channel.ts` 的 parent tool 只实现 `status/list/pending/reply`，对 `send/ask` 明确报错。`pi/settings.json` 禁用了 upstream `reviewer`，本地没有同名 agent。

## 5. 根因

实现把“同一个 Pi runtime reload”错误等同为“进程内任意新实例”，没有以 Pi 实例作为 cleanup ownership key；把 lifecycle handler throw 错当成启动阻断；项目 facade 机械复制 upstream 的通用 Intercom schema，而不是按 parent 可用能力定义稳定合同；测试和 skill 没有以安装后的真实 agent/env surface 为准。

## 6. 修复与验证策略

把 cleanup registry 改为以 Pi runtime object 为 key：同实例重建清理旧 generation，不同实例互不影响；session shutdown 只删除自己的 entry。Supervisor 未绑定时先从 active tools 移除项目 wrapper，再抛稳定 lifecycle error，真实 ExtensionRunner 测试同时断言 error 被报告且工具不可调用。项目 supervisor schema 只保留 `reply/pending/status`，执行仍无损委托 closure。Skill generic 示例改为 builtin `advisor`。兼容测试在 try/finally 中清除并恢复 root/child markers。

RED/GREEN 覆盖并存 session、同实例 reload、真实 ExtensionRunner 未绑定路径、动作枚举、可发现 generic agent 和 inherited child environment；最后复跑独立 Pi generic/typed/supervisor smoke。
