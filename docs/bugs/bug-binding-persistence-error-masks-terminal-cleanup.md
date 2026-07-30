# Bug：持久化错误掩盖并发 terminal cleanup

## 症状

公开 `bindAuthorizedDispatch` 写入 `attempt.bound` 遇到普通非 CAS 错误时会刷新 projection，然后为了保留可重试的 Executor binding 直接抛出原错误。如果刷新期间已经提交 `plan.cancelled`、`plan.blocked` 或其他 terminal lifecycle，当前调用仍不会停止该 run。

## 影响

Plan 已进入 terminal 状态，但 Root session 中仍保留一个已无领域归属的 Executor。后续相同 tool result 不应再提交 binding，Plan Runner 也可能不再获得正常的领域驱动机会清理它；只能依赖更晚的 session/root shutdown，破坏 terminal cleanup 与无 orphan 约束。

## 复现

从 `dispatch-requested` Attempt 调用公开 bind。让 Event Writer 在处理 `attempt.bound` 时先通过独立权威 writer 成功追加 `plan.cancelled`，再向当前 append 返回普通 `EIO`。catch 中 `refreshProjection()` 已能看到 `cancelled`，但 `stopOnPersistenceError: false` 分支直接抛出 `EIO`，backend.stop 调用次数为零。

## 根因

上一修复把“普通持久化错误保留 run”的调用策略放在 catch 尾部，却没有在刷新后重新执行循环顶部的 terminal authority 判断。它正确区分了 public tool result 与 legacy direct dispatch，却把“仍可重试的 dispatch-requested”和“已经 terminal”错误归入同一个不 stop 分支。

## 修复

抽取或复用 terminal lifecycle 判断。`attempt.bound` 失败并刷新 projection 后，先检查最新 lifecycle；若已 terminal，执行一次 `stopSpawnedBinding` 并返回该 terminal state。只有 projection 仍非 terminal 时，公开 bind 才原样抛出普通错误并保留 binding；legacy direct、identity mismatch 与 CAS retry 语义不变。

## 验证

新增独立 tests-only RED：普通 `EIO` 窗口中并发提交 `plan.cancelled`，公开 bind 必须返回 `cancelled`、停止 exact run、保持零 `attempt.bound` 且 projection 可重放。保留并运行普通 EIO 可重试、预先 terminal、CAS terminal、legacy direct cleanup 及完整 Task 6 回归。
