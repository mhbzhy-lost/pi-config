# recoverBinding 并发 lookup 重复发布 completion

## 1. 现象

外部 Round 1 review 发现，`createPiSubagentsExecutionBackend().recoverBinding()` 在检查 `pending`/`byRunId` 后会 `await rpc.lookupSpawn()`，首次本地 ledger 写入发生在 await 之后。两个并发、完全相同的 `recoverBinding` 调用都可能在 ledger 仍为空时通过检查，各自查询 Root、各自覆盖 `pending` entry，并各自发布一个 `execution.completed` fact。

当前 Plan Runner 的 `recoverExecutionState` 按稳定 attemptId 串行执行，且不同 attempt 使用不同 dispatchId，因此真实 task63bs 路径不会自然触发同一 dispatch 并发调用；该问题是 execution backend 公共 API 的幂等性缺口，严重度为 Important，而不是外部 reviewer 标注的 Critical。

## 2. 真实证据与反证

现有测试只连续 `await recoverBinding(binding)` 两次。第一次完成lookup和ledger写入后，第二次命中existing binding直接返回，所以能证明串行幂等，不能证明并发single-flight。

外部review还提出先登记权威ledger再await lookup。该建议不采纳：Root lookup的state、binding identity与typed observed proof都属于恢复输入，必须在首次`pending`/`byRunId` mutation前完成验证；否则非法lookup会留下部分ledger，违反已有“错误后修正响应可重试”的测试和恢复原子性要求。

`.mjs`导入`.ts`的兼容性 finding 已反证：`package.json`要求Node `>=22.19.0`，当前Node 26，仓库多个MJS测试长期直接导入TS，focused suites和真实Pi runtime均使用该能力。Root spawned entry无binding finding也由同步state machine反证：`state="spawned"`与binding赋值之间无await，外部请求无法插入；dispatch外层仍会把内部不变量异常转为失败响应。

## 3. 根因

`pending`同时承担“已验证权威binding ledger”和“并发占位”两种职责。为了保证非法lookup前零权威mutation，当前实现把写`pending`延后到await之后；但没有独立的、非权威in-flight coordination记录，于是相同恢复调用无法共享同一次lookup。

`completionPublished`只能去重同一个entry后续收到的lifecycle event。并发调用会创建两个不同entry，因此该flag不能阻止第二次fact。

## 4. 正确修复

增加backend实例私有的`recoveringBindings` single-flight map，以`dispatchId`为键，值包含exact recovered binding identity与共享Promise。它不是权威ledger，不参与status/control/事实匹配。

首次调用完整验证durable binding/session和existing conflicts后创建single-flight operation；operation查询并严格验证Root lookup，然后再次检查backend仍ready和ledger没有在await期间改变，最后一次性写`pending`/`byRunId`并最多发布一个completion fact。并发exact调用复用同一Promise；同dispatch但不同binding identity立即以binding conflict拒绝。

operation无论成功或失败都在finally删除自己的single-flight记录。lookup非法、RPC拒绝或backend dispose不得留下`pending`/`byRunId`，后续修正响应仍可重试。不得通过预写权威entry、polling、sleep、status或spawn解决。

## 5. TDD 验证

先提交tests-only RED：

1. 使用受控deferred lookup同时启动两个exact `recoverBinding`；release前必须只有一次lookup，release后两个Promise返回同一exact binding且facts恰好一个。当前实现会观察到两次lookup并RED。
2. 第一个binding lookup in-flight时，并发传入同dispatch但不同runId/asyncDir的binding必须立即以`EXECUTION_BINDING_CONFLICT`拒绝，不能发起第二次lookup，也不能影响第一个成功。
3. 保留已有非法lookup后修正重试测试；可补dispose during lookup的fail-closed断言，但不得使用墙钟sleep。

GREEN仅修改`pi-subagents-execution-backend.mjs`，不得修改Root broker、protocol、migration或既有测试期望。focused backend、固定socket Root、FIFO/revival和dependencies/Capsule suites必须全绿。

## 6. 影响边界

影响仅是同一backend实例、同一dispatchId的并发binding恢复协调。Root official proof authority、lookup schema、Plan Runner串行durable recovery、subscription ready、normal lifecycle、supersede和Plan events保持不变。

若不修，未来调用方并行恢复同一dispatch时会重复触发coordinator recovery，可能重复status/artifact读取或形成领域竞态；并发窗口在lookup延迟时暴露，修复代价中。若错误地预写权威ledger，则非法Root响应会污染恢复状态，修复代价和风险更高。
