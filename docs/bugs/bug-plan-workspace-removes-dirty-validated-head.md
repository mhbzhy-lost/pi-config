# 已验证 HEAD 仍删除脏执行仓

## 现象

执行仓完成 Gate 校验后，即使随后新增已跟踪修改或未跟踪文件，`removePlanWorkspace()` 仍会删除整个 worktree。

## 影响

尚未进入已验证提交的执行结果会被静默丢弃，违反删除前必须保持干净、可验证的约束。

## 复现步骤

1. 创建执行仓并取得 `inspectPlanWorkspace()` 返回的 `headCommit`。
2. 修改已跟踪文件，或创建未跟踪文件。
3. 用该 `headCommit` 调用 `removePlanWorkspace()`。

## 根因

删除逻辑只比较 HEAD，未检查已跟踪修改和未跟踪文件；同时传入 `git worktree remove --force`，绕过 Git 对未提交内容的删除保护。

## 修复方案

删除前重新检查执行仓的已跟踪修改和未跟踪文件；任一存在即以明确的 clean 错误拒绝。移除 `--force`，让 Git 在检查与删除之间再次拦截并发变化。

## 验证与回归

用真实临时 Git 仓覆盖两类脏状态，断言删除被拒绝且 worktree 和文件保留；运行目标测试与完整测试套件。
