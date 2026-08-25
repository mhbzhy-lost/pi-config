# shell policy 禁止 cd+git / git -C：子模组提交流程缺少声明式 cwd 通道

## 问题描述

`scripts/lib/shell-policy.mjs` 的 `checkShellPolicy` 对两类命令无条件拦截：

- `cd <任意目录> && git ...` → `GIT_CWD_FORBIDDEN`
- `git -C <任意目标> ...` → `GIT_C_FORBIDDEN`

2026-08-25 sub2api compact v2 桥任务中，主会话与 executor 均无法在 `sub2api` 子模组内提交（AGENTS.md 铁律要求的合法流程被阻断）。

## 根因分析（含一次错误修复的复盘）

禁令的真实意图（用户确认）：**防止实际产生 git 操作的路径与 bash 调用声明的 cwd 不一致**。下游门禁依赖这一一致性：`security-gates-extension.mjs` 的 push review 用 `gatherDiffInfo({ cwd })` 按调用 cwd 读 diff；若 git 实际发生在 `~/new-api-account-pool/sub2api` 而声明 cwd 是 `~/new-api-account-pool`，push gate 会读错仓库的 diff（读到根仓而非子模组）。因此禁令本身是正确的，不应放宽。

曾尝试的修复（已回滚）：把禁令收窄为"工作区包含性判定"。错误原因：包含性不等于 cwd 一致性，放开后 push gate 的 diff 读取歧义依旧存在；测试曾按错误语义改绿（640/640），语义纠正后全部回滚至原状。

真正的缺口：**bash 工具没有 per-call cwd 参数**，agent 无法"声明式"地把 git 工作目录告知门禁；cd/`git -C` 是隐式切换，门禁不可见，故被禁。

## 处置方案

1. 策略不改（禁令保留）。本文档记录意图与误修复复盘，防止后续 agent 重犯包含性放宽错误。
2.  interim 合法通道：以子模组目录为会话 cwd 派发 subagent（`execution.cwd = 子模组路径`），其 bash 声明 cwd 与 git 实际目录一致，门禁可正确读 diff；该 subagent 仅执行分支/提交/推送，不做其他变更。
3. 长期：Pi runtime bash 工具增加 per-call cwd 参数（声明式、全门禁可见）后，可重新评估是否以声明机制替代禁令。
