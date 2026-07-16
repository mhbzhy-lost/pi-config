# Plan Gate 将 pi-subagents 运行产物误判为源码脏文件

## 现象

真实 nested worker 会在专属 worktree 创建 `.pi-subagents/artifacts`。Gate 的未跟踪文件扫描把这些 harness 自有文件视为业务改动，导致 preflight 失败，四类 Gate 全部 failed。

## 影响范围

只要通过真实 `pi-subagents` 执行 worker，即使源码已 clean commit，计划也永远不能 validated；单元测试未创建社区 runtime 目录，因此未发现。

## 复现步骤

真实 Plan child 完成 worker commit 后运行 `git ls-files --others --exclude-standard`，可见 `.pi-subagents/artifacts/...`。derived status 显示 task accepted，但 deterministic、audit、external 与 final-completeness 同时 failed。

## 根因

worktree change-set 扫描没有区分已知 harness runtime namespace 与计划源码；社区 runtime 默认把内部 transcript/artifact 放在 child cwd。

## 修复方案

在 workspace inspection 与 Gate clean/hash 的统一未跟踪文件入口中，仅排除精确 `.pi-subagents/` 目录。其他未跟踪文件仍参与 dirty 与 hash；不得使用宽泛隐藏文件排除。

## 验证方式

新增测试证明 `.pi-subagents/artifacts` 不使 Gate dirty，而普通 untracked 文件仍 fail-closed；真实 Plan E2E 最终四 Gate passed 且 validatedHead匹配 worktree HEAD。
