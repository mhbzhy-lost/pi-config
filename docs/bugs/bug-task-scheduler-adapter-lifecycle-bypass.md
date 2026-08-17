# Scheduler Adapter 生命周期与授权绕过（BLOCK）

- 发现日期：2026-08-17
- 依据：`docs/reviews/2026-08-17-task-scheduler-adapter-implementation-review.md`
- 状态：**superseded by membrane design**；上游 timer、并发与完成语义是已知限制，不是本仓承诺。

本记录的 RED 用例只使用隔离临时 state/repo 与 fake Pi；不加载第三方 default extension、不读取真实 state 或凭据。

| Finding | 可复现问题 | 修复方向 |
|---|---|---|
| F-01 | 官方 `tool_call`、`agent_start`、`agent_settled` 没有 `occurrenceId`；当前写工具不被阻止且 settled 不完成 active occurrence。 | 用 extension input / before-start / message-start 的唯一内部关联建立 pending→running；歧义 fail-closed。 |
| F-02 | `read/grep/find/ls` 的可选 path 会回退 cwd，未 canonicalize；symlink、非字符串及同名非 builtin 可绕过。 | 对真实 builtin `sourceInfo` 和各工具 path 参数表驱动校验，省略时 canonical `ctx.cwd`，未知/覆盖一律 block。 |
| F-03 | `confirm` 被作为单对象调用，授权内容、task/grant ID 与 timeout 不可见。 | 使用 `confirm(title,message,{timeout})`，持久化并重验 hash/binding digest。 |
| F-04 | `sendUserMessage` 返回 void 却被当成交付成功，没有 start/run deadline。 | 持久化 claim 后观察官方生命周期；无 start、超时、内部失败/歧义均记 `indeterminate`。 |
| F-05 | 同刻 timer 可双 claim；busy tick 丢跑；预算、过期、missed、reload、flight delete 不闭合。 | dispatch mutex + 原子 claim；所有分支重排/结算；reload running 转 indeterminate。 |
| F-06 | 未获得或已失去 runtime lease 的 stopped 实例仍能临时 lease create/delete。 | 明确 active/inactive/stopped 状态；CRUD 确认前检查 live lease；renew/transact 串行，loss 后永久 fail-closed。 |
| F-07 | schema 接受未知字段/坏状态/日期及篡改 binding，dispatch 不重扫已持久化 prompt。 | exact nested schema、唯一 ID、日期/计数/额度限制、commit size 限制；claim 内重扫 prompt 和 grant。 |
| F-08 | session 固定为 `default`，repo 不存在时回退 cwd，跨 session/repo 可见和 arm。 | 从真实 ctx 取得 canonical repo/session，并在 CRUD/timer/claim 强制 scope。 |
| F-09 | 工具缺 `label` 与 TypeBox.Kind，factory 返回 adapter 而非 void。 | 使用 Pi TypeScript ABI、TypeBox 参数、label，factory 仅注册并返回 void。 |
| F-10 | 上游 resources 虽被禁用，但 adapter 对精确安装包零 import，不能声称复用纯 API。 | 动态 resource discovery + 静态 import graph；只允许独立 pure core root named API，否则删除依赖/文档声明。 |
| F-11 | 既有 fake 伪造 occurrenceId、接受错误 confirm 且未测副作用，形成虚假 GREEN。 | 以下 RED suites 使用官方事件/confirm/ToolResult 和隔离 loader smoke。 |

## RED 摘要

`task-scheduler-adapter.test.mjs` 覆盖 F-01/F-02/F-03/F-07；`task-scheduler-runtime.integration.mjs` 覆盖 F-04/F-05/F-06/F-08；`task-scheduler-pi-abi.integration.mjs` 覆盖 F-09/F-10。RED 用例现在全部使用隔离临时 state/repo：写操作先经 `session_start` 取得 owner lease，跨 session 以第二 adapter 只读，state 篡改保持 JSON 与 0600。已删除 adapter 源码 regex 断言。当前明确 RED 是：不匹配 scheduled prompt 仍会 settle；活跃 lease 下 delete 产生不合法 persisted state；重签名的 secret/injection/invisible prompt 未在 reload fail-closed；adapter 未接收 clock/timers 注入，因而无法确定性验证 deadline、busy requeue、maxRuns、missed、long timer、reload 与 flight；shutdown flight 的查询退化为 `agent_settled`；Pi 0.84.2 root 未导出 `validateToolArguments`；未调用注入的 `schedulerCore.resolveScheduledTaskDefinition`。Secure Store 不在此任务修改范围。
