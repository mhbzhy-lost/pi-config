# D-INTERFACE-DESIGN：proof debt 安全处置接口契约

## 0. 范围、证据与 TDD 豁免

本节点是只读接口设计，不实现接口，不调用 `applyManagedWorkspaceCleanup`，不写入 production、测试或 live state。报告消费：

- `D-PROVENANCE.md`：冻结快照中的 529 条 debt 全部属于来源未证实，**可证明的清理候选集合为 0**；缺失 record、queue 或 session 叙述不能反推无 workspace。
- `D-CLEANUP.md`：当前结论为 `blocked-no-safe-public-exit`；既有 cleanup fixture 仅证明授权 workspace release 的边界，且独立 audit projection 的断言为 RED。
- 统一 DAG 的 D-INTERFACE-DESIGN 节点：要求单项契约、durable audit、幂等和中断恢复，不把多 action release 伪装成事务。
- 源码：`packages/pi-subagents-enhanced/src/workspace/administration.ts`、`contract.ts`、`service.ts`，以及 `src/subagent-dispatch/coordinator-proof-outbox.ts`、`terminal-proof-binding.ts`；现有 package export 为 `./workspace/admin`，没有 proof-debt administration export。

本任务属于 test-driven-development Skill 明确豁免的**纯文档变更**：没有 production、configuration 或 test 行为变更，故不存在可先写 RED 再实现 GREEN 的代码目标。下文的 fixture 矩阵是后续 coding 任务的 RED/GREEN 规格，本节点不运行生产 mutation，也不伪造 GREEN。

报告中的值均为占位符或摘要形式：不记录任何 token、runId、proofId、cookie、owner secret 或授权值。代码契约可以使用字段名，但示例值使用 `<...>` 或 `<64-hex-digest>`。

## 1. 边界：proof debt 不是 workspace release

### 1.1 两个不同的事实与副作用

**proof debt** 是 terminal proof 未能完成“官方终态 → root owner → workspace binding → coordinator queue/receipt”的结算记录。它的最小权威身份是 outbox 中的 proof digest、来源 run 的摘要、原因和观察时间；现有 `recordDebt` 不携带可反推完整身份链的 owner receipt、workspace receipt 或官方 terminal 原文。proof debt 处置的副作用只能是：

1. 将一个、且仅一个 debt 与已验证的官方事实绑定并置为 `delivered`；
2. 以已验证的 active resume intent 使旧 proof 置为 `superseded`；
3. 在满足独立人工政策和不可恢复证据时置为 `abandoned`；或
4. 在证据不足时持久记录 `blocked-unknown`，保留 debt，不声称清理。

**workspace release** 是 Git worktree、ledger lease 和 workspace lifecycle 的资源释放。当前 `applyManagedWorkspaceCleanup` 在 `administration.ts` 中：校验整个 plan 的 hash 和当前 action 列表，按 `plan.actions` 顺序逐个 `issueRelease`/`release`，返回 release receipt。它不是 proof-debt 处置：没有 proof-debt 专用幂等键，没有 durable cleanup audit projection，也没有跨多个 action 的事务、回滚或可恢复阶段。即使 proof debt 已经 `delivered`，workspace release 仍必须经过另一个、独立授权的 workspace release API；proof-debt API **不得隐式 release、删除 worktree、消费 lease 或修改 workspace state**。

### 1.2 单 debt 状态词表与目标

建议建立独立于 workspace ledger 的 `proof-debt-disposition.v1` projection：

| 状态 | 含义 | 是否终态 | 允许的后续动作 |
|---|---|---:|---|
| `unresolved` | debt 存在但尚未有处置意图 | 否 | 发起单项处置或记录 blocked |
| `intent-recorded` | 处置意图及幂等请求已 durable 写入，尚未确认执行 | 否 | 恢复/继续同一请求 |
| `executing` | 外部权威 effect 正在执行或结果尚未被观察 | 否 | 仅按幂等键恢复，不得创建第二个 effect |
| `retryable-failure` | 没有确认外部 effect 成功，可安全按原请求重试 | 否 | 相同请求摘要的恢复 |
| `delivered` | 官方 terminal proof 已与唯一 owner/workspace/queue receipt 结算 | 是 | 只读；后续 release 另行授权 |
| `superseded` | 官方 resume intent 已验证，旧 proof 被新 run 替代 | 是 | 只读；不得重新 enqueue 或记 debt |
| `abandoned` | 依据独立人工批准及不可恢复证据放弃该 debt | 是 | 只读；不得伪装为 delivered |
| `blocked-unknown` | 身份链、资源事实或事件来源仍未知，fail closed 保留 | 是（可复核） | 只能由新证据发起新的复核意图 |
| `execution-unknown` | 崩溃点位于外部 effect 之后、结果审计之前，不能判断是否成功 | 否 | 先查询权威 effect；查询失败仍保持 unknown/block，不盲重试 |

