# Revival dispatch 恢复在部分 ledger 写入后才校验

## 1. 现象

外部 Round 1 review 指出，`recoverExecutionState` 对 `dispatch-requested` 只判断 `undefined` / `null`，空字符串和 `timeoutMs: 0` 会通过 operation 构造；operations 随后按 `attemptId` 执行。若前一个 valid、后一个 malformed，前者已经通过 `recoverDispatch` 写入新 backend 的内存 ledger，后者才由 backend 的 `normalizeExecutionSpawn` 拒绝。

## 2. 证据/反证

`execution-backend.mjs` 公开 `normalizeExecutionSpawn`，要求 `dispatchId` / `attemptId` 匹配 ID、`agent` 必须为 `executor`、`task` / `cwd` / `output` 非空、`timeoutMs` 为正 safe integer。当前 dependencies 只做 presence 检查。真实 backend 仍然 fail closed，且没有 spawn / durable 写，因此这不是授权绕过；问题在于违反“全部操作先验证再执行”，产生本 generation 的部分内存恢复。

## 3. 根因

operation builder 复制字段但没有复用共享 structured normalizer，把完整 schema 校验延迟到了 `recoverDispatch` 调用阶段。

## 4. 正确修复

dependencies 导入 `normalizeExecutionSpawn`；presence 错误继续抛出 `Persisted execution dispatch recovery data is incomplete`；其后在构造 operation 时调用 normalizer，并保存返回的 exact request；只有所有 attempt operation 成功构造后，才逐一调用 backend。禁止手写重复 schema 或捕获错误文本。

## 5. TDD

先新增测试：durable projection 包含按 ID 排序的 valid dispatch `attempt-1` 和 `timeoutMs: 0` 的 malformed `attempt-2`；调用 `recoverExecutionState` 应以 `code: INVALID_EXECUTION_REQUEST` reject，且 fake backend 的 `recoverDispatch` 调用数组仍为空、spawn 为 0。当前实现会 resolve 并产生两次调用，因此是真行为 RED。GREEN 后 focused 78/78，Root fixed socket 单独 131/131，backend suites 保持 GREEN。

## 6. 影响边界

只收紧 revival dispatch reconstruction 的预校验原子性，不改 event schema、binding 恢复、订阅顺序、Broker 协议、dispatch 授权或 Harness。
