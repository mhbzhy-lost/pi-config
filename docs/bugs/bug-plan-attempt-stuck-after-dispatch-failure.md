# Bug: executor dispatch 失败后 plan attempt 状态卡死

## 现象

plan-runner 无法派发 executor 后，plan 的 lifecycle 状态机卡在 active attempt，
后续所有 `plan_continue` 和 `plan_verify` 调用都被阻断：

```
plan_continue → "an attempt is already active"
plan_verify   → "active attempt prevents HEAD observation"
```

## 根因

`plan_continue` 的首次调用创建了 attempt（`attempt-...-task-1-1`）并返回
executor dispatch 指令。executor dispatch 失败后，该 attempt 既未完成也未取消，
始终处于 active 状态。

plan-runner 随后通过 steering 直接执行了 task（创建文件、提交），但无法通过
`plan_continue` 记录完成（"an attempt is already active"），也无法通过
`plan_verify` 推进验证（"active attempt prevents HEAD observation"）。

## 因果链

1. `plan_continue` 创建 attempt → 返回 executor dispatch 指令
2. executor dispatch 失败（child-safe 拒绝）
3. plan-runner 自行执行 task → 文件创建成功、commit 成功
4. 再次 `plan_continue` → 被 active attempt 阻断
5. `plan_verify` → 被 active attempt 阻断
6. plan 进入 paused 状态，无法推进

## 影响范围

任何 attempt 创建后 dispatch 失败的场景。attempt 没有取消/回滚机制。

## 触发条件

`plan_continue` 返回带 `tool` 字段的 dispatch 指令后，dispatch 执行失败。

## 修复方向

根因已经通过 `sameTool` 修复解决（dispatch 不再失败）。

另一个相关问题：executor async 完成后，attempt 仍然卡在 active 状态，
因为 `handleNestedResult` 中的 `waitForRuntimeOutcome` 超时时间太短（5秒），
executor 还没完成就返回了 `{ state: "active" }`，之后再也没有机制来 settle。

修复：增大 `runtimePollTimeoutMs` 默认值，让 `waitForRuntimeOutcome`
有足够时间等待 async executor 完成。
