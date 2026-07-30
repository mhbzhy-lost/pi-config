# Bug：late-start RED 在成功 teardown 后读取 terminal proof

## 1. 现象

动态 collector 修正后，late-start Executor 会被正确纳入 close 流程，`close()` 正常 resolve。
正常 teardown 随后会清空 `terminalProofs`。测试约在 line 1920 却在 `close()` 之后读取
`broker.terminalProofs.get('late-start-executor')`，因此该读取必为 `undefined`。

当前 RED 仍停在前置的“提前 stop”断言失败，尚未执行到这个错误观察点；GREEN 使 close
正确等待并完成 teardown 后，才会暴露该测试自身的错误。

## 2. 影响

测试会把成功 teardown 的预期清理误判为 terminal proof 丢失，无法验证 late-start Executor
在 dispose 时确实已有正确的 proof。若为使旧断言通过而保留 `terminalProofs`，会改变 production
成功 teardown 的资源释放语义，并引入不应存在的状态残留。

## 3. 触发条件与证据

- dynamic collector 已正确收集 late-start observation，`close()` 成功 resolve。
- 正常 teardown 按既有语义清空 `broker.terminalProofs`。
- 测试在约 line 1920 的 `close()` 之后调用
  `broker.terminalProofs.get('late-start-executor')`，读取结果必为 `undefined`。
- 现有 RED 先因 close 前发生 stop 的断言失败而中止，故没有暴露 close 后 Map 已清空的读取错误。

## 4. 根因

测试混淆了两个生命周期时点：proof 在 upstream `dispose` 调用时必须可用，而 successful
teardown 完成后 `terminalProofs` 必须被释放。将 Map 当作 close 返回后的持久结果读取，违反了
其仅在 teardown 过程内供 dispose 使用的生命周期。

## 5. 处理决策

这是一处测试观察点校准，不改变 production teardown。fixture 使用 `let broker`，使 upstream
`dispose` closure 可读取实例；在 `dispose` 被调用时保存
`broker.terminalProofs.get('late-start-executor')` 到外部 `disposeTimeProof`。

测试在 `close()` 后断言 `disposeTimeProof` 的 `runId` 与 runner identity 正确，并另行断言
`broker.terminalProofs.size === 0`。这同时证明 proof 在 dispose 前存在，且 successful teardown
完成后已释放。不得为测试保留 `terminalProofs`，也不得调整成功 teardown 的清理语义。

## 6. 验证

1. 将 fixture 改为 `let broker`，并在 upstream `dispose` callback 中保存
   `disposeTimeProof`。
2. 执行 late-start close 测试：close resolve 后，断言 `disposeTimeProof.runId` 和 runner identity
   与 `late-start-executor` 的预期运行一致。
3. 同一 close 后断言 `broker.terminalProofs.size === 0`，确认 Map 未被保留且 successful teardown
   已清理其状态。
4. 保持 RED 的提前-stop fence；GREEN 后该 fence 通过时，以上校准后的观察点应验证 proof 的
   dispose 时存在性，而非错误地在 teardown 后读取 Map。
