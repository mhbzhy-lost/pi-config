# Subagent resume 结果在 TUI 中透出完整运行时回执

## 现象

主 agent 通过 typed `subagent` 工具恢复暂停任务后，TUI 完整显示 upstream 的固定 resume 成功回执，包括旧/new run id、session、async dir、intercom target，以及面向 agent 的异步调度指引。用户只需要看到恢复的是哪个任务及其当前状态。

## 数据来源与分类

- 实际入口：`subagent({ action: "resume", id, message })`。
- 生成调用链：增强插件 `executeControl` -> typed RPC `resume` -> `pi-subagents@0.62.0` `resumeAsyncRun` -> `formatAsyncStartedMessage` -> 原始 tool result。
- 权威身份与顺序：请求中的 `id` 指向已暂停 source run；upstream 成功分配新的 revived run 后返回 `details.asyncId/runId`、session 与 async dir，随后该 run 进入后台运行。
- 首个偏离点：`formatCompactSubagentToolResult` 仅精简 `steer` 和 `status`；成功 `resume` 落入通用分支并原样返回全文。
- 分类：预期 production 数据未被正确处理。该数据由合法 typed 入口和正常 upstream 事件顺序产生，运行事实有效。

## 修复边界

只在 TUI renderer 中将成功 resume 显示为带播放三角的任务标题与 `resumed` 动作状态。原始 tool result、structured details、event payload、session 内容以及主 agent 实际收到的信息均保持不变；resume 失败结果继续完整显示。
