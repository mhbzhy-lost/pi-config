# Bug: Subagent Extension 相对路径按业务仓 cwd 错误解析

## 现象

在 `mega-aone-service` 运行 `plan_run` 时，Plan Runner 在 0 turn、0 token 阶段失败；普通 Executor 也无法启动。错误均为找不到 `pi/extensions/provider-fallback.ts`，但错误路径位于业务仓或 Plan worktree 下。

## 影响

所有从 `pi-config` 以外项目启动的 `executor`、`spark`、`plan-reviewer` 和 `plan-runner` 都可能在模型调用前退出。Plan Runner 无法执行计划、Gate 或 external review，普通 Subagent-Driven 执行也受影响。

## 根因

四个 Agent profile 显式声明相对路径 `extensions: pi/extensions/provider-fallback.ts`。`pi-subagents` 将该值原样作为 `--extension` 参数传给子 Pi；Pi 按子进程 cwd 解析相对路径，而不是按 Agent profile 或 `PI_CODING_AGENT_DIR` 解析。

## 促成因素

1. 契约测试只断言 profile 中包含该相对字符串，没有从外部项目 cwd 启动。
2. Plan 集成测试使用临时 Extension 的绝对路径，未覆盖真实 profile。
3. `subagentOnlyExtensions` 同时混入 worktree wrapper 和配置仓 Extension，两类路径拥有不同基准目录。
4. Acceptance 拒绝只显示“缺少结构化报告”，容易掩盖更早的 Extension 加载错误。

## 修复方向

移除四个 profile 的显式 `extensions`，让子 Pi 使用正常的配置根 Extension 自动发现；Plan Runner 的 `subagentOnlyExtensions` 只保留 launcher 写入当前 worktree 的 `.pi-subagents/plan-runner-entry.mjs`。同步更新 Doctor 和迁移契约。

## 防复发

契约测试必须断言普通 Agent 不携带 cwd-relative Extension allowlist，Plan Runner 只携带 worktree-local wrapper。跨项目 smoke test 应从临时业务仓 cwd 启动自定义 Agent，并检查 Extension 加载阶段不出现路径错误。
