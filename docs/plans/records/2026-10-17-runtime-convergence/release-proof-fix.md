# T23：H2——收紧 bound workspace release 的终态证明

## 修复

`packages/pi-subagents-enhanced/src/workspace/service.ts`：

- bound release 不再走 `challenge.used` 的 legacy shortcut；先执行同一 `resolveProof`，校验 observed proof 与 run/root/asyncDir 身份后才放行。
- `preserve` 也持久化已观察 proof，使后续 release 能基于同一事实证明，而不是基于“曾经处置过”。
- unbound orphan 的合法出口保留；owner/proof 未知时 fail closed。

## 证据

- focused 组合（ledger/service/integration-queue/operation-tools/wire）69/69 exit 0，见 `current-validation.md`。
- **现场证据（本轮真实调用）：** 对 `a8f3cdf0-…` 执行 `managed_workspace_release` 返回 `MANAGED_WORKSPACE_TERMINAL: release requires an observed terminal proof`。该 workspace 的 child run 无 observed proof，因此拒绝是门禁生效，不是缺陷；未伪造 proof、未 raw 删除。
- 首次 H2 断言失败已分类为测试合同错误（无 observed proof 的 bound release 被拒后，状态应为 preserved/allowed release），只修断言，未放宽生产门禁。

## 边界

未做真实删除事故重演，也未验证所有 orphan/跨 owner 拓扑；`git-worktree.ts` 的 `inspectManagedNoPayload` 只用于无 payload 事实判定，不作为 proof 替代。