不可处置状态/情形：

- 已为 `delivered`、`superseded` 或 `abandoned` 的 debt 不得改变目标状态、重复 delivery 或回收其历史 audit；
- 没有可核验的 owner receipt、lease、官方 terminal/event provenance、workspace binding 或 queue/receipt 顺序时，不得执行 `deliver`、`supersede` 或任何资源删除；只能 `blocked-unknown`；
- 多 owner/multi-binding、owner scope 不一致、terminal proof 与绑定 run/时间/async 事实不一致、stale revision、未知 schema、跨 partition 或 coordinator 身份不一致时，不得猜测选择；
- `pending`、`retryable-failure` 和 `execution-unknown` 不是成功目标，不能用“已调用”或“文件存在”替代成功 receipt；
- 处置接口不得接受“仅有 proof digest + reason”作为足够的生产清理证据。D-PROVENANCE 的 529 条（P1 188、P2 110、P3 130、P4 101）当前全部落入 `blocked-unknown` 候选，未转移任何一条。

## 2. Public/typed API 契约草案

以下是后续实现必须冻结并由 package 的公开入口导出的最小形状。类型名是契约名，不表示本节点已实现。

### 2.1 不向调用者返回秘密的公共类型

```ts
type Digest64 = string; // 仅允许 /^[a-f0-9]{64}$/，示例：<64-hex-digest>
type Revision = number; // positive safe integer

type ProofDebtKey = {
  schemaVersion: "proof-debt-key.v1";
  proofDigest: Digest64;
};

type OwnerScope = {
  kind: "standalone-subagent" | "goal-task" | "goal-validation";
  rootSessionId: string; // 只在 typed 内部校验；报告/receipt 不回显实际值
  ownerDigest: Digest64;
};

type LeaseBinding = {
  workspaceId: string;
  leaseId: string;
  ownerScope: OwnerScope;
  expectedWorkspaceRevision: Revision;
  expectedRunDigest: Digest64;
};

type ProvenanceBinding = {
  ownerReceiptDigest: Digest64;
  workspaceReceiptDigest: Digest64;
  terminalProofDigest: Digest64;
  eventChainDigest: Digest64;
  observedAt: string;
  source: "authoritative-terminal" | "active-resume-intent" | "operator-review";
};

type ProofDebtDispositionRequest = {
  schemaVersion: "proof-debt-disposition-request.v1";
  debt: ProofDebtKey;
  action: "deliver" | "supersede" | "abandon" | "block-unknown";
  binding: LeaseBinding;
  expectedDebtRevision: Revision;
  idempotencyKey: string; // 绑定调用方域；示例：<idempotency-key>
  requestDigest: Digest64; // 对规范化请求计算，防止同 key 换 payload
  provenance: ProvenanceBinding;
  reasonCode: string;
};
```

约束：`workspaceId`、`leaseId`、`rootSessionId`、run 身份和 token 可以作为代码字段存在，但不得出现在面向报告、普通管理输出或错误消息的明文中；外部可见 audit 只能返回其 digest/受控引用。`rootSessionId`、owner scope、lease 与 run 必须从 Host/AuthorityStore、workspace ledger 和 coordinator 的权威查询得到，不能由调用者任意拼装成“证明”。`expectedWorkspaceRevision` 与 `expectedDebtRevision` 是 compare-and-set 门，不是提示字段。

### 2.2 分离读取、预检与单项写入

建议公开三个 typed 入口，均只处理一个 debt：

```ts
getProofDebtStatus(input: {
  schemaVersion: "proof-debt-status-request.v1";
  debt: ProofDebtKey;
}): Promise<ProofDebtStatus>;

prepareProofDebtDisposition(input: ProofDebtDispositionRequest): Promise<{
  schemaVersion: "proof-debt-intent.v1";
  intentDigest: Digest64;
  debt: ProofDebtKey;
  requestDigest: Digest64;
  expectedDebtRevision: Revision;
  state: "intent-recorded";
  auditIdDigest: Digest64;
}>;

applyProofDebtDisposition(input: ProofDebtDispositionRequest): Promise<ProofDebtOutcome>;
```

