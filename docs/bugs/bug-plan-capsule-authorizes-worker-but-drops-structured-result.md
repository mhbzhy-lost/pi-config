# Plan Capsule 授权 Worker 后丢失结构化结果

## 现象

Capsule 在 `tool_call` 中消费 coordinator 的 nested intent，但没有处理 `subagent` 的 `tool_result`。Coordinator 的 `bindNestedResult`、`settleBoundAttempt` 与 `acceptReviewedTask` 在真实 Extension 链路中从未被调用，也没有受控 task review 工具。

## 影响范围

Worker 即使成功完成，append-only projection 仍停留在 `attempt.dispatch-requested`；后续恢复会把未知 dispatch 保守标记 blocked，task 永远不能 accepted，四类 Gate 与 `validated` 正常路径不可达。

## 复现步骤

Plan child 调用 `plan_continue` 获得精确 nested 参数，随后真实调用 `subagent` 并返回带 `details.runId/results` 的结果。检查 child session entries，仅存在 dispatch-requested，没有 attempt.bound、attempt.settled 或 task.accepted。

## 根因

Task 11/12 单测分别直接调用 authorization helper 与 coordinator result helper，没有覆盖 Pi Extension 的 `tool_call`→真实 tool→`tool_result` 数据流；领域 review acceptance 也只存在 coordinator 方法，没有 Extension 入口。

## 修复方案

Capsule 在授权时记录对应 attempt，`tool_result` 仅接受匹配的结构化 subagent result，依次 append bound 与 settled；成功后通过只读 reviewer/确定性 review domain决定是否 append task.accepted，模型工具不得直接伪造 acceptance。失败保留可重试状态。进程恢复从 persisted result/artifact保守续跑，不解析展示文本。

## 验证方式

使用 deterministic local provider 跑真实 Pi child：plan_continue→subagent→structured tool_result，断言事件顺序、task acceptance、Gate 与 validatedHead。再覆盖 worker crash、重复 result、结果偏离和 review unavailable fail-closed。
