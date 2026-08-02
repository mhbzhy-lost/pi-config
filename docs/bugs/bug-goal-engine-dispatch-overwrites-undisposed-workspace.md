# Bug: Goal Engine 重派覆盖未处置 workspace

## 现象
`goal_dispatch` 在 `failed settle` 之后，仍可直接发起第二次尝试（`attempt 2`）并覆盖仍处于 `pending` 的旧 workspace。

当任务在 `task.settled(failed)` 后回到 `pending` 且 `workspace` 仍为 `active`（未处置）时，重派可覆盖未释放的旧 workspace。若旧 workspace 标记为 `phase=disposed`、`disposition=preserved`、`released=false`，该路径会覆盖其 `workspace` 元数据，导致原先保留的审计身份丢失。

## 影响
`pending` 与未处置 workspace（特别是 `phase=active`/`disposition=preserved`）被混淆，会导致重派既不幂等又不可追溯。

直接 `attempt 2` 可能绕过正确处置流程，导致审计链路断裂：无法可靠追踪最初 dispatcher/executor 的身份归属，后续核查与回放恢复都可能基于被覆盖的错误身份。

## 稳定复现
1. 按 v2 事件序列执行：
   - `goal.created`
   - `task.dispatched(attempt=1)`
   - `task.settled(failed)`
2. 确认任务回到 `pending`，且 workspace 的 `phase` 为 `active`（未处置）且仍绑定旧审计身份。
3. 发起 `task.dispatched(attempt=2)`（重派）。

现象：系统允许重派并覆盖旧 workspace；`failed settle` 后 `pending` 的 `phase=active workspace` 被新 attempt 覆盖。

4. 将旧 workspace 标记为 `phase=disposed`、`disposition=preserved`、`released=false` 的终态后再次发起 `attempt=2` 重派。

现象：`phase=disposed` + `disposition=preserved` + `released=false` 的 workspace 元数据与审计身份仍被覆盖，说明保护边界未生效。

## 根因
重派分支仅按 task `pending + attempt++` 判断可重试，缺少对 workspace 生命周期状态的前置检查。具体地，失败 settle 后未将旧 workspace 标记到可重派的处置态集合，而是允许其在 `pending` 下被下一次 dispatch 覆盖。

旧 attempt 的身份绑定没有按 `disposition=preserved`/`phase=disposed` 边界严格隔离，覆盖逻辑将 workspace 头部直接替换，导致保留的审计身份不可恢复。

## 促成因素
- 缺少“`failed settle` 后禁止直接 `attempt 2`”的事件级不变量。
- 未建立 workspace 可重派前置条件：未把 `phase=active` 与 `disposition=preserved` 纳入阻断，导致可重派判定仅依赖 task 状态。
- 审计身份与 workspace 生命周期未解耦，重派时没有在契约层面保护 `disposition=preserved 的 workspace` 的不可覆盖性。
- 验证链路缺失：缺少“只有 `phase=disposed + disposition=discarded + released=true` 才可重派”的归约性回归。

## 修复与验证策略
- 收紧重派前置条件：仅当 `workspace.phase === "disposed" && workspace.disposition === "discarded" && workspace.released === true` 时才允许 `redispatch`。
- `task.settled(failed)` 后 `pending` 且 workspace 仍 `phase=active`/`disposition=preserved` 时，应阻断直接 `attempt 2` 并返回错误，要求先执行处置。
- 对重派更新增加保护：`disposition=preserved 的 workspace` 不得直接覆盖审计身份字段；失败/重试路径必须在新 attempt 记录新身份前保留原始追踪链。
- 跟进文档级验证：
  1) 复现并记录：`failed settle -> pending + phase=active workspace + attempt2` 覆盖行为；
  2) 复现并记录：`phase=disposed`、`disposition=preserved`、`released=false` 且 attempt2 重派后元数据被覆盖；
  3) 验证结论仅在 `workspace.phase === "disposed" && workspace.disposition === "discarded" && workspace.released === true` 时允许重派。