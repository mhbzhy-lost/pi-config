# Goal 终审 production provider 公开 SDK 契约调查

**日期：** 2026-09-07
**结论：** `T6` **可实现（未在本任务实现）**；`T9` 仍依赖 T6 接线和后续验收，当前不是由 SDK 阻塞。只采用公开 package root exports；未调用 CLI、未读取、检索或记录认证材料。

## 证据范围与版本

本机已安装的公开包 manifest 为：

- `@earendil-works/pi-coding-agent` `0.84.4`：root `exports["."]` 指向 `dist/index.js` / `dist/index.d.ts`，公开导出 `ModelRuntime`、`createAgentSession`、`SessionManager`、`resolveCliModel` 和 `resolveModelScopeWithDiagnostics`。
- `@earendil-works/pi-ai` `0.84.4`：root `exports["."]` 指向 `dist/index.js` / `dist/index.d.ts`；model 类型和 `Models` API 是 public export。

完整阅读的公开文档为 `docs/sdk.md` 与 `docs/extensions.md`，并核对其引用的 `examples/sdk/02-custom-model.ts`、`examples/sdk/05-tools.ts` 及 `examples/extensions/structured-output.ts`。未 deep import，也没有把测试 provider stub 当作 production 证据。

SDK 文档明确：

1. `ModelRuntime.create()` 是运行时入口；`modelRuntime.getModel(provider, model)` 解析已知/自定义 catalog 中的明确 model。`getAvailable()` 只返回已配置有效认证的 model；T6 只能把其结果作为 readiness 布尔判断，绝不输出认证内容。不得使用 session/default/first-available 回退，因为终审模型必须由 composition root 的明确 `provider/model` 配置决定。
2. `createAgentSession({ modelRuntime, model, sessionManager: SessionManager.inMemory(), noTools: "all" })` 是公开、无持久 session、无工具的会话配置。`noTools: "all"` 同时禁用 builtin、extension 和 custom tools，故不可用 structured-output tool 作为模型输出 authority。
3. `session.prompt(text)` 等待 accepted run（含 SDK 自动 retry）完成；`session.messages` 是公开状态，`session.abort()` 是公开的当前操作中断；`session.dispose()` 清理 session。SDK 没有 per-`prompt` timeout 参数。因此 adapter 应自持 `AbortController`/deadline，在 deadline 到达时调用 `await session.abort()`，以 `Promise.race` 只决定调用方等待，并在 `finally` 清计时器、`dispose()`。创建/refresh 的公开 signal 只用于 runtime/catalog 操作；T6 不应刷新模型 catalog。
4. SDK 没有此无工具 session 的 provider-enforced JSON schema/response-format API。可行的 fail-closed 方法是：提示模型只返回一个 JSON object；在最终 assistant text 上严格 JSON parse、exact-key/schema/range 验证；任何缺失、多余字段、解析错误、abort、timeout 或 session error 都拒绝。模型文字不是 ledger authority。

## 冻结的 T6 接口

`runRecoverableFinalReview()` 的调用方已拥有并先持久化 derived intent；T6 仅扩展它传入 provider 的值，不改变 identity 算法：

```ts
export type FinalReviewSeverity = "none" | "minor" | "important" | "critical";
export type FinalReviewApproval = Readonly<{
  entryId: string;
  sessionId: string;
  source: "user";
}>;

export type FinalReviewReportStore = Readonly<{
  persist(input: Readonly<{
    reviewId: string;
    manifestHash: string;
    approval: FinalReviewApproval;
    content: string;
  }>): Promise<`sha256:${string}`>;
}>;

export type ProductionFinalReviewProvider = (
  input: Readonly<{
    manifest: FinalizationManifest;       // same deep-frozen, hash-validated object
    approval: FinalReviewApproval;        // exact approved user capability
    reviewId: string;                     // derived from manifest + approval
    idempotencyKey: string;               // exactly reviewId
    writerLockHeld: false;
  }>,
) => Promise<Readonly<{
  severity: FinalReviewSeverity;
  reportRef: `sha256:${string}`;
}>>;

export function createProductionFinalReviewProvider(options: Readonly<{
  modelRuntime: ModelRuntime;
  model: { provider: string; id: string };
  timeoutMs: number;
  reportStore: FinalReviewReportStore;
}>): ProductionFinalReviewProvider;
```

The provider invocation object must have exactly `approval`, `idempotencyKey`, `manifest`, `reviewId`, and `writerLockHeld`; its `manifest` is the same immutable object accepted by `runRecoverableFinalReview`, and `writerLockHeld` is exactly `false`. The new RED in `test/goal-engine-final-review.integration.mjs` freezes this boundary. It currently fails because production code passes only review identity and lock state; this task intentionally does not make it green.

## Required adapter behavior for T6

1. **Composition/model resolution.** Only `pi/extensions/goal-engine.ts` creates the adapter and injects it into `createGoalEngineExtension()`. It creates one `ModelRuntime`, resolves the explicitly configured `{ provider, id }` using public `modelRuntime.getModel()`, and fails readiness when not found or unavailable. It must not silently use `createAgentSession` default restoration/settings/first-available resolution.
2. **No tools and isolation.** For each invocation create a new `SessionManager.inMemory()` session with `noTools: "all"`, the resolved model, `thinkingLevel: "off"`, and no reusable/persisted conversation. Include the immutable manifest and approval identity in the review prompt; do not attach repository tools or extension tools.
3. **Timeout/abort.** A fixed positive `timeoutMs` is owned by the adapter. On deadline invoke public `session.abort()`, classify the operation as a provider failure, and always `session.dispose()`. Caller-supplied cancellation is not part of the frozen provider ABI; later API evolution needs a new contract version rather than an extra provider input key.
4. **Structured result and report persistence.** The model is asked for exact JSON `{ "severity": ..., "report": ... }`; the adapter validates exact keys and the severity enum. It writes the validated report content first through feature-owned `FinalReviewReportStore.persist({ reviewId, manifestHash, approval, content })` to `<stateRoot>/final-review-reports/sha256/<digest>.json` (safe directory and `0600` file), which returns content-addressed `sha256:<digest>`; only then does it return `{ severity, reportRef }`. The existing `<stateRoot>/final-reviews/<reviewId>.json` result store remains the durable intent/result/idempotency authority and stores only `reportRef`, never prompt/raw model text. A persistence failure or malformed model output fails closed.
5. **Writer-lock boundary.** `runRecoverableFinalReview()` persists/recovers intent using its own short store locks, then calls the provider outside any Goal writer lock (`writerLockHeld: false`). The model result is untrusted data: only the existing host validation and subsequent ledger append decide finalization.
6. **Retry/idempotency.** `reviewId === idempotencyKey` is derived from immutable manifest hashes, HEAD and exact approval. Re-entry first inspects the result store; if result exists it does not invoke model again. A provider failure leaves intent durable and returns recoverable failure. Report persistence must make the same `(reviewId, manifestHash, approval)` retry idempotent and reject a different content digest for that identity.

## T6/T9 gate

Public SDK coverage is sufficient for a minimal production adapter: public model lookup/runtime, in-memory sessions, no-tools, abort/dispose, and public messages permit a fail-closed JSON adapter. It does **not** supply provider-enforced schema or a prompt timeout option; T6 must implement host-side exact validation and deadline/abort as above. That is a bounded adapter responsibility, not an SDK BLOCKED condition.

T6 remains blocked only until this RED contract is made green and the production composition root injects the real adapter. T9 remains blocked on T6 plus its separate fresh-Host prerequisites; neither is blocked by an absent public SDK API.
