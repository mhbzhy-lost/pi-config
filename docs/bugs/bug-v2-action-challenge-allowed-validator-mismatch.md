# bug：v2 workspace 的 preserve/release 路径不完整，issueDisposition 走 v1 inspectStatus 产生非法 actionChallenge

## 现象

对 v2 managed workspace（含 publish/apply policy）调用 `service.issueOwnedDisposition()` 发 disposition token 时，`issueDispositionForLease` 直接调 `inspectStatus`（v1 路径）而非 `statusForLease`（v2 分支）。`inspectStatus` 对 v2 record 走 v1 逻辑，但 v2 record 的 `record.request.writePaths` 是 undefined（v2 用 `policy.writePaths`），且 `inspectStatus` 产生的 `allowedDispositions` 是 v1 值（preserve/discard/integrate），写入 v2 record 的 `actionChallenge.allowed` 后，`validateRecordEnvelope` 对 v2 record 的 `RECORD_V2_KEYS` exactKeys 校验失败，抛 `MANAGED_WORKSPACE_SCHEMA`。

更深层：v2 workspace 的 preserve/release 没有完整的 issue 路径。`issueAction(preserve)` 也失败，因为 `statusV2ForLease` 的 `allowedActions` 只含 publish/apply/discard，不含 preserve/release。v2 的 preserve/release 链路断裂。

## Provenance

- 实际入口：`packages/pi-subagents-enhanced/src/workspace/service.ts` 的 `issueDispositionForLease()`，由 `issueOwnedDisposition()` 调用；E2E 走真实 v2 workspace 的 preserve/release 链路。
- 权威身份：v2 ledger record 的 `actionChallenge` 字段由 `validateActionChallenge` 校验；v2 record 与 v1 record 共用同一 `actionChallenge`/`pendingAction` 字段结构。
- 事件顺序：v2 ensureAllocated -> bindRun -> statusOwned -> issueOwnedDisposition（写 actionChallenge.allowed=publish/apply/discard）-> ledger mutate -> validateRecordEnvelope -> validateActionChallenge 拒绝 publish/apply。
- 首个偏离点：`issueDispositionForLease` 对 v2 record 直接调 `inspectStatus`（v1 路径）而非 `statusForLease`（v2 分支）；且 `statusV2ForLease` 的 `allowedActions` 不含 preserve/release，v2 没有完整的 preserve/release issue 路径。
- 数据来源分类：**production**。E2E 通过真实 service public API 对 v2 workspace 发 disposition token，是 production 可达路径，不依赖手工 projection 或 mock。

## 影响

v2 workspace 无法经 issueDisposition 发 token，preserve/release 链路断裂；standalone executor coding 完成后的 workspace 处置闭环不完整。

## RED 证据

`test/subagent-delegation-workspace.e2e.mjs` 的 “standalone executor coding contract reaches shared execution and allocates a v2 workspace” 在 issueOwnedDisposition 处抛 `MANAGED_WORKSPACE_SCHEMA`，准确暴露 v2 actionChallenge.allowed 与 ledger validator 的集合不一致。

## 修复方向

让 `issueDispositionForLease` 对 v2 record 走 `statusForLease`（v2 分支）而非 `inspectStatus`，使 allowedDispositions 用 v2 值；并在 `statusV2ForLease` 的 `allowedActions` 纳入 preserve/release，使 v2 有完整的 preserve/release issue 路径。同时 `validateActionChallenge` 的 allowed 集合纳入 v2 action 值（publish/apply/release）。保持 v1 record 的 bytes/hash/mutation/disposition 语义不变。
