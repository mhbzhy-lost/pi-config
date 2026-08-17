# Scheduler 在 macOS 状态目录祖先别名下被误拒绝

## 最小复现

在真实 Pi 0.84.2 的隔离 RPC session 中，将 `XDG_STATE_HOME` 设为系统临时目录下的状态目录；在 macOS 上该路径可经 `/var -> /private/var` 的平台符号链接到达。`session_start` 期间上游 Scheduler 读取注入的 `dataDir`，现有 adapter 从 `/` 逐级 `lstat`，把这个位于 XDG state-home **之上**的系统别名当作不安全链接拒绝。

结果是 Scheduler session_start 返回 `extension_error`，即使 XDG state-home 本身、`pi-task-scheduler` 父目录和仓库 hash leaf 都是实际目录，且其 canonical 位置在仓库外。

## 影响

macOS 上使用 `/var` 表示的合法系统临时状态路径无法启动 Scheduler 扩展；这不是上游调度器或凭据存储的问题。

## 安全边界

允许 state-home 以上的平台祖先别名，但必须在创建前把 state-home 的最近已存在祖先投影为 canonical 路径并确认其不在仓库内，避免祖先链接先造成仓库写入。XDG state-home 自身、`pi-task-scheduler` 父目录和 hash leaf 仍必须是非链接目录；非目录节点 fail closed。创建后必须再次 realpath，确认 canonical dataDir 位于 canonical state-home 内且在仓库外，并维持 `0700`。
