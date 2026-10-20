# T21/T28：无改动 worktree 的前置事实与处置结果

对象：workspace `a8f3cdf0-fbca-4c19-abb3-f5971dedc750`，child run `29ea828b-dc00-43a2-8cbe-0b6f6a14771f`，supervisor request `e295a31b-bc52-481f-83c2-ed11e2643260`。

## 事实矩阵（本轮实测，不可观测写 unknown）

| 维度 | 事实 |
| --- | --- |
| filesystem | worktree 存在；`git status --porcelain --untracked-files=all` 输出为空（clean） |
| commit delta | worktree HEAD `92b03021b52959237c2642560435cb8fd0528728` == origin HEAD；相对基线 `rev-list --count` = 0；分支 `pi-managed/a8f3cdf0-…` |
| runtime process terminal | 本轮 `managed_workspace_status`：`process_terminal=pending`；preserve 回执投影 `unknown`；早前快照曾为 `observed`。三者不一致按“当前无 observed proof”处理，不伪造 proof |
| queue | 无可发布 payload、无已证 commit；不创建空提交 |
| proof | 无 observed terminal proof（`release` 因此 fail closed） |
| workspace 处置 | 当次 status 取得一次性 token → `dispose(preserve)` **成功**，`state=preserved`；`release` 返回 `MANAGED_WORKSPACE_TERMINAL: release requires an observed terminal proof`；`managed_workspace_list` 复核仍 `preserved`，未降级 `cleanup-debt` |
| origin | `origin-dirty`（本批未提交改动）→ `integrate_blocked_reasons` 含 `origin-dirty`、`terminal-unobserved`；未 stash/reset/覆盖 |

## 接管提示判定

merge queue 的接管/恢复提示只证明“发出了恢复提示”，不证明队列中存在可发布 commit。本例经只读 Git 事实证明无 payload，因此该提示对这个工作区不成立“有待提交内容”；处置是不提交空 commit、不 raw merge、不删除 ledger，并把提示语义保留为合法提醒。

## 结论与解阻

泄漏已结算为 `preserved`；物理回收 `blocked-terminal-proof`。解阻条件是该 run 取得合法 observed terminal proof，或上游提供不依赖 proof 的受控回收入口；不通过放宽 H2 门禁、不通过 raw `git worktree remove`/`branch -D` 实现。
