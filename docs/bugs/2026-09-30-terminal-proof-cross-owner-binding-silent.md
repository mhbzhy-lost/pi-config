# terminal-proof 跨 owner scope 未解析绑定被 not-applicable 静默吞没

- 日期：2026-09-30
- 级别：P2（可观测性缺口；workspace 可能无声滞留）
- 状态：已修复（用户裁决选项 (a)：生产修复，fail-closed 记债暴露）
- 裁决：用户 2026-09-30 选 (a)——跨 owner scope 的未解析绑定应记 debt 暴露，
  而非静默 not-applicable。

## 现象

`managed-workspace-terminal-proof-handoff.integration.mjs` 用例
`unresolved trusted run binding forms an observable proof debt`（基线就红、非 merge 引入）。
当 workspace 挂在 `root-owner` 会话名下、而 broker 跑在 `root-debt` 会话时，broker
观察到 child 终局后，outbox 恒空（`debts:{}`），既不投递也不记债。

## 根因（首个偏离点）

`classifyTerminalProofBinding`（terminal-proof-binding.ts）用
`client.listOwned({ runId })` 查 run 名下的 workspace，该查询与兜底 `readLedger`
**都按 broker 自己的 owner scope（rootSessionId）过滤**（subagent-runtime.ts:85,115-116）。
跨 owner 的 workspace 被过滤挡住 → `owned=[]` → 命中
`owned.length===0` 分支返回 `not-applicable`（"run owns no managed workspace"），
既不 enqueue 也不 recordDebt → 静默。

核心歧义：`listOwned` 返回空无法区分两种情形——
- (A) run 真的没有 managed workspace（generic / worktree:false run）→ not-applicable 正确；
- (B) run 有 workspace 但挂在别的 owner scope 下被挡住 → 未解析的可信绑定，属异常。
现状把 (A)(B) 都当 (A) 静默处理。

## 数据来源分类

**类别 1（production 可达的可观测性缺陷）**：broker 观察到自己授权会话 ≠ workspace
owner 会话的 run 终局是 production 可达场景；静默吞没与 broker「Failures are never
silent」原则冲突，workspace 会无声滞留在 active 且无 debt 标记、无东西触发对账。

## 修复（选项 a）

`classifyTerminalProofBinding` 新增 `readCrossScope` 依赖：scoped `listOwned` 返回空时，
跨所有 owner scope（`ledger.list()` 不按 scope 过滤）按 runId 复查；命中即判定 (B)，
`recordDebt("trusted run binding is unavailable")` fail-closed 暴露；复查也为空才维持
(A) not-applicable。subagent-runtime.ts 经 `createManagedWorkspaceLedger(...).list()`
接线该依赖。不放宽合法 not-applicable（真没有 workspace）的行为。

## 验收

- `unresolved trusted run binding ...` 用例 RED→GREEN：outbox 记 1 条 debt（reason 含
  "binding"）、workspace 保持 active、`inspectTerminalProofDelivery` 返回 "debt"。
- 整个 terminal-proof-handoff 文件 7/7 绿（其余投递/重放/debt 用例无回归）。
- 集成门禁解除该文件的 PENDING-ADJUDICATION 排除。
