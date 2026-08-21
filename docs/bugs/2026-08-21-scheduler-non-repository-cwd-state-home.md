# Scheduler 在非仓库 cwd 启动误报

## 问题

`repositoryDataDir()` 曾将任意 canonical `ctx.cwd` 作为仓库根。当 Pi 从 HOME 等非 Git 目录启动，默认的 XDG state-home 位于该目录下时，词法 containment 检查错误地拒绝 scheduler 数据目录。

## 影响与修复

只有向上查找到真实 Git 工作区边界时，才将该边界用于仓库外置存储检查和 repository identity。普通仓库的 `.git` 目录及 managed worktree 的 `.git` 文件都标记边界；非 Git cwd 使用 canonical cwd 作为 hash identity，但不把它当作需排除的仓库边界。既有 symlink、0700 及 state-home containment 检查保持不变。
