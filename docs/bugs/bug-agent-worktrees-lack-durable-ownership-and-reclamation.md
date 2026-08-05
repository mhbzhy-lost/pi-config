# Bug：Agent 隔离 worktree 缺少持久归属与回收闭环

## 1. 现象

`pi-config` 当前登记 94 个 Git worktree，其中 1 个主工作树、93 个位于 `/private/tmp/pi-config-*` 的 linked worktree。93 个 linked worktree 合计约 1.78 GiB；没有统一 owner lease、完成状态或回收记录，任务结束后仍长期登记在主仓。

## 2. 影响

无法仅凭目录名、分支名或瞬时进程快照判断 worktree 是否仍在使用。clean worktree 也只能人工逐个审计；dirty、分叉或处于 Git sequencer 的 worktree 更不能自动删除。长期累积会占用磁盘、污染 `git worktree list`，并增加误删未提交成果或受保护候选的风险。

## 3. 复现步骤

1. 在独立任务中通过 shell 执行 `git worktree add /private/tmp/pi-config-<task> -b <branch>`。
2. 在该 worktree 完成、合入或放弃任务，但不执行统一的 finish/release 流程。
3. 返回主仓运行 `git worktree list --porcelain`。
4. 观察 worktree 仍存在，但仓内没有可关联 session、task、owner token、最终 disposition 或 retention policy 的权威记录。

## 4. 根因

当前生产代码只有 Goal Engine 自己管理的 Executor worktree lease。普通 subagent 编排和历史协调流程可直接通过 shell 创建 `/private/tmp` worktree，却没有共享创建 API、持久 owner manifest、终态 transition 或幂等回收器。`pi-subagents`、typed subagent 和 Root Broker 只管理进程与消息，不拥有这些 Git 资源。

## 5. 为什么此前未发现

每个独立任务都能正常使用自己的目录，集成验证主要关注代码和测试结果，没有以主仓 `git worktree list` 的长期基数作为验收项。任务报告保留 branch/commit，但没有要求证明 linked worktree 已释放；临时目录命名也让资源看起来会由操作系统自动处理，而 Git admin metadata 实际仍由主仓持有。

## 6. 修复方向

建立统一 worktree lifecycle registry 和受控 create/release/preserve 接口；每个创建动作必须先持久化 owner 与 recovery intent。只读 audit 将 active、reclaimable、preserved、dirty、sequencer、unmanaged 分开；普通完成路径自动执行无 `--force` 的 worktree-only 回收，branch 删除独立决策。Doctor 报告 cleanup debt，Agent shell 禁止绕过受控入口直接创建或销毁 worktree。
