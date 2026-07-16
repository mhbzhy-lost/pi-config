# Bug：Subagent Dispatch Skill 使用无效社区 API

## 1. 现象

迁移后的 Skill 指导代理调用 `subagent({ prompt, background })`，并用 `run_id` 查询状态。

## 2. 影响

未来代理会生成无法通过 `pi-subagents@0.34.0` schema 的调用，普通 executor/spark 调度在迁移后立即失效。

## 3. 稳定复现

让独立代理只读取当前 Skill，并要求给出跨四文件 executor 异步启动与状态查询调用。代理稳定输出 `prompt`、`background`、`run.run_id` 和 `run_id`。

## 4. 证据

社区 `SubagentParams` 定义执行字段为 `task`、`async`，管理查询字段为 `action`、`id`；Task 1 的真实 tool result 将运行 ID 放在 `details.runId`。独立 RED 场景完整复现了 Skill 中的错误字段。

## 5. 根因

Skill 改写只替换了工具名称，仍沿用旧调度 Adapter 的参数命名，没有以已锁定版本的真实 schema 和结构化 result 为事实源。

## 6. 修复与验证策略

示例固定为 `subagent({ agent, task, async: true, cwd })`，从 `run.details.runId` 取得 ID，再调用 `subagent({ action: "status", id })`。用同一独立场景复测字段选择，并运行 migration contract 与完整单元测试。
