# 已执行任务可被 amendment 改写或删除

## 现象
已 accepted 的任务可通过 `goal.amended.updateTasks.acceptance` 将验收条件改写为 `false`，但任务状态仍为 accepted。持有 active workspace 的任务可通过 `removeTasks` 删除，projection 随之丢失该任务与其 workspace 身份。

## 影响
accepted 证明可被事后重写；仍存在的 worktree、分支和 lease 会失去 reducer 中的归属，可能被误用或泄漏。

## 复现条件
对 accepted 任务提交任意 update/remove，或对 dispatched、succeeded、failed 后仍持有 workspace 的任务提交 update/remove。

## 根因
`goalAmended()` 仅在 remove 时检查 accepted；update 没有状态门禁，remove 没有 workspace 门禁，也没有在修改前统一验证完整候选。

## 修复方案
reducer 在修改前统一要求任务为 pending，且没有 workspace，或 workspace 已 `disposed + discarded + released=true`；先验证全部请求与候选 DAG，再应用修改。

## 防回归
reducer 覆盖 accepted 字段更新、所有未释放 workspace 状态、已释放 discarded retry 和原子拒绝；Extension 通过真实工具验证拒绝不追加事件且资源保留。
