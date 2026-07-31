# Flat amendment Harness 轮询与最终 Attempt oracle 不可信

## 1. 现象

新 flat amendment Harness 的通用 `waitFor` 不处理 `ENOENT`，但 barrier 轮询第一次通常发生在 `entered` 文件创建前；测试会立即抛错而不是等待。最终状态又固定读取每个 Task 的 `attempts[0]`，revision 2 的 task-1 可能先保留旧 superseded Attempt，因此会把正确恢复误判为失败。

## 2. 影响

真实 Harness 可能在尚未进入故障窗口时假失败，或在 Plan 已 validated 后因错误 Attempt 索引失败。即使主体通过，缺少 accumulator 两提交/runtime-clean 断言、Runner process instance精确匹配和强杀后等待退出，也会让文件污染、错误 terminal instance或残留 Root进程漏过门禁。

## 3. 时间线

- Root 启动后异步推进 Attention 与 amendment，测试同步开始轮询 barrier path。
- `access(barrier/entered)` 在文件尚不存在时拒绝，当前 `waitFor` 没有 catch。
- revision 1 task-1 Attempt 被 supersede，revision 2 为同一 task ID 新建 Attempt。
- projection 保留 Attempt 历史，`attempts[0]` 不是 revision 2 dispatch 的可靠身份。
- cleanup 仅在超时后发送 `SIGKILL` 并立即抛错，没有 await child close。

## 4. 根因

迁移时为压缩 Harness 复制了最简轮询和终态断言，没有沿用 flat Harness 的 ENOENT容错、exact dispatch identity、process instance匹配与 graceful-close fallback。领域上按 task ID 选取 Attempt，混淆了 Task稳定身份和每次 dispatch的 Attempt身份。

## 5. 触发条件

任何正常异步 barrier 创建都会触发首轮 `ENOENT`；amendment修改现有 task-1时必然同时存在旧、新两个 Attempt。Root graceful close超过8秒、worktree残留未跟踪文件，或terminal sidecar含多个process instance时会暴露其余缺口。

## 6. 修复与验证

先扩展静态迁移 RED，要求 Harness 对 `ENOENT` 继续等待、按revision 2 dispatch的 `attemptId` 查最终 Attempt、验证两次新提交与runtime-aware clean、按 `runnerProcessInstanceId` 选择terminal instance、强杀后await `exited`，并为agent frontmatter保留description/thinking/temperature。再最小修改integration文件，通过`node --check`和普通migration测试；真实Pi仍只在最终冻结HEAD运行一次。
