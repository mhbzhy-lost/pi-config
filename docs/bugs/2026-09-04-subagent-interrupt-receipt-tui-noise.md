# Subagent interrupt 成功回执在 TUI 原样透传

## 现象

主 agent 对 async subagent 执行 `subagent({ action: "interrupt", ... })` 成功后，TUI 显示整行 `Interrupt requested for async run <id>.`。该 tool result 只是 management 动作的固定回执，不含任何新的用户决策信息，占一行噪音；真正有意义的中断效果随后续 run 状态/通知事件呈现。

## 数据来源与分类

- 实际入口：合法公开 `subagent` tool 的 `action: "interrupt"` 管理分支。
- 生成调用链：upstream `pi-subagents@0.62.0` `interruptAsyncRun()`（`runs/foreground/subagent-executor.ts:1156`）返回固定文本回执 -> 增强插件 `renderSubagentResult` -> `formatCompactSubagentToolResult()`。该函数目前只特判 steer/resume/status，interrupt 走默认透传分支。
- 权威身份与顺序：回执由真实 async runner 的 `deliverInterruptRequest` 成功路径产生，run id 来自权威状态。
- 首个偏离点：增强插件 renderer 未为 `interrupt` 成功回执生成精简显示文本。
- 分类：预期 production 数据未被正确处理（AGENTS 第 1 类）。

## 修复边界

仅在 TUI renderer 层为 `action: "interrupt"` 的成功回执返回空显示文本；错误回执（`isError: true`，如 `No running async run...`、`Interrupt is unsupported...`）继续展示。tool result、structured details、agent 实际收到的内容均保持不变。
