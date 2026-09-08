# Goal Engine 运行时旁路 Trace 设计

## 结论

不增加可以直接执行八个 Goal typed tools 的 RPC，也不增加第九个 model-facing tool。控制仍只来自真实用户消息（交互输入或 RPC 的 `steer`/`follow_up`/`abort`）。新增的是 Goal runtime 的旁路、追加式观测日志，用来补齐 Pi session JSONL 无法表达的因果关系和内部状态。

## 现状边界

Pi session JSONL 已记录模型可见的消息级事实：`user`、`assistant`（包括 `toolCall` 的名称、id、参数）和 `toolResult`，以及 compaction、branch、model/thinking-level 等 session entry。因此，对“已经进入消息层并实际返回结果”的 tool call，session JSONL 基本可重放。

但它不是 Goal Engine 的完整审计日志，至少缺少：

- `before_agent_start` 注入的来源、因果 turn、注入内容是 transient 还是已持久化；目前 session 中能看到部分 `custom_message/goal-engine-recovery`，但没有 hook 因果标记，不能据此证明完整注入链。
- `tool_call` hook 的 allow/block 决策、决策时使用的 projection/revision、阻断原因（被阻断的调用可能没有正常 tool result）。
- Goal Store 的 event append、CAS/revision、replay、resource/lease/worktree 证明及其与 tool call 的关联。
- tool result 是新执行、失败、重放还是恢复合成；Observation/repair/finalize 等内部阶段转换。
- process crash、Host reload、session transfer、子 agent/root session 之间的跨 session 因果链。

因此不能说 session JSONL 记录了“所有 tool call”；准确说法是：它记录了消息层可见的 tool call，不记录所有 hook、内部调用、阻断和状态变更。

## Trace 文件

每个 Goal state namespace 在权威状态目录旁写入（同一 namespace 内按 `goalId` 字段关联）：

```text
.state/goal-engine/runtime-trace.jsonl
```

Trace 是 append-only，带 `schema`、单调 `seq` 和时间戳。每条记录带可关联字段：`sessionId`、`turnId`、`userEntryId`、`toolCallId`、`goalId`、`runId`、`eventId`、`parentTraceId`。debug 开关打开后保留 hook payload 原文（包括 prompt、tool input/result 与 Goal event data），以支持完整复盘；日志文件仅供本机调试使用并设置为 0600。

## 开关与默认行为

Trace 默认关闭。关闭时不创建 `runtime-trace.jsonl`，不做 payload 序列化，也不申请 trace writer 锁；Pi session JSONL 和现有 Goal `events.jsonl` 的行为完全不变。

建议提供两级开关：

```json
{
  "goalEngine": {
    "runtimeTrace": { "enabled": false }
  }
}
```

- 配置项是持久默认值，必须显式为 `true` 才启用。
- 调试实验可用进程级环境变量 `PI_GOAL_ENGINE_TRACE=1` 临时打开，不修改提交的 `pi/settings.json`；`0`/未设置均为关闭。
- 环境变量是进程级显式 override：`1/true` 开启，`0/false` 关闭；它只影响新增 debug trace，不能关闭已有的安全审计事实，也不能改变任何 Goal 控制语义。
- 开关在 Host/session 启动时确定并写入首条 `trace_config`（enabled、sessionId、schema）；一次运行中不热切换，避免出现半条因果链。
- 即使打开，trace writer 仍是旁路 observer：写入失败只产生诊断告警，不得触发 tool、Goal event、workspace 或 lease 操作。

最小事件集合：

```json
{"schema":"goal-runtime.trace.v1","seq":42,"kind":"before_agent_start","sessionId":"s","turnId":"t","goalId":"g","prompt":"resume"}
{"schema":"goal-runtime.trace.v1","seq":43,"kind":"tool_call_gate","toolCallId":"c","toolName":"goal_status","decision":"allow","projectionVersion":7,"reasonCode":"…"}
{"schema":"goal-runtime.trace.v1","seq":44,"kind":"tool_result","toolCallId":"c","toolName":"goal_status","outcome":"ok","durationMs":31,"content":[{"type":"text","text":"…"}]}
{"schema":"goal-runtime.trace.v1","seq":45,"kind":"goal_event","eventId":"e","eventType":"condition.observation_recorded","revision":8,"persisted":true}
```

需观测 `user_message_received`、`before_agent_start`、`prompt_injection`、`tool_call_seen`、`tool_call_gate`、`tool_result`、`goal_event`、`observation/repair/finalize` 阶段、compaction/reload/branch/crash 和资源释放结果。Trace writer 不拥有 Goal authority、锁或 mutation API；写日志失败不得偷偷改变 Goal 语义。状态转换类 audit facts 要求持久化确认，诊断类 telemetry 可 best-effort。

## 验证方式

实验由独立 OS 进程启动真实 Pi；只发送用户消息，不直接 execute tool definition。旁路 observer 同时读取 session JSONL、Goal `events.jsonl` 和 runtime trace，验证：

1. 每个消息层可见 `toolCall` 都有 `tool_call_seen`，每个被 hook 阻断的调用都有 `tool_call_gate`，即使 session 中没有 tool result。
2. 每次自动 prompt 注入都有唯一的 `before_agent_start`/`prompt_injection` 记录，并能关联到 user entry 和 turn。
3. 每个 Goal event 都能关联到触发它的 user/tool/turn；trace 本身不能产生 event、workspace、lease 或 process。
4. reload、compaction、branch、crash、子 agent 场景不会丢失或伪造因果链。
5. exact-eight tool ABI、action token、approval、revision 和 fail-closed 门禁保持不变。

## 分阶段

- Phase 1：只读 trace writer + schema + session/event/trace 对账器。
- Phase 2：接入 `before_agent_start`、`tool_call`、`tool_result` 和 Goal event append 的 correlation。
- Phase 3：加入 Host/reload/lease/worktree/子 agent 及 crash 观测。
- Phase 4：用真实 Pi 进程跑 PASS/FAIL/recovery 矩阵；稳定后再决定是否提供只读外部查看器。任何查看器都不能执行 Goal mutation。

## 不做的事情

- 不修改 Pi `runRpcMode` 增加任意 tool invocation。
- 不把 observer 暴露为模型可调用的控制工具。
- 不从 trace 反向恢复或补写 Goal state。
- 不因测试 fixture 缺失而增加 production fallback。