`prepare` 和 `apply` 都必须在同一 durable projection 上执行 revision/key 检查；`apply` 不得把客户端预检当成授权。若 `prepare` 已成功而进程退出，恢复器只使用已记录的 intent，不能要求调用方换一个 key 规避恢复。

`ProofDebtStatus`：

```ts
type ProofDebtStatus = {
  schemaVersion: "proof-debt-status.v1";
  debt: ProofDebtKey;
  state: "unresolved" | "intent-recorded" | "executing" | "retryable-failure"
       | "delivered" | "superseded" | "abandoned" | "blocked-unknown" | "execution-unknown";
  debtRevision: Revision;
  activeAuditIdDigest: Digest64 | null;
  outcomeDigest: Digest64 | null;
};
```

### 2.3 授权绑定与动作前置条件

- `deliver`：必须有官方终态 proof、单一 owner/workspace binding、精确 lease、expected revision、queue admission/receipt 顺序和 terminal→owner→workspace→queue 的 event chain；成功只结算 proof debt，不 release workspace。
- `supersede`：必须有同一 owner scope 下已激活且未过期的 resume intent，source proof/run 与 resumed run 的权威关联，且 source proof 尚未 delivered/abandoned。新的 run 绑定和 supersession 必须由 coordinator/AuthorityStore 验证；不能仅凭两个字符串相似或时间相邻。
- `abandon`：必须是独立的、可审计的人工 disposition policy；需记录批准者的受控 authorization digest、不可恢复理由和复核依据。它不能由“查不到 workspace”自动触发，不能删除 terminal proof/outbox 或 worktree。
- `block-unknown`：允许在 provenance 未证实时安全封存；需要记录缺失事实集合和 revision，但不得写成“cleaned/delivered”。对于 D-PROVENANCE 的历史集合，当前唯一允许的自动结论是此状态。

**返回成功：**

```ts
type ProofDebtOutcome = {
  schemaVersion: "proof-debt-outcome.v1";
  debt: ProofDebtKey;
  state: "delivered" | "superseded" | "abandoned" | "blocked-unknown";
  debtRevision: Revision;
  idempotencyKeyDigest: Digest64;
  auditIdDigest: Digest64;
  effectDigest: Digest64 | null;
};
```

**错误：** 实现应使用稳定的 typed code，而非拼接身份值：

```ts
type ProofDebtErrorCode =
  | "PROOF_DEBT_NOT_FOUND"
  | "PROOF_DEBT_STATE_CONFLICT"
  | "PROOF_DEBT_OWNER_UNVERIFIED"
  | "PROOF_DEBT_LEASE_UNVERIFIED"
  | "PROOF_DEBT_PROVENANCE_UNVERIFIED"
  | "PROOF_DEBT_STALE_REVISION"
  | "PROOF_DEBT_IDEMPOTENCY_CONFLICT"
  | "PROOF_DEBT_AUDIT_UNAVAILABLE"
  | "PROOF_DEBT_COORDINATOR_UNAVAILABLE"
  | "PROOF_DEBT_EXTERNAL_OUTCOME_UNKNOWN";

type ProofDebtError = {
  schemaVersion: "proof-debt-error.v1";
  code: ProofDebtErrorCode;
  debtRevision: Revision | null;
  auditIdDigest: Digest64 | null;
  retryable: boolean;
};
```

错误消息不得包含 token、原始 run/proof 身份、绝对敏感路径或授权值；错误只给稳定 code、是否可重试和摘要 digest。

## 3. Durable-audit-first、中断恢复与原子边界

### 3.1 审计记录

审计记录必须与 proof-debt projection 位于同一可 fsync 的 durable store，采用临时文件 + fsync + atomic rename 或等价的事务提交；不能只写内存、日志或 TUI 输出。

```ts
type ProofDebtAuditRecord = {
  schemaVersion: "proof-debt-audit.v1";
  auditIdDigest: Digest64;
  debt: ProofDebtKey;
  action: "deliver" | "supersede" | "abandon" | "block-unknown";
  idempotencyKeyDigest: Digest64;
  requestDigest: Digest64;
  expectedDebtRevision: Revision;
  observedDebtRevision: Revision | null;
  binding: {
    workspaceIdDigest: Digest64;
    leaseIdDigest: Digest64;
    ownerDigest: Digest64;
    expectedWorkspaceRevision: Revision;
  };
  provenance: {
    ownerReceiptDigest: Digest64 | null;
    workspaceReceiptDigest: Digest64 | null;
    terminalProofDigest: Digest64 | null;
    eventChainDigest: Digest64 | null;
  };
  phase: "intent-recorded" | "executing" | "succeeded" | "failed" | "outcome-unknown";
  outcomeState: "delivered" | "superseded" | "abandoned" | "blocked-unknown" | null;
  errorCode: ProofDebtErrorCode | null;
  createdAt: string;
  updatedAt: string;
};
```

