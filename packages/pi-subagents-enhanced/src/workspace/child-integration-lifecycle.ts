/** Trusted Auto Integration lifecycle for managed coding children.
 * Host events only inject the binding; private workspace facts stay in the coordinator.
 */
const KEY = Symbol.for("pi.subagent.child-integration-lifecycle.v1");
const TERMINAL = new Set(["completed", "preserved", "cancelled", "blocked"]);
const CONFLICT = "Resolve only the current rebase conflict, then git add the resolved files. Do not enqueue, publish, or change integration state.";

function records(): Map<string, any> {
  const processObject = process as any;
  if (!(processObject[KEY] instanceof Map)) Object.defineProperty(processObject, KEY, { value: new Map(), configurable: true });
  return processObject[KEY];
}
export function resetChildIntegrationLifecyclesForTest() { records().clear(); }

export function createChildIntegrationLifecycle(options: any = {}) {
  const { pi, coordinator, resolveBinding = () => ({}), key, managed = true, maxAdmissionPolls = 3, pollDelayMs = 25, trace = () => {} } = options;
  if (!pi || typeof pi.on !== "function" || !coordinator) throw new TypeError("Auto Integration lifecycle dependencies are required");
  if (!managed) return Object.freeze({ dispose() {} });
  const id = typeof key === "string" && key ? key : `child-${Math.random().toString(36).slice(2)}`;
  let record = records().get(id);
  if (!record) { record = { terminal: false, running: false, conflict: false, conflictContinuations: 0, conflictDigest: undefined, settledObservations: 0 }; records().set(id, record); }
  const owner = Symbol(id);
  record.owner = owner;
  let live = true; let retryTimer: NodeJS.Timeout | undefined;
  // A reload may leave old Pi handlers registered briefly. Only the newest
  // lifecycle owner for this durable key may react to an event.
  const current = () => live && records().get(id) === record && record.owner === owner && !record.terminal;
  const delay = () => pollDelayMs > 0 ? new Promise(resolve => setTimeout(resolve, pollDelayMs)) : Promise.resolve();
  const state = (value: any) => value?.queueState ?? value?.state;
  const retryableFailure = (error: any) => {
    const code = String(error?.code ?? "");
    const message = String(error?.message ?? error);
    return /^(?:BROKER_(?:DISCONNECTED|TIMEOUT)|GRANT_NOT_READY|COORDINATOR_(?:UNAVAILABLE|NOT_READY)|ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT)$/i.test(code)
      || /MANAGED_WORKSPACE_(?:INTEGRATE|DIRTY)|clean committed HEAD|workspace admission|not.?ready|acceptance report|coordinator (?:connection|transport).*(?:closed|failed)|temporar(?:y|ily) unavailable/i.test(`${code} ${message}`);
  };
  const preserve = async (binding: any, reason = "integration recovery required") => {
    if (!current()) return;
    record.terminal = true;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = undefined; }
    try { await coordinator.preserveIntegrationDebt(binding, reason); } catch { /* durable coordinator state remains authoritative */ }
  };
  const durableStates = new Set(["queued", "admission-pending", "admitted", "rebasing", "resolving-conflict", "prepared"]);
  const shutdown = async (binding: any) => {
    if (!current()) return;
    // Shutdown is not an integration disposition.  Ask the coordinator for
    // its durable state and leave all live queue items for the daemon/reload
    // path.  Only a terminal or absent item may become recovery debt here.
    try {
      const result = typeof coordinator.inspectAutoIntegration === "function"
        ? await coordinator.inspectAutoIntegration(binding)
        : undefined;
      const next = state(result);
      if (durableStates.has(next)) return;
      if (next === "completed" || next === "cancelled" || next === "preserved" || next === "absent") {
        // There is no live integration to disposition in these states.
        record.terminal = true;
        return;
      }
      if (next === "blocked") {
        await preserve(binding, "shutdown");
        return;
      }
      // Unknown state is not a reason to terminate a durable queue item;
      // leave it for coordinator reconciliation on the next lifecycle.
    } catch {
      // A dead coordinator cannot be waited on during shutdown.  The existing
      // preserve/debt RPC is deliberately attempted once so a reconnecting
      // coordinator can persist an explicit recovery intent.
      await preserve(binding, "coordinator-unavailable");
    }
  };
  const schedule = (binding: any) => {
    if (!current() || retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = undefined; void advance(binding); }, Math.max(1, pollDelayMs));
    retryTimer.unref?.();
  };
  async function advance(binding: any) {
    if (!current() || record.running) return;
    record.running = true;
    trace("integration-lifecycle-agent-end", { key });
    try {
      let result: any;
      if (!record.conflict) {
        result = await coordinator.prepareAutoIntegration(binding);
        if (!current()) return;
        trace("integration-lifecycle-prepare-result", { queueState: state(result) });
      }
      if (record.conflict || state(result) === "queued" || state(result) === "admitted" || state(result) === "rebasing" || state(result) === "prepared" || state(result) === "resolving-conflict") {
        for (let poll = 0; poll < maxAdmissionPolls; poll++) {
          if (!current()) return;
          // A broker-backed child has only runId and must send the wire-level
          // empty input; an injected/direct coordinator client still requires
          // its complete Host-derived binding. Continuation itself always comes
          // from the coordinator's durable resolving-conflict queue state.
          const directBinding = typeof binding?.workspaceId === "string" && typeof binding?.leaseId === "string" && binding?.ownerScope ? binding : {};
          trace("integration-lifecycle-advance-call", { poll });
          result = await coordinator.advanceAutoIntegration(directBinding);
          trace("integration-lifecycle-advance-return", { poll });
          if (!current()) return;
          const next = state(result);
          trace("integration-lifecycle-advance-result", { queueState: next, poll });
          if (TERMINAL.has(next) || next === "resolving-conflict") break;
          await delay();
        }
      }
      if (!current()) return;
      const next = state(result);
      if (next === "completed") { record.terminal = true; record.conflict = false; if (retryTimer) { clearTimeout(retryTimer); retryTimer = undefined; } return; }
      if (next === "resolving-conflict") {
        record.conflict = true;
        const digest = typeof result?.conflictDigest === "string" ? result.conflictDigest : undefined;
        const persistedAttempt = Number.isSafeInteger(result?.continuationAttempt) ? result.continuationAttempt : undefined;
        const noProgress = result?.noProgress === true || (record.conflictDigest !== undefined && digest === record.conflictDigest);
        const attempts = persistedAttempt ?? record.conflictContinuations + 1;
        if (noProgress) { await preserve(binding, "guard-no-progress"); return; }
        record.conflictDigest = digest;
        record.conflictContinuations = attempts;
        // advance 已尝试 durable continue（rebase --continue）仍返回未解决冲突：
        // 只有此刻才向模型发冲突解决 follow-up；空手 turn 会被 acceptance gate
        // 拒绝（no-staged-files），必须由 coordinator 的 continue 先行。
        await pi.sendMessage({ customType: "subagent-integration-conflict", content: CONFLICT }, { deliverAs: "followUp", triggerTurn: true });
        return;
      }
      if (TERMINAL.has(next)) { record.terminal = true; return; }
      // Admission can legitimately race the child's final commit.  A provider
      // retry/error may emit agent_end while the workspace is still dirty;
      // keep the lifecycle alive so the next agent_end can admit the commit.
      if (next === "not-ready" || next === "retryable" || result?.workspaceState === "dirty" || result?.workspaceState === "not-ready" || result?.workspaceReady === false) return;
      // A queued non-head is healthy FIFO backpressure, not integration debt.
      // Continue trusted admission polling without waking the model.
      if (next === "queued" || next === "admitted" || next === "rebasing" || next === "prepared") { schedule(binding); return; }
      await preserve(binding, "explicit");
    } catch (error: any) {
      // Provider retries and transient Host/RPC readiness failures are not
      // evidence of terminal integration debt. Keep the generation live so a
      // later agent_end can retry without consuming the conflict guard.
      if (!retryableFailure(error)) await preserve(binding, "rpc-rejected");
      trace("integration-lifecycle-advance-error", { reason: String(error?.message ?? error).slice(0, 200), retryable: retryableFailure(error) });
    }
    finally { record.running = false; }
  }
  const disposers = [
    // Pi 0.85.1 awaits agent_end handlers before deciding whether a queued
    // follow-up continues the child.  Therefore all trusted mechanical work,
    // including conflict continuation, must start here rather than at the
    // later agent_settled notification.
    pi.on("agent_end", async () => { if (current()) await advance(await resolveBinding()); }) ?? (() => {}),
    // Settled is observation-only.  Keeping the count on the shared record is
    // useful across extension reloads without making it an execution trigger.
    pi.on("agent_settled", () => { if (current()) record.settledObservations++; }) ?? (() => {}),
    pi.on("session_shutdown", async () => { if (current()) await shutdown(await resolveBinding()); }) ?? (() => {}),
  ];
  return Object.freeze({ dispose() { live = false; if (retryTimer) clearTimeout(retryTimer); for (const dispose of disposers.splice(0)) dispose(); } });
}
