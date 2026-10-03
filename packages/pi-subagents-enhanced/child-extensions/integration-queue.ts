const ACTIONS = ["enqueue", "await_admission", "report_conflict", "publish", "fail", "inspect_integration_state", "prepare_auto_integration", "inspect_auto_integration"] as const;
import { createRootBrokerClient } from "../src/subagent-dispatch/root-broker-client.ts";
import { readBrokerGrant } from "../src/subagent-dispatch/root-broker-protocol.ts";
import { createChildIntegrationLifecycle } from "../src/workspace/child-integration-lifecycle.ts";

export const SUBAGENT_INTEGRATION_PARAMETERS = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: { enum: [...ACTIONS] },
    queue_item_id: { type: "string", minLength: 1 },
    queue_lease_id: { type: "string", minLength: 1 },
    candidate_head: { type: "string", minLength: 1 },
    authorized_workspace_head: { type: "string", minLength: 1 },
    target_ref: { type: "string", minLength: 1 },
    retry: { type: "boolean" },
  },
});

export const SUBAGENT_INTEGRATION_DESCRIPTION = "Child-owned repository integration queue. Identity is supplied by the Host binding.";

const GUARD_KEY = Symbol.for("pi.subagent.integration-completion-guards.v1");
type GuardRecord = { generation: number; attempts: number; lastProgress?: string; terminal: boolean; pending: boolean };
function guardRecords(): Map<string, GuardRecord> {
  const processObject = process as any;
  if (!(processObject[GUARD_KEY] instanceof Map)) Object.defineProperty(processObject, GUARD_KEY, { value: new Map(), configurable: true });
  return processObject[GUARD_KEY];
}
export function resetIntegrationCompletionGuardsForTest() { guardRecords().clear(); }

const TERMINAL_FAILURES = new Set(["preserved", "cancelled", "blocked"]);
function progressKey(state: any) { return `${state?.queueState ?? "invalid"}:${state?.workspaceState ?? "invalid"}:${state?.integrationReceipt === true}:${state?.proofState ?? "invalid"}:${state?.revision ?? "invalid"}`; }
function successful(state: any) {
  return state?.queueState === "completed"
    && state.integrationReceipt === true
    && state.proofState === "accepted"
    && state.workspaceState === "released";
}
function terminalFailure(state: any) { return TERMINAL_FAILURES.has(state?.queueState) || state?.workspaceState === "preserved" || state?.proofState === "debt"; }
const CONTINUATION = Object.freeze({ customType: "subagent-integration-completion", content: "Complete the required subagent_integration lifecycle before finishing. Use its trusted queue operations; do not report success until integration is completed." });

function success(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], isError: false, details: value };
}

const SAFE_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;

export const ACTIVATION_GATE_TIMEOUT_MS = 30_000;
const ACTIVATION_GATE_RETRY_DELAY_MS = 250;

// 诊断打点：写入 child runner 的 stderr（console.error 由 runner 重定向到
// asyncDir/runner.stderr.log），仅记录阶段与状态，不携带 prompt/token/凭据；
// 打点失败不影响主链。接受注入 writer 以便测试。
function lifecycleTrace(pi: any) {
  const write = typeof pi?.stderr?.write === "function" ? pi.stderr.write.bind(pi.stderr) : (typeof console !== "undefined" && typeof console.error === "function" ? console.error : undefined);
  if (typeof write !== "function") return () => {};
  return (phase: string, fields: Record<string, unknown> = {}) => {
    try {
      write(`${JSON.stringify({ version: 1, phase, monotonicMs: Math.floor(Number(process.hrtime.bigint() / 1_000_000n)), ...fields })}\n`);
    } catch { /* 诊断输出不得影响生命周期语义 */ }
  };
}

/** Resumed child activation gate：bounded 等待 Root grant 可读且 trusted
 * binding 可解析（workspace/queue rebind 完成）。普通首次 spawn 立即通过；
 * 超时 fail closed（无 lifecycle，由 preserve/proof 循环收敛），期间不触发
 * 模型、不写业务文件、不把 workspace 绑回 source run。*/
