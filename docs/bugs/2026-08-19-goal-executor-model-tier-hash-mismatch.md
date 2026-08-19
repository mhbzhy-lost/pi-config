# Goal Executor modelTier 哈希不一致

## 影响

Goal Engine 派发的 `dispatch-ir.v1` 合同未携带已归一化的 `modelTier`。typed subagent runtime 会把缺省值归一为 `luna` 并纳入 canonical SHA-256，因此同一 Goal 任务在 executor 入口重新编译后产生不同哈希，无法建立精确的 Goal dispatch-to-executor 绑定。

## 根因

`scripts/lib/subagent-dispatch/ir.ts` 已使用共享的 `normalizeModelTier()`：省略 tier 时为 `luna`，并将该字段写入 canonical transport/hash。`scripts/lib/goal-engine/dispatch-ir.mjs` 仍采用旧的无 tier canonical 形状；`compileTaskContract()` 也没有明确写入 Goal 已界定任务的默认 Luna 意图。

## 已观察到的 RED

在修复前已执行：

```bash
node --test test/goal-engine-executor-binding.integration.mjs
```

结果为 **11/19 通过、8/19 失败**；所有受影响用例均以 `EXECUTOR_CONTRACT_MISMATCH` 失败。`npm test` 当时为 631/631 通过，但它只匹配 `test/**/*.test.mjs`，不包含 `*.integration.mjs`，因此未覆盖此回归。
