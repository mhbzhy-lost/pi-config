# Terminal proof 恢复测试吞掉无 proof 错误

## 1. 现象

独立 reviewer 检查 `bcda0bc` 新增的 execution backend 回归测试时发现，`recoverBinding never trusts an invalid or absent Root terminal proof` 将三个应拒绝的非法 lookup 响应和一个合法的“spawned binding 但尚无 processTerminal”响应放在同一参数表中，并统一执行：

```js
await backend.recoverBinding(binding).catch(() => undefined);
```

因此当前 production 即使错误拒绝合法无 proof 响应，该测试仍会 GREEN。测试只证明没有发布 completion fact，不能证明 active binding 已成功恢复。

## 2. 真实证据与反证

当前 backend focused suite 为 `33/33`，但绿色结果不能覆盖被 `.catch` 吞掉的返回语义。独立 reviewer 的只读探针确认当前 production 实际行为是：合法无 proof lookup 成功返回 binding；unknown field、binding mismatch 和 non-observed proof 以 `EXECUTION_BINDING_INVALID` 拒绝。这说明 production 当前正确，缺口位于回归测试表达，不需要修改实现。

positive official observed proof 用例已经断言唯一 completion fact、单次 lookup、重复 recovery 和 queued completion 去重；Root broker 用例已经断言 proof 观察前省略 `processTerminal`、观察后返回 exact proof。此次问题不推翻这些证据。

## 3. 根因

测试为了在同一 table 中兼容“非法响应应 reject”和“无 proof 应保持 active”两种不同契约，使用统一 catch 抹平了控制流差异。随后只断言 `facts=[]` 和 lookup 调用，导致成功与失败都满足同一预期。

这是测试设计错误：不同业务结果被压成相同可观察值，形成假 GREEN。生产代码没有相应根因。

## 4. 正确修复

将合法无 proof case 与非法 cases 分开：

1. 无 proof 用例必须 `await recoverBinding(binding)` 并精确返回 durable binding；facts 为空；lookup 恰好一次；随后同 identity lifecycle completion 仍可发布一个正常 fact，证明 binding 真正进入 active ledger。
2. unknown proof field、binding identity mismatch 和 non-observed proof 必须分别使用 `assert.rejects`，错误码精确为 `EXECUTION_BINDING_INVALID`；facts 为空且 lookup 恰好一次。
3. 至少一个非法 case 在拒绝后用修正的 exact reply 重试同一 binding并成功，证明 lookup validation 发生在 ledger mutation 前，没有部分写入。

不得修改 production、Root broker、migration 或测试外路径。

## 5. TDD 验证

这是纯测试纠错，不产生 production 逻辑变更，显式采用 TDD 豁免：目标 production 行为已由当前实现提供，新增精确断言预期直接 GREEN；后续不会以该测试为依据补写实现。

验证命令：

```sh
node --test test/plan-execution-backend.test.mjs
node --test test/root-subagent-broker.test.mjs
```

必须分别得到 `33/33` 和 `133/133`，`git diff --check` 通过，提交只包含 `test/plan-execution-backend.test.mjs`。

## 6. 影响边界

影响仅是跨 generation terminal proof recovery 的测试可信度。它不改变 Root official proof authority、lookup schema、backend ledger、completion dedupe、subscription ready、Plan events 或 Harness runtime。

若不修，未来实现回归为“无 proof 也拒绝”时 focused suite仍会误报绿色，真实 Plan Runner可能在Executor尚未terminal的恢复窗口直接失去active binding；该问题会在跨generation timing变化时暴露，修复代价低，但错误放行代价中。