export async function awaitIntegrationActivationGate({ readGrant = readBrokerGrant, coordinator, rootSessionId, runId,
  timeoutMs = ACTIVATION_GATE_TIMEOUT_MS, retryDelayMs = ACTIVATION_GATE_RETRY_DELAY_MS, clock = Date.now,
  sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)) }: {
  readGrant?: (rootSessionId: string, runId: string) => Promise<{ capabilities: string[] }>;
  coordinator: { inspectAutoIntegration(input?: any): Promise<any> };
  rootSessionId?: string;
  runId?: string;
  timeoutMs?: number;
  retryDelayMs?: number;
  clock?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
} = { coordinator: undefined as any }) {
  if (!coordinator || typeof coordinator.inspectAutoIntegration !== "function") throw new TypeError("activation gate requires an inspectAutoIntegration coordinator");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError("activation gate timeout must be a positive safe integer");
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0) throw new TypeError("activation gate retry delay must be a non-negative safe integer");
  const deadline = clock() + timeoutMs;
  for (;;) {
    try {
      const grant = await readGrant(rootSessionId, runId);
      if (grant.capabilities.includes("acceptance.submit")) return { eligible: false };
      // binding 可解析即 activation 完成：inspect 同时返回原 queue item 的
      // durable 状态（queued/resolving-conflict/...），供 lifecycle 接续。
      const state = await coordinator.inspectAutoIntegration({});
      return { eligible: true, state };
    } catch (error) {
      if (clock() >= deadline) {
        throw Object.assign(new Error(`integration activation gate timed out: ${error instanceof Error ? error.message : String(error)}`), { code: "ACTIVATION_GATE_TIMEOUT" });
      }
      if (retryDelayMs > 0) await sleep(retryDelayMs);
    }
  }
}

/** A broker/coordinator failure is always a bounded tool error, never a silent success. */
function safeCode(error: any): string {
  const code = error?.code;
  return typeof code === "string" && SAFE_CODE.test(code) ? code : "SUBAGENT_INTEGRATION_ERROR";
}

function failure(error: any, stage: string, operation: string) {
  const code = safeCode(error);
  return {
    content: [{ type: "text", text: `${code}: ${error instanceof Error ? error.message : String(error)}` }],
    isError: true,
    details: { code, stage, operation },
  };
}

export function createSubagentIntegrationTool({ coordinator, resolveBinding }: { coordinator?: any; resolveBinding?: () => any } = {}) {
  let brokerBacked = false;
  if (!coordinator) {
    const rootSessionId = process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID;
    const runId = process.env.PI_SUBAGENT_RUN_ID;
    if (!rootSessionId || !runId) throw new TypeError("subagent integration requires a trusted Root Broker session");
    const broker = createRootBrokerClient({ rootSessionId, callerRunId: runId });
    coordinator = Object.fromEntries([
      ["enqueueIntegration", "enqueue"], ["awaitIntegrationAdmission", "await_admission"],
      ["reportResolvingConflict", "report_conflict"], ["publishRebasedCandidate", "publish"], ["abandonIntegration", "fail"],
      ["inspectIntegrationState", "inspect_integration_state"], ["preserveIntegrationDebt", "preserve_integration_debt"],
      ["prepareAutoIntegration", "prepare_auto_integration"], ["inspectAutoIntegration", "inspect_auto_integration"], ["advanceAutoIntegration", "advance_auto_integration"],
    ].map(([name, operation]) => [name, (input: any) => broker.coordinatorRequest(operation, input)]));
    brokerBacked = true;
    resolveBinding = () => ({ runId });
  }
  if (!coordinator || typeof resolveBinding !== "function") throw new TypeError("subagent integration requires a coordinator and trusted binding resolver");
  return Object.freeze({
    name: "subagent_integration",
    label: "Subagent Integration",
    description: SUBAGENT_INTEGRATION_DESCRIPTION,
    parameters: SUBAGENT_INTEGRATION_PARAMETERS,
    async execute(toolCallId: string, input: any) {
      const operation = input && typeof input.action === "string" && (ACTIONS as readonly string[]).includes(input.action) ? input.action : "unsupported";
      let stage = "binding";
      try {
        if (!input || !ACTIONS.includes(input.action)) throw Object.assign(new TypeError("unsupported integration action"), { code: "SUBAGENT_INTEGRATION_ERROR" });
        const binding = await resolveBinding();
        if (!brokerBacked && (!binding || typeof binding.workspaceId !== "string" || typeof binding.leaseId !== "string"
            || typeof binding.runId !== "string" || !binding.ownerScope)) {
          throw Object.assign(new Error("trusted child binding is unavailable"), { code: "CHILD_BINDING_UNAVAILABLE" });
        }
        const trusted = brokerBacked ? {} : {
          workspaceId: binding.workspaceId,
          leaseId: binding.leaseId,
          runId: binding.runId,
          ownerScope: structuredClone(binding.ownerScope),
        };
        stage = "coordinator";
        switch (input.action) {
          case "enqueue": return success(await coordinator.enqueueIntegration({ ...trusted, requestId: toolCallId, authorizedWorkspaceHead: input.authorized_workspace_head, targetRef: input.target_ref }));
          case "await_admission": return success(await coordinator.awaitIntegrationAdmission({ ...trusted, queueItemId: input.queue_item_id }));
          case "report_conflict": return success(await coordinator.reportResolvingConflict({ ...trusted, queueItemId: input.queue_item_id, queueLeaseId: input.queue_lease_id }));
          case "publish": return success(await coordinator.publishRebasedCandidate({ ...trusted, queueItemId: input.queue_item_id, queueLeaseId: input.queue_lease_id, candidateHead: input.candidate_head }));
          case "fail": return success(await coordinator.abandonIntegration({ ...trusted, queueItemId: input.queue_item_id, queueLeaseId: input.queue_lease_id, retry: input.retry === true }));
          case "inspect_integration_state": return success(await coordinator.inspectIntegrationState(trusted));
          case "prepare_auto_integration": return success(await coordinator.prepareAutoIntegration(brokerBacked ? {} : trusted));
          case "inspect_auto_integration": return success(await coordinator.inspectAutoIntegration(brokerBacked ? {} : trusted));
        }
      } catch (error) {
        return failure(error, stage, operation);
      }
    },
  });
}