Audit 对外返回 `auditIdDigest` 和 `phase/outcomeState`，不返回秘密。每一个阶段转换都必须带前一 revision，拒绝倒退；相同 idempotency key 只允许相同 `requestDigest`。

### 3.2 状态机

```text
unresolved
  └─(audit durable + CAS)→ intent-recorded
       └─(恢复器/执行器认领)→ executing
            ├─(权威 receipt 已确认 + audit commit)→ delivered/superseded/abandoned
            ├─(无外部 effect 且可安全重试 + audit commit)→ retryable-failure
            └─(effect 可能已发生但 receipt 不可见)→ execution-unknown

unresolved ──(证据不足且仅做安全封存)──→ blocked-unknown
blocked-unknown ──(新权威证据，新的 revision/key)──→ unresolved/intent-recorded
```

- **先审计后执行：** 先以 CAS 写入 `intent-recorded`，再调用 coordinator 或 proof outbox；audit 写失败时绝不触发外部 effect。
- **审计后、执行前中断：** 重启扫描 `intent-recorded`，重新验证 owner/lease/revision；未过期则用原 key 执行，过期或事实变化则转 `retryable-failure`/`blocked-unknown`，不新建第二意图。
- **执行后、回执前中断：** 重启先按相同 idempotency key/effect digest 查询权威 coordinator/outbox/receipt。确认成功才提交目标状态；查不到且不能证明未执行时保持 `execution-unknown`，禁止盲重试、重复 release 或把它标成 delivered。
- **coordinator 不可用：** audit intent 保留，状态为 `retryable-failure`（若尚未发生 effect）或 `execution-unknown`（若发生点不明）；不得清除 debt。

**单 action 原子边界：** 单项 projection 的“意图/阶段/结果 audit + debt revision”必须原子提交；外部 coordinator、workspace ledger、Git worktree 与本地 audit 之间没有跨系统事务。因而不能声称全链路原子。一个请求只能处置一个 debt、一个目标状态和一个 effect。多 action 必须由上层拆成多个独立调用，每项独立 key、revision、audit 和 outcome；一项失败不得回滚已经成功的项，也不得为批量调用提供“伪原子 rollback”。

## 4. Fail-closed 规则

| 条件 | 必须行为 | 禁止行为 |
|---|---|---|
| owner 缺失/不匹配 | `PROOF_DEBT_OWNER_UNVERIFIED`，保留 debt；可另行记录 `blocked-unknown` | 用 session 文本、提示词、facade event 或调用者自报 owner 代替 receipt |
| lease 缺失、过期或 scope 不同 | `PROOF_DEBT_LEASE_UNVERIFIED`，不调用外部 effect | 仅凭 workspaceId/path/旧 lease 或 management plan 放行 |
| terminal/event provenance 缺失、多个 binding 或顺序不明 | `PROOF_DEBT_PROVENANCE_UNVERIFIED`，只能 blocked | 把 reason、时间相近、无 record/queue 解释成合法清理证据 |
| stale debt/workspace revision | `PROOF_DEBT_STALE_REVISION`，不改变 projection；重新读取后必须新 key | 覆盖写、自动采用 latest、重用旧 intent |
| 相同 key + 相同 requestDigest | 返回原 audit/outcome（幂等重放），不生成第二 effect | 重复 coordinator delivery/release |
| 相同 key + 不同 requestDigest | `PROOF_DEBT_IDEMPOTENCY_CONFLICT`，永久拒绝该 key | 以后来的 payload 覆盖原请求 |
| audit 写入失败 | `PROOF_DEBT_AUDIT_UNAVAILABLE`；不执行外部 mutation，原 debt 保留 | 先调用 coordinator、只靠 stdout/log 记录 |
| coordinator 不可用 | 保留 intent 与 debt，标记 retryable/unknown；不宣称成功 | 删除 pending、标 delivered、隐式 release workspace |
| 目标已是 delivered/superseded/abandoned | 只读原 outcome；新动作报状态冲突 | 反向转换、重新 enqueue、清理历史 audit |

