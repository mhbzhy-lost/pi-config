# Subagent RPC diagnostic options 边界

## 问题

Goal suite 的唯一失败将 non-Goal `rpc.spawn(params, options)` 的 local options 固定为 `undefined`，但当前公开 dispatch extension 会为所有 spawn 传入 local diagnostic trace。该断言把 local extension tracing 与 RPC wire 协议混为一谈。

## 来源与调用链

这是合法 production 路径而非 fixture 伪造：

```text
subagent.execute
  → executeCoding / executeGeneric
  → spawnWorkflowLeaf
  → rpc.spawn(params, { ...identity, diagnostic })
  → rpc-client.call(method, params, options)
  → events.emit("subagents:rpc:v1:request", wire envelope)
```

`diagnostic` 由 extension 的 `trace` 创建，包含当前 tool call 的 `toolCallId` 和 local sink，仅用于 `rpc-*-sent/replied` 诊断事件。`rpc-client` 只从 options 读取 `requestId` 作为 envelope identity；它发送的 wire `params` 来自 spawn 参数，不包含 options。

## RED 证据

在 HEAD `10275ad53a90e1c0afd1528db47f34af7ed89db2` 运行 `npm run test:goal-engine`：1073 tests 中仅 `non-Goal coding runs and generic reviewers remain spawnable without claiming the Goal ticket` 失败。actual non-Goal options 为：

```js
{
  diagnostic: { toolCallId: "non-goal-coding", sink: [Function: trace] }
}
```

失败来自过期的 `undefined` fixture 断言，spawn 行为本身成功。

## 冻结契约

- Goal coding spawn 的 local options keys 必须精确为 `diagnostic`、`requestId`、`spawnKey`；`requestId === spawnKey`，值由 Host-issued Goal ticket 派生。
- non-Goal coding 与 generic spawn 可保留 local `diagnostic`，但不得带 Goal `requestId` 或 `spawnKey`，因此不能 claim Goal ticket。
- RPC wire envelope 只使用 protocol 的 `requestId`；`spawnKey`、`diagnostic`、diagnostic `toolCallId` 和 `sink` 均不得进入 JSON request。

更新后的 executor-binding 与 rpc-client tests 同时证明 local options 和 wire boundary。无需修改 production：`extension.ts` 已按上述调用链传递 local extension diagnostic，`rpc-client.ts` 已将 options 排除在 wire params 之外。
