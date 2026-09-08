# Goal orphan inspector attempt receipt 映射

## 根因

生产入口为 `goal_integrate` 的 pending task，经由
`createGoalManagedWorkspaceInspector`、public `inventoryManagedWorkspaces`、
`workspaceService.status` 到 verified receipt，随后产生
`task.workspace_orphan_recovered`。public receipt 的唯一权威 attempt 位于
`receipt.owner.attempt`；receipt 顶层没有 `attempt`。

`src/goal-engine/managed-workspace.ts` 原先只 spread `snapshot.receipt` 并映射
`branch`，使 inspector 的 verified `lease.attempt` 为 `undefined`。后续
`events.validateRecoveryWorkspace` 因 workspace attempt mismatch 拒绝合法的
orphan recovery。这是 production 可达的数据映射缺失，不是 fixture 污染。

## 修复与验证

新增真实服务测试，以 `owner.kind = "goal-task"`、`owner.attempt = 1` 通过
public `ensureAllocated`、`status` 与 `inventory` 创建并检查 workspace。修复前
RED 为 inspector lease 的 `attempt` 是 `undefined`；修复后 GREEN：lease 顶层
`attempt === 1`，且 `branch === branchRef`（branchRef 来自真实 public receipt），
身份、资源与 executor head 事实保持完整。

生产修复仅将 `snapshot.receipt.owner.attempt` 显式映射到 inspector lease 顶层，
未修改 public receipt schema、reducer 或 package API。

## 非本次范围

focused `orphan durable recovery append failures retry without duplicate recovery`
在 retry 阶段仍报 `GIT_INFRASTRUCTURE_ERROR: observed=workspace snapshot mismatch
for task t1`。这是后续 snapshot mismatch gap，不扩展本次单字段映射修复。
