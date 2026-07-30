# Bug: Task5B boundary RED 把派生 hash 混入 dispatch contract

## 症状

新建的一次性 Executor authorization 测试把 `compileCodingDispatchIR()` 的完整返回值直接作为 `boundary.authorize()` 输入。该返回值包含派生字段 `hash`，而真实 Coordinator 会通过 `{ hash: contractHash, ...contract }` 分离后只返回 `contract`。

## 影响

`dispatch-ir.v1` 顶层 `additionalProperties: false`，正确 boundary 重新 compile 测试输入时应因未知 `hash` 字段拒绝。若为了让当前测试通过而放宽 compiler 或删除 unknown-field 门禁，会扩大模型可调用协议并破坏 exact-contract 授权。

## 复现

1. 在测试中执行 `const exact = compileCodingDispatchIR(source)`，然后调用 `compileCodingDispatchIR(exact)`。
2. Compiler 报 `contract contains unknown field hash`。
3. 对照 Coordinator `prepareAuthorizedDispatches()` 返回值可见，真实 tool input 不含 `hash`，canonical hash 单独位于 `contractHash`。

## 根因

测试 fixture 混淆了 compiler 内部返回对象与 model-callable source contract，没有复制 Coordinator 的 hash 分离边界。Projection fixture 又用 `input.hash` 作为 `toolHash`，进一步掩盖了输入对象身份错误。

## 修复

测试 helper 返回 `{ contract, contractHash }`：`contract` 是删除 `hash` 后的完整 `dispatch-ir.v1`，`contractHash` 单独用于 event `toolHash` 和 authorization 期望值。所有 mutation 重新 compile source 后同样分离；projection helper 显式接收两者，不从 contract 读取派生字段。

## 验证

校准后先断言 `compileCodingDispatchIR(contract).hash === contractHash`，再运行 boundary 矩阵。当前 not-implemented 桩仍使合法授权、拒绝 reason 和并行授权测试 RED，但失败不再来自 schema/fixture；Capsule active-tools 与 exact forwarding RED 保持不变。
