# Bug：Subagent completion 标题错配且 generic start 不显示标题

## 1. 现象

generic dispatch 已接受必填 `title`，但工具启动结果仍显示上游原文 `Async: delegate [runId]`。两个同 agent 的并发 run 依次完成时，第一条 completion 不显示标题，第二条 completion 错误显示第一条 run 的标题。

## 2. 影响

用户无法从启动事件区分并发任务，completion 又可能把一个任务的标题显示到另一个任务上。`agent` 仍然正确，但 title 与 runId 的身份绑定在可见消息层失效，违反“每个 subagent 生命周期事件同时显示执行身份和任务标题”的合同。

## 3. 稳定复现

1. reload 后并行派发两个 `{ agent: "delegate", title, task }`。
2. 启动工具结果仅显示 `Async: delegate [runId]`，没有 title。
3. 第一个 run 完成时，completion 没有 title。
4. 第二个 run 完成时，completion 显示第一个 run 的 title。

现有 membrane 单测先调用 `subagent:async-complete`，再调用 `sendMessage(subagent-notify)`，因此没有覆盖生产顺序。

## 4. 证据

`executeCoding()` 明确构造 `Started ${agent}: ${title} (${runId}).`，而 `executeGeneric()` 返回 `rpcResult(reply)`，直接保留上游 `Async: delegate [runId]` 文本。

上游 `result-watcher.ts` 先直接调用 completion notifier，等待通知被接受后才 emit `subagent:async-complete`。项目 membrane 的 `decorateVisibleMessage()` 却依赖 `decorateLifecycle(COMPLETE_EVENT)` 先把 title 放入 completion FIFO。生产顺序下第一条通知拿不到 title；随后 complete event 才把第一条 title 入队，第二条通知因此错误消费它。

## 5. 根因

实现把 completion title enrichment 错误绑定到观察事件 `subagent:async-complete`，但该事件在上游设计中是通知成功后的 observation channel，不是通知前的数据来源。测试用例反转了真实调用顺序，掩盖了这个跨组件时序错误。generic start 则只给 details 增加 title，没有同步替换用户可见 content。

## 6. 修复与验证策略

先增加 RED 测试，严格模拟“notify sendMessage 发生在 async-complete event 之前”，并验证两个同 agent run 不得串 title；另增加 generic start content 必须同时显示 agent、title、runId 的测试。实现应在 runId 绑定后，从可见 completion 消息自身的稳定信息解析 runId，或在上游 notifier 调用边界建立与当前 result 的结构化关联；不得依赖事后 observation event，也不得按 agent FIFO 猜测。保留 upstream batching、去重和 result acknowledgement，不修改 `node_modules`。修复后运行 title/membrane/RPC/supervisor、完整 focused suite、fresh reload，再用两个同 agent child 做真实 TUI 验收。

## 7. 验证结果

重启后并行派发 `Amber title verification` 与 `Cobalt title verification` 两个 delegate。start 文案均包含各自 title/runId；Cobalt 先完成、Amber 后完成，两条自动通知分别保留正确 title 与 session file，没有同 agent FIFO 串线。随后 title/runtime 与扩大回归持续通过。
