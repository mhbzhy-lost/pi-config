# Root Broker listener 启动顺序误分类

## 现象

T8 曾将 reload/startup 时同步发出的 `subagent:async-started` recovery event 未进入
`ownedRuns` 归类为 Root Broker listener 晚注册。该结论不成立：事件已经被 Broker
精确观测为 `facadeRuns`，只是不会因未授权事件取得 owned-run authority。

## production 调用链

1. project `extensions/subagent-runtime.ts` 调用
   `installHeadlessTypedSubagentRuntime`。
2. enhanced extension bootstrap 通过 headless membrane 捕获 upstream 的
   `session_start` handler，未立即把它注册到 Pi。
3. `createTypedSubagentExtension` 的 ready gate 在 session start 时先调用
   `beforeUpstreamSessionStart`；project hook 在此 `await startAndBindRootBroker`，
   而 `RootBrokerServer.start()` 已注册 `subagent:async-started` listener。
4. ready gate 随后调用 upstream session-start handler；upstream synchronous
   recovery 触发 `subagent:async-started`。

因此 listener registration 早于 upstream recovery；首个偏离点是 fixture/断言将
未注册 recovery event 的观察结果错误地期待为 `ownedRuns`。

## 修正后的可观察性与安全边界

production-style fixture 使用实际 headless bootstrap、captured upstream session-start
handler 和同步 `pi.events.emit`。它断言 Broker 的 `facadeRuns` 保存完整的
`runId/pid/sessionId/agent/asyncDir/kind`，并断言 `ownedRuns` 仍为空。

不从 status 或日志重放事件，也不加入 fallback。只有预先注册的
`RunAuthorization` 才能建立 owned authority；这样保持 duplicate/conflict、session
identity 和 cleanup 的 fail-closed 约束。
