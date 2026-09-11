# Goal managed disposition 事件缺口

## 先前错误证据（分类 2，已纠正）

上一批 focused reducer test 的 `activeProjection()` 直接执行 `projection.tasks.get("t1").status = "succeeded"`。这是绕过事件 reducer 的测试制造数据，属于分类 2；它不能证明 production RED/GREEN，现已删除。替代测试用合法 `goal.created → task.dispatch_requested → task.workspace_allocated → task.executor_bound → task.settled(succeeded)` 链，包含 strict binding、terminal proof 及 dual-path settlement evidence。

## Provenance（分类 1，production 可达）

合法入口是 `goal_dispatch` 的 public coordinator 分配并绑定 `managed-workspace.v1` receipt，随后 `goal_settle succeeded`，最后 `goal_integrate integrate`。资源唯一权威是 unified managed-workspace service；Goal event projection 是任务业务事实权威。

原有首个偏离在 `src/goal-engine/extension.ts` 的 unified receipt 分支：它只写 Pi metadata 后直接调用 `service.dispose()` 并返回。service 已经 durable `released/integrate` receipt，但 Goal JSONL 没有对应 disposition fact，projection 仍保留 active receipt；因此 `goal_accept` 拒绝。这不是 fixture 污染或来源未证实，而是正常 planned.v1 入口可达的分类 1 缺陷。

顺序原为：dispatch request → coordinator allocation/bind public receipt → executor bind → settle terminal proof/evidence → service dispose/integrate/release → metadata；首个偏离是 service durable side effect 后未 append Goal receipt。正确顺序为：Goal disposition intent（完整 `rootSessionId/goalId/taskId/attempt/executionRevision` owner、workspaceId、leaseId、action/strategy）→ service durable disposition receipt → Goal receipt fact（workspaceId、leaseId、serviceReceiptHash、严格 public receipt）。

## RED / GREEN

RED：`test/goal-engine-managed-disposition.integration.mjs` 证明 active unified receipt 没有 Goal receipt fact 时 `task.accepted` 被拒绝。

GREEN：同一测试证明 strict intent 后仅接受 hash 匹配的 released/integrate public receipt，并在 `goal_accept` 前验证 completed Goal receipt fact、attempt、完整 owner、action、state 和 disposition。新 reducer payload 精确判别且新旧 payload 混搭 fail closed；旧 `task.workspace_disposition_started/applied/disposed` replay 路径未改动。

## 剩余边界

该补丁不修改 public managed-workspace receipt 或 service API，也不引入 legacy Git/leasePath/`ge/*` fallback。由于 service 的 `issueDisposition` action token 本身是 durable mutation，Goal intent durable 后的 retry 重新取得 token；service 已 terminal 而 Goal receipt 尚未 append 时只补 receipt。完整 extension suite 当前含前序 dirty migration 失败，需在该基线收敛后复验所有 fault-injection cases。
