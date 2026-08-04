# Bug：已跟踪的 Goal state 被误分类为未忽略

## 1. 现象

`.state/goal-engine` 已被 Git index 跟踪且仍由 `.gitignore` 忽略时，`goal_init` 旧实现返回 `STATE_NOT_IGNORED`，而非应优先报告的 `STATE_TRACKED`。

## 2. 触发条件

强制 `git add -f .state/goal-engine/...` 一个被忽略的 state 文件后调用 `goal_init`。

## 3. 根因

旧顺序先运行 `git check-ignore -q .state/goal-engine/`。Git 默认不为 tracked path 报告 ignore，因此该命令返回 1；代码将该正常结果直接解释为未忽略，未再检查 index。

## 4. 影响范围

调用者收到错误的可操作 remediation，无法得知必须先从 Git index 移除 state 目录；失败仍应在创建 registry、events 或 worktree 前结束。

## 5. 修复方案

先以 `git ls-files -- .state/goal-engine` 检查 tracked entry，并在有输出时返回既有 `STATE_TRACKED` 错误。无 tracked entry 后再确认整个目录被忽略；Git 基础设施失败继续 fail-closed。

symlink amend origin 的 verifier oracle 必须对 lexical symlink 路径调用 `realpathSync` 后使用 canonical physical 路径；不得把 macOS `/var` 的 raw alias 当作 canonical realpath。

## 6. 验证方案

preflight fixture 精确断言 tracked case 为 `STATE_TRACKED`，以及零 registry/events/worktrees。amend symlink 测试同时覆盖 ctx 的 lexical symlink cwd 和 `realpathSync(lexical)` 得到的 physical canonical cwd，二者均应被拒绝。
