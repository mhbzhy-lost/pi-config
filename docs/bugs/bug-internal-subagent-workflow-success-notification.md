# 内部 subagent workflow 成功通知泄漏

## 现象
项目自有 typed/generic subagent 门面以异步 workflow root 包裹异步 leaf。root 在 leaf 仅启动后即可成功，若 leaf 未落在约 150ms 成功通知批处理窗口内，用户会先看到无业务含义的 `Background task completed: **workflow**`，并可能提前唤醒主 Agent。

## 根因
项目 completion notifier 订阅了所有 `subagent:async-complete` 事件；此前没有保存门面 workflow root 与其确认启动 leaf 的关联，因此 root 的成功终态会进入 notifier batching 和 `sendMessage`。

## RED 证据
已执行 `node --test test/subagent-runtime-membrane.test.mjs`（实现前）：新增测试 `confirmed facade workflow success is filtered before the completion notifier while its leaf remains visible` 失败，错误为 `TypeError: registry.bindWorkflowRoot is not a function`。该 RED 证明生产代码尚未建立已确认 facade root/leaf 关联，因而也没有可在 notifier 订阅前拒绝 wrapper 成功事件的分支。测试以真实 membrane 的 notifier 订阅路径断言：root 成功不得进入批处理、不得发送或触发主 Agent；同一关联 leaf 仍发送带 title 与业务摘要的通知。

## 修复策略
在门面 spawn 收到 root 回复并确认对应 leaf 启动后，登记精确 root/leaf 关联。仅在该关联已确认时，阻止 root 的成功 completion 事件到达项目 notifier 订阅器；不按 `agent === workflow` 全局过滤，且 failed、paused、stopped 一律保留。

## 最终验证
GREEN：`node --test test/subagent-runtime-membrane.test.mjs test/subagent-title-registry.test.mjs test/subagent-workflow-spawn.test.mjs test/pi-subagents-compat.test.mjs` 通过（86/86）。新增测试实际经 generic facade 启动 workflow root 与 leaf，验证确认绑定 root 的 success 在 notifier 订阅前被过滤，未发送消息或触发主 Agent；leaf 仍携带 `真实业务` title 与 `业务摘要`。同一测试还验证非门面 workflow success 及内部 root 的 failed、paused、stopped 仍可见。`git diff --check` 通过。

## 本轮验收：completion 二次装饰

### 验收发现
生产 result-watcher 取得的 headless API 会经 `api.events.emit` 发出 completion；该 membrane 已调用一次 `decorateLifecycle`。completion notifier 则通过 `captureEventSubscription` 延迟绑定到底层 bus，故其订阅 handler 接收的已是装饰完成的 payload。若 subscription wrapper 再次调用 `decorateLifecycle`，同一 leaf 会向 completed title 队列重复写入，连续同 agent completion 会错误复用前一 title。

### RED 验收目标
新增生产顺序测试须由 bootstrap 捕获的 headless upstream API 发出两次 `subagent:async-complete`，而非直接调用 `pi.events.emit`。在修复前，断言两个可见通知分别是 `First task`、`Second task` 且 completed 队列恰好各消费一次会失败：第一条通知消费第一次入队的 title 后，第二条仍消费第一条重复入队的 title。

### 修正与 GREEN
RED：新增 `production upstream completion emits decorate each same-agent leaf once` 后执行 `node --test test/subagent-runtime-membrane.test.mjs`，45 项中 1 项失败；第二条通知实际为 `**delegate** [First task]`，而期望为 `**delegate** [Second task]`。该测试从 bootstrap 捕获的 headless upstream API 依次 emit 两个 leaf completion，未直接调用底层 `pi.events.emit`，因此复现的是 result-watcher 经 membrane 的生产路径。

最小修正让 notifier subscription 只对已装饰 payload 执行 success 过滤后交给 handler，不再调用 `decorateLifecycle`；upstream emit membrane 继续是 lifecycle 装饰的唯一所有者。GREEN：同一 runtime 测试 45/45 通过；连续同 agent leaf 分别渲染 `First task` 和 `Second task`，并断言两个通知消费后 completed 队列为空。既有 facade root success 过滤测试亦改经捕获的 upstream API emit，持续验证 root 不进入 notifier/batching/sendMessage，真实 leaf、无关 workflow success 与 root 的 failed/paused/stopped 仍可见。聚焦回归：`node --test test/subagent-runtime-membrane.test.mjs test/subagent-title-registry.test.mjs test/subagent-workflow-spawn.test.mjs test/subagent-compact-rendering.test.mjs test/compact-tools-renderer.test.mjs test/pi-subagents-compat.test.mjs` 通过（113/113）；`git diff --check` 通过。