export default function integrationQueue(pi: any, options: any = {}) {
  // Required child extensions 也会被 generic 顶层 RPC Host 注入；该场景没有
  // Root Broker 身份，必须静默禁用，不能把不可用的 broker 当作加载错误。
  const env = options.env ?? process.env;
  if (!options.coordinator
    && (env.PI_ROOT_SUBAGENT_BROKER_ENABLED !== "1"
      || !env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID || !env.PI_SUBAGENT_RUN_ID)) {
    try { console.error("[subagent-integration] disabled: trusted Root Broker session unavailable"); } catch { /* 诊断输出不得影响 child 加载 */ }
    return Object.freeze({ dispose() {} });
  }
  const tool = createSubagentIntegrationTool(options);
  pi.registerTool(tool);
  const disposers: Array<() => unknown> = [];
  disposers.push(pi.on("session_start", () => {
    if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") {
      throw new Error("subagent integration requires active tool lifecycle APIs");
    }
    const active = pi.getActiveTools();
    if (!Array.isArray(active) || active.some((name) => typeof name !== "string")) {
      throw new Error("subagent integration received an invalid active tool plan");
    }
    if (!active.includes(tool.name)) pi.setActiveTools([...active, tool.name]);
  }) ?? (() => {}));

  const rootSessionId = process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID;
  const runId = process.env.PI_SUBAGENT_RUN_ID;
  const managed = options.managedCodingWorktree !== false && (options.managedCodingWorktree === true || Boolean(rootSessionId && runId));
  let guardBroker: any;
  let live = true;
  if (managed) {
    const trace = lifecycleTrace(pi);
    const resolve = options.resolveBinding ?? (() => ({ runId }));
    const coordinator = options.coordinator ?? (() => {
      guardBroker = createRootBrokerClient({ rootSessionId, callerRunId: runId });
      return {
        inspectIntegrationState: () => guardBroker.coordinatorRequest("inspect_integration_state", {}),
        preserveIntegrationDebt: (_binding: any, reason?: string) => guardBroker.coordinatorRequest("preserve_integration_debt", { reason }),
        prepareAutoIntegration: () => guardBroker.coordinatorRequest("prepare_auto_integration", {}),
        inspectAutoIntegration: () => guardBroker.coordinatorRequest("inspect_auto_integration", {}),
        advanceAutoIntegration: (input: any) => guardBroker.coordinatorRequest("advance_auto_integration", input ?? {}),
      };
    })();
    const key = options.completionGuardKey ?? `${rootSessionId ?? "injected"}\u0000${runId ?? "injected"}`;
    if (typeof key !== "string" || key.length === 0) throw new TypeError("integration completion guard key is invalid");
    let record = guardRecords().get(key);
    if (!record) { record = { generation: 1, attempts: 0, terminal: false, pending: false }; guardRecords().set(key, record); }
    const generation = record.generation;
    const current = () => live && guardRecords().get(key) === record && record!.generation === generation && !record!.terminal;
    const eligible = async () => {
      if (options.managedCodingWorktree === true) return true;
      const grant = await readBrokerGrant(rootSessionId, runId);
      return !grant.capabilities.includes("acceptance.submit");
    };
    let lifecycle = options.lifecycle === false || typeof coordinator.advanceAutoIntegration !== "function"
      ? undefined
      : options.managedCodingWorktree === true
        ? createChildIntegrationLifecycle({ pi, coordinator, resolveBinding: resolve, key, managed: true, trace })
        : undefined;
    // Production eligibility is a trusted grant fact. Resolve it during the
    // awaited session_start gate so Goal acceptance children never register an
    // Auto Integration lifecycle or record.
    if (!lifecycle && options.lifecycle !== false && typeof coordinator.advanceAutoIntegration === "function" && options.managedCodingWorktree !== true) {
      disposers.push(pi.on("session_start", async () => {
        if (!current() || lifecycle) return;
        try {
          // resumed child 的 activation 与 child 启动并发：bounded 等待 grant
          // 可读且 binding 可解析（root-session-owner 的 5s GRANT_NOT_READY
          // 窗口只覆盖 grant；workspace rebind 受 coordinator 同步 Git 阻塞
          // 影响更慢，由本 gate 独立覆盖）。
          const gate = await awaitIntegrationActivationGate({ coordinator, rootSessionId, runId,
            timeoutMs: options.activationGateTimeoutMs, retryDelayMs: options.activationGateRetryDelayMs });
          trace("integration-gate-passed", { eligible: gate.eligible, queueState: gate.state?.queueState });
          if (!gate.eligible) { record!.terminal = true; return; }
          if (current()) lifecycle = createChildIntegrationLifecycle({ pi, coordinator, resolveBinding: resolve, key, managed: true, trace });
        } catch (error) {
          trace("integration-gate-failed", { reason: String(error?.message ?? error).slice(0, 200) });
          await preserve();
        }
      }) ?? (() => {}));
    }
    const inspect = async () => coordinator.inspectIntegrationState(await resolve());
    const preserve = async (reason = "explicit") => {
      if (!current()) return;
      record!.terminal = true;
      try { await coordinator.preserveIntegrationDebt(await resolve(), reason); } catch { /* Root/coordinator debt remains explicit in this generation. */ }
    };
    disposers.push(pi.on("agent_end", async () => {
      if (lifecycle || !current()) return;
      // Pi awaits agent_end before choosing a queued continuation.  The legacy
      // completion guard must therefore make its bounded decision here too;
      // agent_settled is observation-only.
      try { if (!await eligible()) { record!.terminal = true; return; } } catch { await preserve("coordinator-unavailable"); return; }
      if (!current()) return;
      let before: any;
      try { before = await inspect(); } catch { await preserve("coordinator-unavailable"); return; }
      if (!current()) return;
      if (successful(before) || terminalFailure(before)) { record!.terminal = true; return; }
      if (record!.attempts >= 2) { await preserve("guard-no-progress"); return; }
      record!.attempts++;
      try { await pi.sendMessage(CONTINUATION, { deliverAs: "followUp", triggerTurn: true }); }
      catch { await preserve("rpc-rejected"); return; }
      let after: any;
      try { after = await inspect(); } catch { await preserve("coordinator-unavailable"); return; }
      if (!current()) return;
      if (successful(after) || terminalFailure(after)) { record!.terminal = true; return; }
      const beforeKey = progressKey(before); const afterKey = progressKey(after);
      const progressed = beforeKey !== afterKey || (record!.lastProgress !== undefined && record!.lastProgress !== afterKey);
      record!.lastProgress = afterKey;
      if (!progressed && record!.attempts >= 2) await preserve("guard-no-progress");
    }) ?? (() => {}));
    disposers.push(pi.on("agent_settled", () => { /* observation-only: never start integration here */ }) ?? (() => {}));
    disposers.push(pi.on("session_shutdown", async () => { if (!lifecycle) await preserve("shutdown"); }) ?? (() => {}));
    disposers.push(() => lifecycle?.dispose());
    if (guardBroker) disposers.push(() => guardBroker.dispose());
  }
  return Object.freeze({ dispose() { live = false; for (const dispose of disposers.splice(0)) dispose(); } });
}
