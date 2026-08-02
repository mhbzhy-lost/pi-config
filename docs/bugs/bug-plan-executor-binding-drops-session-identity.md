# Bug: Executor binding 丢失 Plan session identity

## 症状
Pi subagents backend 返回 binding 字段 `sessionId`，Coordinator 持久化时读取 `binding.sessionFile`，因此真实 `attempt.bound.data.sessionFile` 总是 null。

## 影响
Plan Runner 进程恢复后无法把事件中的 dispatch/run binding 安全注入 backend，也无法证明 authoritative runtime artifact 属于当前 Plan session；supersede recovery 只能错误 attach 或 fail closed。

## 复现
通过真实 backend spawn 获得 binding 并走 `bindOrCleanupSpawnedAttempt()`；检查追加的 `attempt.bound`，`sessionFile` 为 null，而 capabilities 已返回当前 session file。

## 根因
transport binding 与领域事件对同一 session identity 使用了不同字段名，backend 没有提供 Coordinator 期望的 alias，且测试 fixture 接受 null 掩盖了真实缺口。

## 修复
backend 所有新建/恢复 binding 同时提供相等的 `sessionId` 与 `sessionFile`；恢复入口要求持久化 sessionFile 与当前 capabilities session identity 完全一致。旧 null 事件不伪造身份，恢复 supersede 时 fail closed。

## 验证
测试 spawn binding 的两个字段相等；Coordinator append 的 `attempt.bound.sessionFile` 非空；同 session recovered binding 可 supersede，null/跨 session identity 被拒绝；现有 bind-or-cleanup 回归通过。
