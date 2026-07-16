# Bug：Nested safety 测试依赖 Plan 模型自行等待 async child

## 1. 现象

Plan child 已成功获得并调用 child-safe `subagent`，nested runId/asyncDir 已写入结构化 tool result，但 Plan 模型将调用设为 async，随后连续执行 36 次 status/read，顶层 Plan run 180 秒仍为 running。

## 2. 影响

兼容门禁会消耗大量 token并超时，无法完成三层工具边界断言；测试 finally 还可能在 active nested run 存在时删除临时 project/package。它把“nested runtime 可用”错误地绑定到特定模型是否遵守等待提示。

## 3. 稳定复现

运行 nested integration。Plan session 的首个 `subagent` tool result 已包含 nested `runId/asyncDir`，之后 transcript 持续出现 `action:status`；顶层 status 的 `recentTools` 和 turnCount 持续增长，最终 `waitForStatus` 超时。

## 4. 证据

Plan `events.jsonl` 中 `tool_execution_end` 的 `result.details` 已结构化记录 nested run。上游 child-safe tool 明确允许 async；Qwen 生成了 `async:true` 且改写了 nested task。测试真正要证明的是显式授权、普通 child 隔离、depth cap 和结构化 lifecycle，不是模型的 polling 策略或自然完成能力。

## 5. 根因

测试把 capability boundary 验证和自主 Plan completion 混成一个目标，依赖 LLM 自觉选择 foreground/wait。没有在获得足够结构化证据后由外层控制面停止 top-level run，也没有把失败 cleanup 与 active-run 回收绑定。

## 6. 修复与验证策略

临时 probe 在 Plan events 出现 nested `tool_execution_end` 且 nested sentinel artifact 落盘后，立即通过 stable top-level `stop` 请求终止 Plan run；等待 top-level 和 nested artifacts 进入终态后才 cleanup。断言 nested identity来自 `result.details.runId/asyncDir`，父 status 的 `steps[0].children` 含同一 id，三份 sentinel 分别证明 ordinary/Plan/nested 工具集。测试不要求模型自然结束，也不解析 status/TUI 文本。
