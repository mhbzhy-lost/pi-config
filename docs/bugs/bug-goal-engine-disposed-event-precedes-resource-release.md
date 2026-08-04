# Goal Engine disposed 事实早于资源释放

## 现象
`1a052c7` 的 `ensureApplied` 在删除 workspace、branch 与 lease 前，先持久化 `task.workspace_disposed(released=true)`。若追加在持久化前失败，投影仍为 applied；若追加 durable-then-throw，投影已是 disposed/released=true，但三类资源仍存在。

## 影响
`goal_accept` 可把 `released=true` 当作资源已释放的事实并错误接受任务；终态重试再清理会把首次清理隐藏在 accepted 可见状态之后。

## 稳定复现
对 `task.workspace_disposed` 注入 before-durable 或 durable-then-throw 失败。前者应在抛错时已释放资源且保持 applied；后者应在抛错时已释放资源且 durable 投影与物理状态一致。

## 根因
代码把“追加失败时不应做不可逆操作”误用于资源释放的完成事实，颠倒了 durable fact 与副作用的因果顺序。

## 修复
先验证 originRef，完成并验证 release，再追加 `workspace_disposed(released=true)`；终态发现残留资源时闭锁失败，不再静默清理。

## 防复发
覆盖两种 append 失败边界、同 ref 重试只补事实、不重复 Git 集成，以及终态残留资源的 fail-closed 行为。