## 5. 临时 fixture 的 TDD RED/GREEN 验收矩阵

这些用例只定义未来实现的安全门；fixture 必须创建临时 origin/state/coordinator，所有写入限制在临时目录，测试结束清理。不得使用历史 529 条或 live workspace 作为 fixture，也不得手工 append 伪造 production debt。

| fixture 场景 | 首次 RED（接口未实现/当前 API 不满足） | 目标 GREEN（接口实现后） |
|---|---|---|
| 错 owner scope | 期望 typed owner error，当前 administration 无 proof-debt API | 不写外部 effect；audit 可记录拒绝或安全 blocked，返回 `PROOF_DEBT_OWNER_UNVERIFIED` |
| 错 lease / lease revision | 期望 lease error，当前 `applyManagedWorkspaceCleanup` 只验证 workspace release authorization | CAS 拒绝且 debt revision 不变，无 workspace mutation |
| stale debt/workspace revision | 期望 stale error | 只返回 conflict；新读取并使用新 key 才可重试 |
| 重复 key、相同 payload | 期望既有 outcome，当前 outbox 只有 proof key 去重，非 disposition key | 返回同一 audit/outcome digest，外部 effect 次数为 1 |
| 重复 key、不同 payload | 期望 idempotency conflict | 永久拒绝冲突请求，不改变原 audit |
| audit 写失败 | 期望独立 audit projection 存在但当前 D-CLEANUP fixture 已以 undefined 断言 RED | coordinator 调用次数为 0，debt 保持 unresolved |
| audit 后、执行前崩溃 | 当前无 intent/recovery state | 重启沿用原 key 恢复或安全 retryable，不产生第二 effect |
| 执行后、回执前崩溃 | 当前无 outcome-unknown 状态 | 查询权威 receipt；无法判定时保持 unknown/block，禁止盲重试 |
| coordinator 不可用 | 当前 outbox replay 只能保留 pending，不能表达 cleanup intent | audit intent 保留，返回 retryable/unknown，不标成功 |
| 合法 `deliver` | 当前 `recordTerminalProof` 是 workspace service 行为，不是单 debt disposition contract | 仅以完整 provenance 结算 `delivered`，workspace release 仍未发生 |
| 合法 `supersede` | 需证明现有 supersession 不能替代统一 disposition audit | 同一 source/resume 事实幂等为 `superseded`，迟到旧 proof 不可重入队 |
| `abandon` 人工批准 | 当前没有独立 abandon policy/审计入口 | 只有受控批准和不可恢复证据允许；不删除资源 |
| 缺 provenance 的 529 debt | 当前不能将历史数据安全归因 | 所有项保持 `blocked-unknown`，计数仍是历史快照，不启动 mutation |
| 批量请求含两个 debt | 当前 apply 可顺序处理多个 workspace action | 新接口拒绝批量 shape；调用方拆成两个独立 key/audit/outcome，第一项成功不回滚 |

后续 coding 任务必须先为每个新增行为建立正确 RED，再最小实现至 GREEN；本报告没有运行上述 RED/GREEN，也没有生产 mutation。

## 6. 与现有 administration API 的精确差异与 WritePaths

### 6.1 现有能力为何不能直接实现

`administration.ts` 当前公开：

- `inventoryManagedWorkspaces`：读取 ledger/Git inventory，并报告 workspace、queue、recovery/resume intent 和一般 debt；不是 proof-debt action journal。
- `auditManagedWorkspaces`：只读 operational view；已有 coordinator/queue 分类，但没有本契约的 debt disposition projection。
- `planManagedWorkspaceCleanup`：按 workspace state/identity 生成整个 release action plan，并以 `planHash` 绑定。
- `applyManagedWorkspaceCleanup`：校验 plan/state root/current actions/lease authorization，然后按顺序调用 workspace service 的 `issueRelease` 和 `release`；返回 release receipts。

`workspace/contract.ts` 验证 workspace request、owner、policy 和路径语法，但没有 proof-debt disposition request、expected debt revision 或专用 idempotency key。`coordinator-proof-outbox.ts` 的 `enqueue/recordDebt/replay/receipt/status` 能持久 pending、receipt、debt 和 supersession，却没有 disposition audit record、owner/lease CAS、阶段状态、执行后未知状态或 cleanup 专用 key。`terminal-proof-binding.ts` 负责将终态 proof 分类为 delivered/pending/debt；它的 debt 输入是 proof/run/reason 摘要，不能证明历史 debt 的完整 provenance。

