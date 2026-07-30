# Bug: Task5B authorization RED 未直接覆盖 current identity 字段

## 症状

一次性 Executor authorization 的拒绝矩阵声明覆盖 stale revision/task/scheduling/context，但当前所谓 stale case 只是把 `taskId=task-1` 的 contract 放进 `taskId=task-2` 的 Attempt。测试没有单独篡改 current revision `irHash`，也没有单独篡改 Attempt `dispatchContextHash`。

## 影响

只按 `toolHash`、`taskId` 和 workspace 匹配的实现可能通过现有测试，却会在 Plan amendment 或事件状态损坏后授权旧 revision 的 dispatch，或忽略 dispatch context 对 Attempt/base/output/dependency receipts 的绑定。

## 复现

1. 阅读 `test/plan-executor-tool-boundary.test.mjs` 的拒绝 cases。
2. 搜索 `dispatchContextHash` 可见它只在合法 fixture 构造时赋值，没有被变异。
3. 搜索 revision `irHash` 可见它只被合法 fixture 使用，没有构造 current revision 与 Attempt `planIrHash` 不一致的 projection。

## 根因

复合 RED 用一个 task mismatch case 代替了多项独立身份 fence，测试名称和 regex 给出了覆盖错觉，但没有让具体字段变化成为唯一失败原因。

## 修复

在 production GREEN 前增加独立 projection 变体：一个只修改 current revision `irHash`，一个只修改 matching Attempt 的 `dispatchContextHash`。两项都使用 fresh boundary，断言精确 identity/context mismatch，并断言拒绝后原合法 projection 仍可授权，证明失败不消费 one-shot token。

## 验证

运行 boundary 聚焦测试，当前 `not implemented` 桩下新增独立测试均 RED；失败来自授权实现缺失或期望 reason 不匹配，而不是 reducer/schema/fixture。实现后两项通过，并保留合法、mutation、replay、terminal、workspace、ambiguous 和 parallel 覆盖。
