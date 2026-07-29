# Bug: preserve Attempt workspace 污染 Plan Gate

## 症状
真实 amendment crash/restart 在成功恢复 terminal `attempt.superseded` 后按策略保留旧 workspace；revision 2 Task 随后成功 integrated/accepted，但 `plan_verify` 的 deterministic、plan-audit、external-review 和 final-completeness 四个 Gate 全部返回 failed，evidence/findings 为空。

## 影响
任何需要 `superseded-preserve` 的 terminal、dirty 或检查不确定 Attempt 都会让后续 revision 无法通过最终 Gate。Plan 永久停在 verifying，即使 accumulator 的批准改动、HEAD 和验证命令均正确。

## 复现
让 active Attempt 在 `plan.amended` 后崩溃，恢复得到 terminal proof 和 `superseded-preserve`；旧 workspace 物理保留在 accumulator 下的运行时 `attempts/<attemptId>`。revision 2 集成后调用 `plan_verify`，Gate 的 `git ls-files --others` 把该目录计为 accumulator untracked 文件，preflight 判定不干净。

## 根因
Plan accumulator 路径同时是 Attempt workspace 容器的父目录。Gate 的 cleanliness 检查只排除 `.pi-subagents/`，没有排除由 Plan runtime 拥有的顶层 `attempts/` worktree树，因此控制面保留物被误判为用户工作树污染。

## 修复
Gate inspect 只从 untracked cleanliness 中排除 accumulator 顶层、由 runtime 固定拥有的 `attempts/` 子树；保留对其他所有 untracked/tracked 文件的 fail-closed 检查。不得按任意名称或深层片段模糊排除，也不得删除 terminal preserve workspace。

## 验证
先新增 RED：存在 `attempts/<id>` runtime workspace 时合法 accumulator 可通过四 Gate；同名非顶层路径、其他 untracked 文件及 tracked dirty 仍失败。随后复跑 Gate focused、amendment recovery、真实 crash/restart Harness 两次和累计回归。
