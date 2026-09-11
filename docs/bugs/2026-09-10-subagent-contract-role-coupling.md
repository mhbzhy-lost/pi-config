# 问题：generic subagent 合同与角色、自由文本耦合

## 现象

当前 generic public schema 只要求 `agent`、`title`、`task`，并允许调用方携带 `cwd`、`worktree`、`skill`、`reads`、`acceptance` 等字段。`genericContractHash` 只覆盖 agent、title、task、session context、requested cwd 和 model，不能表示五段 prompt 的完整语义。

## Provenance

- 实际入口：`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts` 的 `TYPED_SUBAGENT_PARAMETERS` 将 generic 输入路由到 `executeGeneric()`。
- 权威身份：Host 扩展拥有 tool call、agent discovery、RPC capability ping、root session 与 `genericRunAuthorization()`；caller 只提交 public input，不能成为 authority。
- 事件或资源顺序：public tool schema 校验 -> `executeGeneric()` 的 agent/title/task 检查 -> agent discovery/model 选择 -> 可选 workspace allocation -> RPC spawn -> child binding -> Host 注册 generic authorization。
- 首个偏离点：`GENERIC_SCHEMA.required` 仅含 `agent`、`title`、`task`，而 `genericWorkflowSpawnParams()` 直接把自由文本 `task` 及若干 caller 字段交给 workflow；尚不存在独立五段 codec。
- 数据来源分类：**production**。该路径是已注册的 public typed tool 的正常调用路径，不依赖手工 projection、mock event 或过期 fixture。

## 影响

调用方不能以结构化、可哈希方式表达 context、constraints、deliverable 与 done；与此同时角色名和 caller 输入靠近 runtime/spawn 边界，增加把 profile 或输入误当权限来源的风险。

## RED 证据

`test/subagent-generic-prompt-contract.test.mjs` 只从预期 public codec 的可观察输出断言五段字段各自改变编译 hash。当前 RED 为 `generic five-part prompt codec must exist`，原因是 `src/contracts/generic-prompt.ts` 不存在，不是 resolver identity 既有基线。