因此，给 `applyManagedWorkspaceCleanup` 增加一个 audit 字段或把 `proofId` 填进 release receipt 都不安全：该 API 仍是多 action 顺序 mutation，可能在中途失败；没有统一的 recovery intent 和“执行后回执前崩溃”状态；workspace release 的 lease/action challenge 也不等于 proof debt 的身份授权。当前 D-CLEANUP 的 RED 已直接证明缺少独立审计 projection。

### 6.2 需要新增的 WritePaths（仅为未来 coding 计划）

实现时须另立 coding/TDD 任务，至少新增以下 feature-owned 路径；本节点不创建它们：

1. `packages/pi-subagents-enhanced/src/subagent-dispatch/proof-debt-administration.ts`：公开 typed `get/prepare/apply` 入口与稳定错误码；内部依赖 AuthorityStore、workspace service、coordinator client 和 proof outbox 的公开能力。
2. `packages/pi-subagents-enhanced/src/subagent-dispatch/proof-debt-contract.ts`：请求、audit、projection、状态机和 digest/secret redaction 验证；禁止从 `scripts/**` 或 `pi/extensions/**` 反向依赖。
3. `packages/pi-subagents-enhanced/src/subagent-dispatch/proof-debt-store.ts`：单项 projection、audit、CAS、fsync/atomic rename、recovery scan；不得复用 workspace release ledger 作为第二语义。
4. `packages/pi-subagents-enhanced/package.json` 与相应 package export/verify fixture：仅在契约和测试 GREEN 后新增明确的 `./proof-debt/admin`（最终命名需 code review 裁决）；不得把实现藏在 `administration.ts` 的 workspace release API 中。
5. `test/proof-debt-administration.test.mjs`、`test/proof-debt-recovery.integration.mjs`：使用临时 fixture 覆盖本报告第 5 节矩阵；不改现有 live/test fixture state。

现有 `administration.ts`、`workspace/service.ts`、`coordinator-proof-outbox.ts` 只能作为依赖边界或兼容迁移对象，不能在本节点扩大其语义。若未来需要 workspace release，仍应由现有 `./workspace/admin` 入口以独立单项 release 计划执行，并另有自己的 authorization/revision/audit；不得由 proof-debt API 代调用。

## 7. 结论与阻塞门

**结论：D-CLEANUP 在证据和接口实现完成前继续保持 `blocked-no-safe-public-exit`。** 具体地说：

- D-PROVENANCE 已证明可清理集合为 0；529 条历史 debt 不得自动归为 production，也不得自动归为 fixture。它们应保持 `blocked-unknown`/未处置，D-CLEANUP 不得调用 release、delete、discard 或任何 live mutation。
- 在允许任何 future mutation plan 前，必须同时具备：每一 debt 的 authoritative owner/lease/workspace/terminal/event/queue provenance；经评审并实现的单项 proof-debt API；durable-audit-first、专用幂等键、CAS revision 和 crash recovery；上述临时 fixture 的 RED→GREEN 证据；以及 live mutation 的独立授权。设计文档本身不满足这些条件。

至少待裁决/待验证项：

1. **处置 policy 待裁决：** `abandoned` 的批准主体、不可恢复证据标准、保留期限和是否仅允许 `blocked-unknown` 而不允许历史 debt abandon，尚未由 owner/policy authority 定义；在裁决前禁止自动 abandon。
2. **权威证据待验证：** 对每条历史 debt，Host `RunAuthorization`/owner receipt、官方 terminal proof、owner-scoped binding、workspace lease revision、queue/receipt 的完整顺序和同期存储版本尚未取得；D-PROVENANCE 的可证明清理集合仍为 0。
3. **持久化实现待验证：** 需要确定 proof-debt projection 与 coordinator/outbox 的存储、锁、fsync/rename 和恢复扫描边界，并以“audit 后崩溃”和“执行后回执前崩溃” fixture 证明不会重复 effect；现有 `applyManagedWorkspaceCleanup` 不满足。
4. **跨系统授权待裁决：** owner authority、coordinator action authority 与 workspace lease authority 的绑定协议、过期规则和 digest redaction 尚未形成已实现的 public/typed contract；不能把现有 lease authorization 直接提升为 proof-debt authorization。

在以上项目完成前，本报告只定义 fail-closed 候选接口，不宣称任何 debt 已 delivered/superseded/abandoned，不修改 production/test/live state。
