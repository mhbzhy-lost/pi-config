# Bug: plan-runner 无法派发 executor 子 agent

## 现象

`plan_continue` 返回 executor dispatch 指令后，plan-runner 调用 `subagent` tool
派发 executor，被 pi-subagents 拒绝：

```
nested subagent call does not match dispatch intent
```

## 根因

plan-runner 本身是一个子 agent（通过 RPC spawn 启动），运行在 pi-subagents
的 child-safe 模式下。child-safe 模式禁止嵌套 subagent 调用，除非子 agent 被
显式配置为允许 fanout。

`plan_continue` 的 coordinator 返回了 `{ tool: { agent: "executor", ... } }` 指令，
期望 plan-runner 用 `subagent` tool 派发 executor。但 plan-runner 作为子 agent
没有嵌套派发权限。

## 完整调用链

1. 主 session → `plan_run` tool → RPC spawn plan-runner（child-safe 模式）
2. plan-runner → `plan_continue` → coordinator 返回 executor dispatch 指令
3. plan-runner → `subagent({ agent: "executor" })` → **被 child-safe 拒绝**

## 影响范围

所有通过 plan_run / `/plan-run` 启动的 plan，只要 plan 包含需要 executor 派发的 task。

## 触发条件

plan-runner 尝试用 `subagent` tool 派发 executor 或其他 worker agent。

## 修复

两处改动：

1. `coordinator.mjs` 和 `plan-runner-dependencies.mjs` 的 `sameTool()` 从比对字段中
   移除 `task`，保留 `agent`/`cwd`/`context`/`async`/`clarify`。
   LLM 不可避免地会改写 task 文本，严格比对导致 100% 失败。
   安全约束由其余 5 个结构化字段保证。

2. `plan-runner.md` 不设置 `maxSubagentDepth`，依赖 executor/spark 的 tools 白名单
   （不包含 `subagent`）来自然禁止再派发。
   此前设置的 `maxSubagentDepth: 1` 导致 plan-runner 自身（depth=1）
   也无法派发，已移除。
