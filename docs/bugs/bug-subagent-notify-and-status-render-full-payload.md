# Bug：Subagent 通知与 Status 查询直接渲染完整载荷

## 1. 现象

`subagent-notify` 在主会话中展示完整结果预览、session 文件和 handoff 路径；`subagent({ action: "status" })` 展示 run、进程、模式、进度、目录、日志、session、恢复命令等完整诊断文本。

## 2. 影响

完成通知和主动状态查询占用大量主会话空间，真正需要快速扫描的任务标题与完成状态被长输出淹没。相同数据已经保存在消息、tool result details、session 和异步运行目录中，无需默认全部展开到 TUI。

## 3. 稳定复现

1. 派发一个带 `title` 的异步 Subagent 并等待完成。
2. 自动通知显示 title 之外的 result preview 与 `Session file`。
3. 调用 `subagent({ action: "status", id: runId })`。
4. Tool result 显示完整多行诊断信息，而不是单一状态。

## 4. 证据

上游 `notify.ts` 通过 `pi.sendMessage({ customType: "subagent-notify", content, display: true })` 发送完整 Markdown；当前没有为该 custom type 注册 renderer，所以 Pi 使用默认 Markdown fallback。项目自有 `subagent` tool 的 control 路径用 `rpcResult()` 原样保留上游 `text` 和 `details`，但 tool definition 没有 `renderResult`，因此默认 tool shell 渲染全部文本。

Pi 公开 API 支持 `registerMessageRenderer(customType, renderer)` 和 tool `renderResult`。这两个 renderer 只决定 TUI component，不会改写 `message.content`、`message.details`、`AgentToolResult.content`、`AgentToolResult.details` 或 RPC 回复。

首次接线后的 fresh SDK probe 直接调用最终 registry 中的 renderer，触发了上游 `pi-subagents/src/extension/index.ts` 的完整 preview renderer。Pi 对同一 extension 的 renderer 使用 `Map.set(customType, renderer)`；项目先注册紧凑 renderer，随后 `bootstrap(upstreamSubagentRuntime)` 又注册同名 renderer，因此后者覆盖前者。仅断言“存在 `subagent-notify` renderer”无法区分所有权，产生了假阳性。

## 5. 根因

运行时隔离与 title 绑定已经收敛了数据合同，但可见层仍沿用上游诊断型默认 renderer。通知内容和状态诊断同时承担“机器可用数据”与“默认人眼摘要”，缺少项目级选择性展示层。

同名 renderer 的注册顺序又形成第二层根因：headless membrane 有意允许 upstream 注册 message renderer，项目紧凑 renderer 若在 bootstrap 前注册就会被覆盖。测试只检查 renderer 存在，没有调用最终组件核对输出。

## 6. 修复与验证策略

为 `subagent-notify` 注册只读 renderer：优先使用 title registry 注入的 `details.titles`，只显示每个 title 与 `completed`、`failed` 或 `paused`；无 title 时回退 agent。项目 renderer 必须在 upstream bootstrap 完成后注册，使同一 extension map 的最终值由项目拥有。为项目自有 `subagent` tool 增加 `renderResult`：仅当 `args.action === "status"` 时从原始文本选择 `State:`、active count 或 idle/error 状态，其他操作保持原始可见文本。

折叠和展开都保持紧凑，避免通过 `x` 再打印完整诊断；原始 content/details 完整保留给模型、日志、session 与程序调用。测试必须先证明 renderer 输出不含 result preview、session、dir、log 等字段，同时深比较输入对象未被修改，再验证 fresh reload 无 extension error。

## 7. 验证结果

纯格式化测试 5/5、renderer/隔离测试 34/34、计划聚焦回归 96/96、扩大回归 158/158 通过。fresh probe 首次发现 upstream 同名 renderer 覆盖并以三行输出稳定 RED；调整 last-write 顺序后，独立 SDK create 373.2ms、reload 304.6ms/296.8ms，15 extensions、0 errors。production renderer 实际输出 `✓ Renderer smoke · completed` 与 `Status: running`，status 展开结果相同，原始 message/result 深比较未变。用户在 final reload 后确认真实 TUI completion 只有 title/status，status 折叠与展开都只有状态。
