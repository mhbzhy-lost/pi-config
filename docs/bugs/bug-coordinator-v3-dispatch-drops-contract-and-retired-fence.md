# Coordinator v3 派发丢失合同与 retired 栅栏

## 现象

Task 7 初版把 Coordinator 构造参数改为 compiled IR，但没有覆盖完整 v3 消费合同。`retired` Task 仍会进入 Frontier；v3 Attempt 验证读取不存在的 `node.deps`；`dispatchContextHash` 对 prompt 字符串取 hash，而不是绑定 Plan IR、Task、调度、Attempt 和依赖 receipt 的规定结构；dependency receipt 也把非命令 evidence 映射为带空字段的摘要。

## 影响范围

合法 amendment 后已 retired 的 Task 可能被重新派发；v3 Executor 成功后进入验证会抛错；事件中的 dispatch context hash 无法证明实际派发绑定了哪一版 IR 和 Task；非命令验证 evidence 会污染 Executor prompt。现有测试只证明构造接口和旧 v2 流程，不能阻止这些回归。

## 复现步骤

1. 重放包含 `plan.amended` 且 Task 状态为 `retired` 的 v3 projection，再调用 `dispatchAuthorized()`，当前 scheduling view 仍包含该节点。
2. 让 v3 Attempt 成功并通过验证，`settleBoundAttempt()` 执行 `deps: [...node.deps]`，其中 v3 节点只有 `dependencies`。
3. 检查 `attempt.dispatch-requested`，`dispatchContextHash` 来源为 `{prompt, attemptId, baseCommit, output, receipts}`，缺少规定的三个 IR hash 字段。
4. 在 integrated dependency 的 `validationEvidence` 中加入非 command evidence，当前 receipt 仍输出 `{}` 或空字段摘要。

## 根因

实现把“Coordinator 不再编译 Plan”误当成 Task 7 的主要完成条件，只新增了 compiled-IR 构造断言，没有先建立完整 prompt、revision 2 replay、retired、receipt、hash 和 v3 settle 的 RED matrix。Selector 迁移只改变了数据外形，没有逐消费者核对 v3 与 legacy 节点字段差异。

## 修复方案

先补直接 event replay 测试，再修复实现：Frontier 排除 retired；v3 settle 从 `dependencies[].taskId` 生成 deps；receipt 只保留 command evidence；按固定结构计算 dispatch context hash，并验证四个事件 hash；使用确定章节渲染完整 prompt；追加 revision 2 amendment replay，证明下一次 Coordinator 从 event-committed artifact 读取新 IR 且不复用旧合同。

## 验证方式

运行 Coordinator、resource、IR schema、events 和 runner dependencies focused tests；增加 body-only hash、integrated receipt、retired、v3 settle 和 revision 2 replay断言。随后运行 amendment recovery、Capsule、clear-env Host/migration 回归，并检查 Coordinator 不再 import compiler、提交范围和 `git diff --check`。
