# goal-runtime.v1 suspension stop authority 分类错误

## 现象

`test/root-subagent-broker-r10b-suspension.integration.mjs` 在加载时导入了已重命名的 `deriveOwnedExecutorStopRequest`，而当前公开入口只导出 `deriveOwnedRunStopRequest`。更名后测试没有同步，因此 Node 在执行测试前报 missing named export。

同步到公开入口后的精确 RED 显示，合法的 `goal-runtime.v1` 事件链也被拒绝为 `durable executor acceptance authority is invalid`。

## 生产可达证据

- 入口：`normalizeRuntimeGoalInit(runtimeInit(), runtimeRegistries)` 接受 `goal-runtime.v1` 的三字段 criterion；该公开 runtime contract 将无 `evaluator` 的 criterion 视为 executor-owned。
- 权威身份：`goal.runtime_drafted`、`goal.session_bound`、ready/approval/observation/activation、`task.dispatched` 和 `task.executor_bound` 均经 `appendEvent` 持久化后由 `loadProjection` 重载；session、base head、lease、workspace 与 run binding 完整且一致。
- 事件与资源顺序：先完成 runtime activation，再 dispatch，最后绑定 executor；`deriveOwnedRunStopRequest` 从该持久 projection 生成 Root Broker stop authority。
- 首个偏离点：`deriveOwnedRunStopRequest` 在 `goal-runtime.v1` projection 上无条件使用 `runCriteria`。v1 的合法 criterion 没有 `evaluator: "run"`，所以 expected criteria 为空并在 authority gate 首先失败。

## 根因与修复

`dff0da9` 将函数改名并迁移为 run binding 时，把所有 generation 都切到 `runCriteria`；但 legacy `goal-runtime.v1` 仍是合法公开 runtime 输入，必须使用其 executor-owned criteria。最小修复按 `isLegacyExecutorGeneration(projection.eventSchemaVersion)` 选择 `executorCriteria`，其余 generation 保持 `runCriteria`。测试同时改为当前公开函数名、`agentProfile` authority 和 `inspectExecutionProof`；旧的 fresh-Broker/status-sidecar recovery 断言直接手工制造已废弃 artifact，当前 Broker 明确 fail closed，故删除。
