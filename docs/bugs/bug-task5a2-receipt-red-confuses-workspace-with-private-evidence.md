# Bug: Task 5A2 receipt RED 把权威 workspace 误判为私密证据泄漏

## 症状

Task 5A2 GREEN 实现完成其他 15 项聚焦断言后，receipt 用例仍失败。用例对整个 `attempt.dispatch-requested.tool` 执行 `JSON.stringify()`，并断言结果不得包含 `"/attempts/"`；但 `tool.cwd` 与 `tool.contract.execution.cwd` 按合同必须是 `/attempts/<attemptId>`。

## 影响

该断言无法在保持事件协议和 typed dispatch 合同正确的前提下通过。若实现迎合测试隐藏或替换 cwd，`plan-events` 会因 `tool.cwd !== attempt.workspace.path` 拒绝事件，一次性授权边界也无法把 contract 绑定到真实 Attempt workspace。

## 复现

运行 `node --test --test-name-pattern='Task5A2 binds redacted integrated dependency receipts' test/plan-coordinator.test.mjs`。当 Coordinator 正确生成 receipt 后，测试遍历 private values 并检查整个 tool；`"/attempts/"` 首先来自权威 `tool.cwd` 或 `contract.execution.cwd`，而不是 dependency Attempt 的 evidence、transcript、stdout 或 stderr。

## 根因

测试把“不得把依赖 Attempt 的本地证据路径投影进 receipt/prompt”扩大成“runtime descriptor 的任何字段都不得含 Attempt workspace”。Task 5 合同同时要求 descriptor 和 typed contract 使用实际 workspace cwd，两个信息边界被混为一谈。父级在 tests-only 审查时只核对了 private value 列表，没有逐字段确认序列化对象包含合法 cwd。

## 修复

保留 `tool.cwd`、`contract.execution.cwd` 与 `attempt.workspace.path` 的严格一致性。测试把私密值检查限制到公开依赖投影：`tool.dependencyReceipts`、对应 receipt known fact 和 Executor prompt；这些区域不得包含 stdout、stderr、transcript、evidence 路径或 dependency Attempt workspace。另显式断言两个 cwd 等于当前新 Attempt 的真实 workspace，防止以删字段或伪造路径让测试变绿。

## 验证

在不包含 Task 5A2 未提交生产实现的隔离 worktree 中提交 tests-only 修正，先确认 receipt 用例仍因 Coordinator 尚未注入 receipt 而 RED，而不是因合法 cwd 失败。合入修正后恢复 GREEN 实现，要求 Task5A1 happy 与 15 项 Task5A2 全部通过，Plan Events 继续接受 exact tool cwd，提交范围分别保持测试与生产文件隔离。
