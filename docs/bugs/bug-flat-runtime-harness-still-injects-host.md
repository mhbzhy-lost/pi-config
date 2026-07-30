# Bug：Flat runtime Harness 仍注入已退役 Host

## 症状

真实 flat runtime Harness 仍向 fixture 注入 retired `hostRuntime` 或 `planRunnerEntry`，运行时无法建立 Root broker，并报出 `Root subagent broker is unavailable`。

## 影响

Harness 不能覆盖当前 flat broker 运行模型，真实集成回归持续 RED；若通过恢复 Standalone Host fallback 掩盖，会重新引入已删除的授权路径。

## 复现

已复现两个 Harness RED 命令：`node --test test/plan-parallel-harness.test.mjs` 与 `node --test test/plan-parallel-harness-integration.test.mjs`。两者均因 fixture 注入旧 Host 依赖而得到 `Root subagent broker is unavailable`。

## 根因

旧 fixture 仍构造并传递 `hostRuntime/planRunnerEntry`，但 flat runtime 已要求 Root broker；fixture 尚未迁移到真实的 broker-backed runtime。

## 修复

修复归属 Task10：创建真实 flat runtime Harness 并修改 `plan-parallel-harness`。本任务不恢复任何 Host fallback，也不添加兼容注入分支。

## 验证

Task10 完成后重新运行上述两个 Harness 命令，确认 fixture 使用真实 broker 并不再出现该错误；本任务仅保留当前 RED 记录。
