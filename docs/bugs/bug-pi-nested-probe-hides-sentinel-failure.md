# Bug：Nested Probe 隐藏 Sentinel 失败

## 1. 现象

Plan 与 foreground nested worker 已在 18 秒内完成，事件中也有完整 `runId`、`sessionFile` 和 `artifactPaths`，但顶层 RPC 仍等待 180 秒后超时。

## 2. 影响

真实失败点无法从测试输出判断；每次诊断都额外等待三分钟，并把已完成的 nested capability 误报成 RPC 超时。

## 3. 稳定复现

运行 nested integration。Plan 的 `events.jsonl` 在约 11 秒出现匹配的 `tool_execution_end`，随后 probe 在该分支等待 `nested-tools.json`；文件缺失时循环继续，120 秒后 command 抛错但不发送 notify，外层再等到 180 秒。

## 4. 证据

最新 Plan run `cc78fce8-8057-4556-b767-5479588f27d4` 状态为 `complete`，唯一 nested call 的 result 为 foreground shape；测试输出只有 `Pi RPC timed out after 180000ms`，没有 probe 内已收集的 Extension 加载标记。

## 5. 根因

Probe 把“发现 nested lifecycle event”和“sentinel artifact 已生成”写成同一个循环条件，并仅在全部成功后 notify。任何 sentinel 加载或事件处理失败都会被 command 异常吞掉，外层无法区分能力失败和观测失败。

## 6. 修复与验证策略

发现结构化 nested event 后立即结束轮询，独立读取三份 Extension factory 标记并随 notify 返回。外层先断言加载标记，再断言工具快照；缺失时在一次正常 RPC 往返内给出具体层级，不再依赖 timeout 传递失败。
