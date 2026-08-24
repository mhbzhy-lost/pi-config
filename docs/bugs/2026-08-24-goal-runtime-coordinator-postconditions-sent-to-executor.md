# goal-runtime 协调器后置条件被送入 Executor

## 问题

合法的 public typed `goal_init` 可提交 `goal-runtime.v1` task，其 `acceptance.criteria` 原先只有 `id`、`statement`、`evidenceKinds` 三字段。调用链为：`goal_init` 的 `normalizeRuntimeGoalInit` → `goal.runtime_drafted` 权威 projection → `goal_status` → `goal_dispatch` → `compileTaskContract` → typed subagent spawn。旧 `compileTaskContract` 无差别将全部 criterion 映射进 `requirements` 与 `acceptance.criteria`。

真实 production run `77c124bb-d889-4752-ba51-ca8b6610d731` 的 binding（`runId`、attempt、contractHash、workspace）与 Root broker 工件一致，因此这不是伪造输入或仅测试可达路径。

## 权威事实顺序与首个偏离

权威 lifecycle 顺序是 `task.dispatched` → `task.executor_bound` → child terminal proof → `task.settled` → workspace integrate/release → `task.accepted`。terminal proof 只能在 child 退出后取得；workspace integrate/release 要求 succeeded settlement；accepted 要求 workspace 已 disposed/released。

把 `executor-terminal-proof`、`workspace-integrated-released`、`task-accepted` 当 child exit acceptance 会形成时间环。首个偏离点是 Goal criterion 模型没有 evaluator/predicate 边界，以及 dispatch 编译边界把所有 criterion 送给 Executor。分类为第 1 类：**合法生产 typed 数据在模型/编译边界被错误路由**。

## RED 证据

新增 public-boundary 测试先以显式 `evaluator: "coordinator"` 和 `predicate: "workspace-integrated-released"` 运行；旧实现拒绝新增字段（`must contain exactly id, statement, evidenceKinds`），证明无法表达边界。修复后同一测试证明 projection 保留两个 criterion，而 exact `dispatch-ir.v1` 仅有一个 executor criterion，且 requirements 不含 coordinator criterion。

## planned.v1 public schema 回归与入口证据

`goal_init.tasks`、`goal_amend.patch_active.add_tasks` 及其 `update_tasks` 都是 planned.v1 的 public typed 入口；它们必须继续只公开 `id`、`statement`、`evidenceKinds`。中断现场的 RED 位于 `test/goal-engine-extension.integration.mjs:865`：该断言读取这些入口的 criterion schema 时得到共享 runtime `anyOf`，因此 `required` 不存在。这个首个偏离点发生在 `extension.mjs` 的单一 `criterionSchema` 被同时接到 `taskSchema`、`updateTaskSchema` 与 `executionChangeTaskSchema`，并非网络/provider 中断。

修复将 planned 与 runtime schema 分开：planned 三个入口保持 exact-three；只有 `goal_amend.propose_execution_change.changes.update_tasks` 使用 runtime `anyOf`。运行时 fresh 入口仍由 `normalizeRuntimeGoalInit` 的 `runtimeAcceptance` validator 审核；执行 amendment 的事件入口 `goal.amended` 也按 `goal-runtime.v1` 选择同一 validator。该事件证据防止 proposal 已通过 public schema、但持久化 candidate 又被 planned validator 拒绝。四个 coordinator predicate 是枚举的 typed authority，不从 criterion 文本推断。

## runtime succeeded settlement provenance（第 1 类 production 缺陷）

权威身份与事件顺序为：`goal.runtime_drafted(goal-runtime.v1)` 的 exact task contract → `goal_dispatch` 的 workspace/attempt/contractHash → `task.executor_bound` 的 Root Broker `runId` → Root Broker succeeded terminal proof → clean executor HEAD → `goal_settle` → `task.settled`。在这个合法链路中，extension 已验证 exact binding、official Root broker proof 和 clean commit；child artifact 与 main verification 也以相同 `{goalId, taskId, runId, attempt, contractHash, head}` 生成 executor-only dual-path evidence。

首个偏离点在 `extension.mjs`：evidence 注入和 event payload 缩减仅以 `planned.v1` 分支执行。`goal-runtime.v1` 与 planned 同具 `settlement: dual-path` capability，但它的 `task.settled` reducer 强制 `settlementEvidence`，所以合法 runtime payload 在 extension→reducer 边界丢失证明后被拒绝。分类为第 1 类：**合法 production typed 数据未被正确处理**。修复按 generation capability 为两代复用同一严格 injection 路径，并只将 `executorCriteria` 送入 evidence；legacy settlement 语义不变。

## superseded coordinator applicability replay（第 1 类 production 缺陷）

权威 replay 顺序为：runtime task 带枚举 coordinator predicate → 后续权威 amendment/repair 将 `taskApplicability` 标为 `superseded` → finalization 从 projection 构造 manifest → `deriveBlockers`。superseded 是既有的“不再适用”状态：它应在 task-level finalization gate 前退出，而不是要求已被替代任务再满足 binding、terminal proof、workspace 或 accepted predicate。

首个偏离点是 `deriveBlockers` 在检查 `applicability === "superseded"` 前先枚举 `coordinatorCriteria`，因未满足 predicate 添加 `TASK_COORDINATOR_PREDICATE_UNSATISFIED`。这会让权威 superseded task 错误阻断 finalization。修复把 superseded early return 移到全部 task blocker 求值之前；`applicable` 与 `reverify_required` 仍机械求值 coordinator predicate，未削弱 accepted task 的 gate。分类为第 1 类：**合法 production typed 状态未被正确处理**。
