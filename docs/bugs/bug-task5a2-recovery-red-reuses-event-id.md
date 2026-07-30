# Bug: Task 5A2 recovery RED 在重启 fixture 中复用 eventId

## 症状

Task 5A2 allocated recovery 用例把第一次 Harness 产生的 `attempt.workspace-allocated` 事件直接放入第二个 Harness。两个 Harness 的本地 `id()` 都从 `event-1` 开始；Coordinator 恢复时追加 `attempt.dispatch-requested`，writer 因新事件再次使用 `event-1` 而抛出 `duplicate eventId`。

## 影响

该失败与 durable Attempt recovery 无关，却诱导 GREEN 实现在通用 `appendEvent()` 中按错误消息捕获 duplicate eventId 并重新调用 writer。这样会改变所有 Plan 事件的 single-writer 语义、依赖字符串错误文案，而且只重试一次，无法正确处理任意历史 ID 集合。

## 复现

第一次调用 Harness 的 `prepareAuthorizedDispatches()`，取其 `appended[0]`，该事件 ID 为 `event-1`。以 `[plan.created, appended[0]]` 创建新 Harness；新 Harness 的 `id()` 计数器重新从零开始。恢复逻辑正确复用 workspace 并 append dispatch 时，新事件同样取得 `event-1`，在 reducer 业务校验前被 Event Writer 拒绝。

## 根因

测试把“新进程中的 ID 生成器”错误建模为每次固定归零的局部计数器，同时复用了前一进程生成的事件。真实 writer 使用全局不可预测 ID，不会在重启后从历史首值重新计数。父级只检查了 reducer 是否接受 fixture，没有检查 writer 的 eventId ownership。

## 修复

仅修正 allocated recovery fixture：复制 workspace-allocated 事件并赋予一个与新 Harness writer 序列不冲突的稳定历史 eventId，再交给 replay Harness。生产 `appendEvent()` 保持一次 writer append、错误原样传播，不得捕获 duplicate eventId 或根据错误字符串重试。

## 验证

在不含 Task 5A2 GREEN 的隔离 worktree 中提交 tests-only 修正，确认 allocated recovery 用例仍因现有 Coordinator 不支持 recovery 而 RED，而不是 duplicate eventId。合入后删除生产 retry，聚焦 happy 与 Task5A2 应全部 GREEN；Event Writer/CAS 回归继续证明重复 ID fail closed。
