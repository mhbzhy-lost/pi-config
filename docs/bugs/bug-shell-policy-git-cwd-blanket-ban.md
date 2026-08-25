# shell policy 一刀切禁止 cd+git / git -C，阻断子模组合法提交流程

## 问题描述

`scripts/lib/shell-policy.mjs` 的 `checkShellPolicy` 对两类命令无条件拦截：

- `cd <任意目录> && git ...` → `GIT_CWD_FORBIDDEN`
- `git -C <任意目标> ...` → `GIT_C_FORBIDDEN`

规则意图是「防止实际产生 git 操作的路径与 bash 调用的 cwd 路径不同」（隐式切换 git 上下文，绕过按 cwd 的审计与校验）。但一刀切实现连**工作区内部**的目录切换也禁止，导致：

1. 项目 AGENTS.md 铁律要求「所有改动在本地子模组提交、推送、走 fork CR」——agent 永远无法在 `sub2api` 子模组内执行 `cd sub2api && git commit`，合法流程被自己的防护阻断（2026-08-25，sub2api compact v2 桥任务中主会话与 executor 均被拦截）。
2. 规则目的（可审计性）与实现（全面禁止）不匹配：`commandContext` 已完整解析 cd 上下文并维护各命令段的有效目录，其他检查（`checkRm`、`planTodos`）均按有效目录执行，唯独 git 上下文切换被全面禁止而非按位置审计。

## 复现流程

1. 会话 cwd 为工作区根目录。
2. 执行 `cd sub2api && git status` 或 `git -C sub2api status`（目标在工作区内）。
3. 被 `GIT_CWD_FORBIDDEN` / `GIT_C_FORBIDDEN` 拦截，尽管目标路径完全在工作区内、可审计。

## 修复方案

把「禁止一切上下文切换」收窄为「禁止工作区外的 git 操作位置」，保留原意图（防隐式逃逸到不可审计位置）：

- `cd` + git：按 `commandContext` 解析出的各命令段有效目录判定，任一段落在工作区外 → 拒绝（`GIT_CWD_OUT_OF_WORKSPACE`）；全部在工作区内 → 放行。
- `git -C <target>`：解析 `-C` 的目标（相对当前有效目录），目标缺失、形如标志、含 shell 展开（不可静态判定）或解析后在工作区外 → 拒绝（`GIT_C_OUT_OF_WORKSPACE`）；工作区内 → 放行。
- bash 工具当前无 per-call cwd 参数，无法以「显式声明参数」实现该意图；工作区包含性判定是现有机制下等价的可达审计边界。

既有测试（`test/shell-policy.test.mjs`）对工作区外路径的拦截断言改为新错误码；新增工作区内放行与边界拒绝用例。
