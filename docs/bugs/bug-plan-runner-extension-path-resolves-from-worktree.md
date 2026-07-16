# Plan Runner Extension 路径从计划 Worktree 错误解析

## 现象

生产 `plan-runner` profile 使用 `subagentOnlyExtensions: ../extensions/plan-runner.ts`。Plan child 在业务仓库 worktree 中启动时，找不到该 Extension，因而无法注册 `plan_open` 等生命周期工具。

## 影响范围

所有不位于 `pi-config/pi/agents` 相邻目录中的真实计划 worktree 都受影响；测试中使用绝对临时 wrapper 的 happy path 不受影响，因此此前未暴露生产装配错误。

## 复现步骤

让 `pi-subagents@0.34.0` 从生产 profile 构造 child 参数，并将 child `cwd` 设为任意独立 worktree。运行参数保留相对路径，Pi `0.80.6` 按 child `cwd` 解析后指向业务仓库父目录下的 `extensions/plan-runner.ts`，该文件不存在。

## 根因

`pi-subagents` 解析 agent frontmatter 时只拆分 `subagentOnlyExtensions`，不会按 profile 文件位置转成绝对路径；构造 Pi 参数时也原样追加 `--extension`。Pi 则明确按启动 `cwd` 解析本地 CLI 路径。现有 contract 只断言字段以 `plan-runner.ts` 结尾，真实 E2E 又覆盖成绝对 wrapper，遗漏了这条跨组件路径语义。

## 修复方案

由 Parent Launcher 在每个可信计划 worktree 的 `.pi-subagents/` runtime namespace 中生成只引用可信配置入口的 wrapper；生产 profile 固定加载该 worktree 相对路径。该 namespace 已被源码 dirt 检查排除，不污染计划变更，并避免把机器相关绝对路径写入仓库配置。

## 验证方式

先用真实 Pi 与 `pi-subagents` 在任意临时 worktree spawn 使用同一路径契约的 deterministic Plan child，确认修复前 Extension 不存在或无法加载；修复后确认 child 成功加载并看到 Plan tools。再运行 unit、`test:subagents` 与 `test:plan` 全套回归。
