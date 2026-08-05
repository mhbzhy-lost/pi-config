# Goal Dispatch 合约哈希与 Subagent Schema 冲突

## 1. 预期行为

`goal_dispatch` 返回的 `contract` 应能原样作为 `subagent` typed tool 输入，同时 Goal Engine 继续持久化并校验该合约的 canonical SHA-256。

## 2. 实际行为

`compileCodingDispatchIR` 在 typed contract 顶层添加 `hash`。Subagent 的 `dispatch-ir.v1` strict schema 不接受该字段，因此 Agent 只能手工删除 `hash` 后派发，破坏“原样交付”和机械身份校验。

## 3. 稳定复现

将当前 `goal_dispatch` 返回的 `contract` 原样传给 `subagent`，typed 参数校验会因 unknown field `hash` 拒绝；TokenRec 会话的 8 次派发都被迫改写合约。

## 4. 根因

内部 canonical IR、持久化 ticket 与外部 transport contract 共用了同一对象，没有在 ABI 边界把内部哈希元数据与 strict typed payload 分离。

## 5. 影响范围

Agent 无法遵守 Goal Engine 的原样派发要求；删除字段后的 payload 缺少可直接比对的绑定，后续 title/context 漂移也难以证明。

## 6. 修复与验证

新增纯函数 `splitDispatchEnvelope(ir)`，输出不含 `hash` 且键集合精确匹配 Subagent schema 的冻结 `contract`，同时单独返回 `contractHash`。canonical hash 算法与内部 prompt 不变；先写 ABI RED，再运行 dispatch 专项测试。
