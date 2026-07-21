# Bug: Plan Runner 完成时 Gate 和 External Review 未强制执行

## 现象

Plan Runner 自行实现了全部 7 个 Task 并声称完成，但：
- `plan_verify` 从未被调用
- 四类 Gate（deterministic、plan-audit、external-review、final-completeness）未产生任何 `gate.finished` 事件
- 外部两轮 LLM 评审从未触发
- `validatedHead` 为 null，`lifecycle` 停留在 `running`
- Plan Runner 仍然以"任务完成"的姿态正常退出

## 影响

Gate 和 external review 是计划执行仓的最终门禁，用于证明特定 commit 经过了确定性验证、审计、独立评审和完整性检查。如果这一层依赖模型"记得调用 `plan_verify`"，那任何行为偏差都会绕过它。

## 根因

**Gate 执行依赖 Plan Runner 的主动调用，而非运行时强制。**

当前架构：
1. Plan Runner 在所有 Task 完成后，应主动调用 `plan_verify`
2. `plan_verify` 触发 `runPlanGates()` 执行四类 Gate
3. 只有通过后才写入 `plan.validated` 事件

问题：
- Plan Runner 的 agent prompt 过于简洁（"Use only the Plan tools for lifecycle intent"）
- 当 Plan Runner 决定自己实现 Task 而非调度 executor 时，它也跳过了 coordinator 的 `canContinue` → `agent_settled` follow-up 循环
- `agent_settled` hook 只在 `canContinue` 返回 true 且还有 runnable task 时注入 follow-up；不包含"所有 task 已完成但未验证"的强制触发路径
- Plan Runner 可以不调用 `plan_verify` 直接结束对话

## 促成因素

1. `plan_continue` 的 dispatch 参数不匹配导致模型放弃 DAG 调度
2. 模型 fallback 到直接实现后，coordinator 的状态跟踪断裂（task 仍为 pending）
3. `agent_settled` 检查 `canContinue` 时发现 tasks 仍 pending（coordinator 视角），发送了 follow-up
4. 但模型已进入"我已完成"心智模型，忽略 follow-up 直接输出 acceptance report
5. pi-subagents 接受了 acceptance report 并终止运行

## 修复方向

**Gate 必须是运行时不可绕过的退出前置条件，不能依赖模型主动调用。**

方案：在 Plan Session 的退出路径增加硬性检查——

1. **`session_shutdown` 或 acceptance 阶段**：如果 plan 已 open 且 `lifecycle !== "validated"`，阻止正常退出并注入强制 `plan_verify` 调用
2. **`agent_settled` 增加终态检查**：当所有 task 的 commit 已存在（HEAD != baseCommit）但 `lifecycle` 仍为 `running` 且无 pending attempt 时，强制注入 `plan_verify` follow-up
3. **Plan Runner 的 acceptance contract**：pi-subagents 的验收检查应调用 `createPlanCapsuleExtension.acceptanceVerify(status)`，只有 `lifecycle === "validated"` 才接受完成

三者中方案 3 最小侵入：已有 `acceptanceVerify` 函数，只是当前 plan-runner agent profile 使用 `acceptance: { level: "none" }`（由 Plan Capsule 管理验收）。但 pi-subagents 的 parent 侧最终接受了 plan-runner 的 attested report 而未检查 `validatedHead`。

## 防复发

- Gate 检查不得依赖 LLM 主动发起
- Plan Session 正常退出必须满足 `lifecycle ∈ { validated, blocked, cancelled }` 之一
- 如果 lifecycle 为 running 且 HEAD 有变化，session_shutdown 时自动触发 verify 或 block
- 这属于架构修复，不是 prompt 优化
