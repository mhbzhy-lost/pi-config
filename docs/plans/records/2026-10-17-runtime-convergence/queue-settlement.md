# T25B：queue settlement、receipt 与 handoff 关闭

## 实现

- 新增 `packages/pi-subagents-enhanced/src/workspace/disposition-settlement.ts`：`createWorkspaceDispositionSettlement({ workspaceService, integrationQueue, fault })`，提供 `settlePrepared` 与 replay。
- 扫描 workspace-only prepare、补建 coordinator intent、核对不可变字段，重放不再索要新 token。
- `integration-queue.ts` 新增 `recordDispositionIntent`、`advanceDispositionIntent`、`listDispositionIntents`、`verifyDispositionBinding`、`settleDispositionQueue`：严格意图与阶段校验，绑定/revision/admission 一致才结算，queue terminal、handoff、receipt 幂等补齐。
- `git-worktree.ts` 新增 `inspectManagedNoPayload`：clean、HEAD == `request.baseCommit`、descendant、`aheadCount == 0`、无 sequencer/integration intent/receipt 时才判定无 payload。

## 证据与状态

- typecheck exit 0；既有 queue restart 6/6、queue crash 6/6、proof recovery 12/12 通过，但它们覆盖的是发布状态机与 coordinator 生命周期恢复，**不是**新 disposition settlement。
- 状态 **local-fix-ready**：故障窗口 `after-coordinator-intent`（`disposition-settlement.ts:23`）、`after-queue-settlement`（`:28`）、`before-settlement-receipt`（`:29`）、`after-settlement-receipt`（`:31`）零行为覆盖；`test/**` 无文件引用上述新 API。见 `settlement-window-audit.md`。

## 边界

无 payload 判定不授权空提交；不回收空提交、不 force/raw merge、不删除 ledger。新增验证需明确授权。
