import { readFile } from "node:fs/promises";
import path from "node:path";
import { createPlanRevisionStore } from "./plan-revision-store.mjs";
import { createPlanWorkspace, rollbackPlanWorkspace } from "./workspace.mjs";
import { createPlanControl } from "./plan-control.mjs";
import { requireRootBroker } from "../subagent-dispatch/root-broker-registry.ts";

const HANDLE_TYPE = "pi-plan-launch-handle-v4";
const HANDLE_PREFIX = "PI_PLAN_HANDLE=";
const HANDLE_SCHEMA = "pi-plan-handle.v4";
const PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

class UnknownPlanError extends Error {
  constructor(planId) { super(`Unknown plan: ${planId}`); this.code = "PLAN_UNKNOWN"; }
}

function interactive(ctx) { return ctx?.mode === "tui" && ctx?.hasUI === true; }
function runRequest(args, ctx, id) {
  if (interactive(ctx)) {
    if (typeof args !== "string" || !args.trim()) throw new Error("plan-run requires a plan path");
    return { planPath: args, planId: id() };
  }
  if (typeof args !== "string" || !args.trim()) throw new Error("noninteractive plan-run requires JSON with allowPlanCommits: true");
  let request; try { request = JSON.parse(args); } catch { throw new Error("noninteractive plan-run requires JSON with allowPlanCommits: true"); }
  if (!request || typeof request !== "object" || Array.isArray(request) || typeof request.planPath !== "string" || !request.planPath.trim() || request.allowPlanCommits !== true) throw new Error("noninteractive plan-run requires JSON with allowPlanCommits: true");
  return { planPath: request.planPath, planId: request.planId ?? id() };
}
function validHandle(handle) {
  const required = ["schemaVersion", "planId", "revision", "manifestSha256", "sourceBytesSha256", "planHash", "planIrHash", "rootSessionId", "planRunnerRunId", "asyncDir", "worktree", "baseCommit"];
  if (!handle || Object.keys(handle).length !== required.length || !required.every((key) => Object.hasOwn(handle, key))) return false;
  return handle.schemaVersion === HANDLE_SCHEMA && typeof handle.planId === "string" && PLAN_ID.test(handle.planId) && Number.isSafeInteger(handle.revision) && handle.revision >= 1
    && [handle.manifestSha256, handle.sourceBytesSha256, handle.planHash, handle.planIrHash].every((value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))
    && [handle.rootSessionId, handle.planRunnerRunId, handle.asyncDir, handle.worktree, handle.baseCommit].every((value) => typeof value === "string" && value.length > 0);
}
function trustedHandle(handle) { if (!validHandle(handle)) throw new Error("Plan handle must be pi-plan-handle.v4"); return handle; }
function toolResult(value, isError = false) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}
function pendingAttention(plan, { planId, requestId, expectedProjectionVersion }) {
  if (!Number.isInteger(expectedProjectionVersion) || expectedProjectionVersion < 1) throw new Error("Plan Attention projection version is invalid");
  const matches = (plan?.tasks ?? []).flatMap((task) => (task.attempts ?? []).filter((attempt) => attempt.status === "waiting-attention" && attempt.attention?.status === "pending" && attempt.attention.requestId === requestId).map((attempt) => ({ taskId: task.taskId, attemptId: attempt.attemptId, runId: attempt.runId, attention: attempt.attention })));
  if (matches.length !== 1 || plan?.planId !== undefined && plan.planId !== planId) throw new Error("Plan Attention does not match exactly one pending Attempt");
  if (matches[0].attention.projectionVersion !== expectedProjectionVersion) throw new Error("Plan Attention projection version is stale");
  return matches[0];
}
function bootstrapRevisionIdentity(prepared, { planId, baseCommit, worktree }) {
  return `Open the approved Plan revision by calling plan_open exactly once with ${JSON.stringify({ planId, revision: prepared.revision, manifestSha256: prepared.manifestSha256, planIrHash: prepared.manifest.irHash, baseCommit, worktree, allowPlanCommits: true })}.`;
}
function requireAsyncBinding(reply) {
  const details = reply?.details ?? reply; const runId = details?.runId; const asyncDir = details?.asyncDir;
  if (typeof runId !== "string" || !runId || typeof asyncDir !== "string" || !asyncDir) {
    const error = new Error("Root spawn reply is missing runId or asyncDir"); error.binding = { runId, asyncDir }; throw error;
  }
  return { runId, asyncDir };
}
async function concreteBase(originRoot) {
  const { execFile } = await import("node:child_process"); const { promisify } = await import("node:util");
  return (await promisify(execFile)("git", ["rev-parse", "--verify", "HEAD^{commit}"], { cwd: originRoot })).stdout.trim();
}

export function createPlanLauncherExtension(pi, options = {}) {
  const originRoot = path.resolve(options.originRoot ?? process.cwd());
  const stateRoot = path.resolve(options.stateRoot ?? originRoot);
  const revisionStore = options.revisionStore ?? createPlanRevisionStore({ stateRoot, now: options.now });
  const control = options.planControl ?? createPlanControl({ stateRoot, id: options.id, now: options.now });
  const activeHandles = new Map();
  const launchFences = new Map();
  const attentionPollers = new Map();
  const schedule = options.schedule ?? setInterval;
  const cancelSchedule = options.cancelSchedule ?? clearInterval;
  const stopAttentionPoller = (planId) => {
    const timer = attentionPollers.get(planId);
    if (timer !== undefined) cancelSchedule(timer);
    attentionPollers.delete(planId);
  };
  const forwardedAttention = new Set();
  const forwardAttention = async (handle, plan, { failClosed = false } = {}) => {
    const matches = (plan?.tasks ?? []).flatMap((task) => (task.attempts ?? []).filter((attempt) => attempt.status === "waiting-attention" && attempt.attention?.status === "pending" && typeof attempt.attention.requestId === "string").map((attempt) => ({ attention: attempt.attention })));
    for (const match of matches) {
      const { attention } = match;
      const bodyPath = attention.evidence?.bodyPath;
      const bodySha256 = attention.evidence?.bodySha256;
      const validPath = bodyPath === `attention/${attention.requestId}.md` && typeof bodySha256 === "string" && /^[a-f0-9]{64}$/.test(bodySha256);
      if (!validPath) {
        if (failClosed) throw new Error("Plan Attention evidence is invalid");
        continue;
      }
      const key = `${handle.planId}:${attention.requestId}:${attention.projectionVersion}`;
      if (forwardedAttention.has(key)) continue;
      const runsRoot = path.resolve(stateRoot, "var", "plan-runs", handle.planId);
      const absoluteBodyPath = path.resolve(runsRoot, bodyPath);
      const relative = path.relative(runsRoot, absoluteBodyPath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        if (failClosed) throw new Error("Plan Attention evidence is invalid");
        continue;
      }
      await readFile(absoluteBodyPath, "utf8");
      await pi.sendMessage?.({
        customType: "pi-plan-attention-v1",
        content: [
          `Plan ${handle.planId} requires user input for Attention ${attention.requestId}.`,
          `Read the private Attention body with the read tool at ${absoluteBodyPath}, summarize it to the user, and wait for an explicit decision.`,
          `After the user decides, call plan_attention_reply with planId=${handle.planId}, requestId=${attention.requestId}, and expectedProjectionVersion=${attention.projectionVersion}.`,
          "Do not infer or submit a decision on the user's behalf.",
        ].join("\n"),
        details: { planId: handle.planId, requestId: attention.requestId, expectedProjectionVersion: attention.projectionVersion, bodyPath, bodySha256 },
      });
      forwardedAttention.add(key);
    }
  };
  const startAttentionPoller = (handle) => {
    if (attentionPollers.has(handle.planId)) return;
    let polling = false;
    const timer = schedule(async () => {
      if (polling) return;
      polling = true;
      try {
        const [raw, runner] = await Promise.all([readFile(path.join(stateRoot, "var", "plan-runs", handle.planId, "status.json"), "utf8"), rootIdentity().upstream.status({ runId: handle.planRunnerRunId, dir: handle.asyncDir })]);
        const plan = JSON.parse(raw);
        await forwardAttention(handle, plan);
        if (["validated", "blocked", "cancelled", "interrupted"].includes(plan?.lifecycle) || ["complete", "failed", "stopped"].includes(runner?.state)) stopAttentionPoller(handle.planId);
      } catch { /* Durable projection or Root RPC may be transiently unavailable. */ }
      finally { polling = false; }
    }, options.attentionPollIntervalMs ?? 1_000);
    timer?.unref?.();
    attentionPollers.set(handle.planId, timer);
  };
  const rootBroker = () => options.rootBroker ?? requireRootBroker(pi);
  const rootIdentity = () => {
    const broker = rootBroker();
    if (typeof broker?.rootSessionId !== "string" || !broker.rootSessionId) throw new Error("Root session identity is unavailable");
    if (!broker.upstream) throw new Error("Root typed RPC is unavailable");
    return broker;
  };
  async function getHandle(planId, ctx) {
    const provided = await options.findHandle?.(planId, ctx);
    const branch = ctx?.sessionManager?.getBranch?.() ?? [];
    const fromSession = branch.filter((entry) => entry?.customType === HANDLE_TYPE).map((entry) => entry.data).find((handle) => handle.planId === planId);
    const raw = provided ?? fromSession ?? activeHandles.get(planId);
    if (!raw) throw new UnknownPlanError(planId);
    const handle = trustedHandle(raw);
    if (handle.rootSessionId !== rootIdentity().rootSessionId) throw new Error("Plan run belongs to another Root session");
    if (handle.worktree !== path.join(stateRoot, "var", "plan-worktrees", handle.planId)) throw new Error("Plan handle worktree is untrusted");
    return handle;
  }
  async function stopIfBound(binding, broker) {
    if (typeof binding?.runId !== "string" || !binding.runId) return;
    const params = typeof binding.asyncDir === "string" && binding.asyncDir ? { runId: binding.runId, dir: binding.asyncDir } : { runId: binding.runId };
    await broker.upstream.stop(params).catch((error) => { throw error; });
  }
  async function launchPlan({ planPath, planId }, ctx = {}) {
    if (launchFences.has(planId)) throw new Error(`Plan launch is already in progress: ${planId}`);
    const pending = (async () => {
    if (!PLAN_ID.test(planId)) throw new Error("Invalid planId");
    const sourceBytes = await readFile(planPath);
    const prepared = await revisionStore.prepareRevision({ planId, sourceBytes, reason: "initial-approval", initiator: { kind: "launcher" } });
    let existing;
    try {
      existing = await getHandle(planId, ctx);
    } catch (error) {
      if (!(error instanceof UnknownPlanError)) throw error;
    }
    if (existing) throw new Error(`Plan already exists: ${planId}`);
    const broker = rootIdentity(); const baseCommit = options.readBaseCommit ? await options.readBaseCommit(originRoot) : await concreteBase(originRoot);
    let lease; let binding;
    try {
      lease = await (options.createWorkspace ?? createPlanWorkspace)({ originRoot, stateRoot, planId, baseCommit });
      const worktree = lease.workspacePath;
      const reply = await broker.upstream.spawn({ agent: "plan-runner", title: `Plan ${planId}`, task: bootstrapRevisionIdentity(prepared, { planId, baseCommit, worktree }), cwd: worktree, context: "fresh", async: true, clarify: false, artifacts: true, output: false, timeoutMs: options.planRunnerTimeoutMs ?? DEFAULT_TIMEOUT_MS });
      binding = requireAsyncBinding(reply);
      await broker.grantCaller({ callerRunId: binding.runId, planId, cwd: worktree, originRoot, stateRoot, role: "plan-runner" });
      const handle = trustedHandle({ schemaVersion: HANDLE_SCHEMA, planId, revision: prepared.revision, manifestSha256: prepared.manifestSha256, sourceBytesSha256: prepared.manifest.sourceBytesSha256, planHash: prepared.manifest.planHash, planIrHash: prepared.manifest.irHash, rootSessionId: broker.rootSessionId, planRunnerRunId: binding.runId, asyncDir: binding.asyncDir, worktree, baseCommit });
      pi.appendEntry(HANDLE_TYPE, handle); activeHandles.set(planId, handle); startAttentionPoller(handle); ctx.ui?.notify?.(`${HANDLE_PREFIX}${JSON.stringify(handle)}`, "info"); return handle;
    } catch (error) {
      const partial = binding ?? error?.binding; const cleanup = [];
      if (partial?.runId) cleanup.push(stopIfBound(partial, broker));
      if (lease) cleanup.push((options.rollbackWorkspace ?? rollbackPlanWorkspace)(lease));
      const settled = await Promise.allSettled(cleanup); const failures = settled.filter((item) => item.status === "rejected").map((item) => item.reason);
      if (failures.length) throw new AggregateError([error, ...failures], "Plan launch failed and cleanup failed", { cause: error });
      throw error;
    }
    })();
    launchFences.set(planId, pending);
    try { return await pending; } finally { launchFences.delete(planId); }
  }
  pi.registerTool({ name: "plan_run", label: "Run plan", description: "Launch an approved plan through the Plan dispatch authorization boundary.", parameters: { type: "object", properties: { planPath: { type: "string", minLength: 1 } }, required: ["planPath"], additionalProperties: false }, async execute(_id, params, _signal, _update, ctx) { try { const handle = await launchPlan({ planPath: params.planPath, planId: options.id?.() ?? crypto.randomUUID() }, ctx); return toolResult(handle); } catch (error) { return toolResult(error instanceof Error ? error.message : String(error), true); } } });
  pi.registerTool({ name: "plan_attention_reply", label: "Reply to plan attention", description: "Queue an explicit user decision for one pending durable Plan Attention request.", parameters: { type: "object", properties: { planId: { type: "string", minLength: 1 }, requestId: { type: "string", minLength: 1 }, expectedProjectionVersion: { type: "integer", minimum: 1 }, message: { type: "string", minLength: 1, maxLength: 65536 } }, required: ["planId", "requestId", "expectedProjectionVersion", "message"], additionalProperties: false }, async execute(_id, params, _signal, _update, ctx) {
    try {
      if (typeof params.message !== "string" || !params.message.trim()) throw new Error("Plan Attention reply message is required");
      const handle = await getHandle(params.planId, ctx);
      const plan = JSON.parse(await readFile(path.join(stateRoot, "var", "plan-runs", handle.planId, "status.json"), "utf8"));
      const match = pendingAttention(plan, params);
      const command = { planId: params.planId, requestId: params.requestId, taskId: match.taskId, attemptId: match.attemptId, runId: match.runId, expectedProjectionVersion: params.expectedProjectionVersion, message: params.message, occurredAt: options.now?.() ?? new Date().toISOString() };
      const prior = (await control.readAttentionReplies(params.planId)).find((candidate) => candidate.requestId === params.requestId);
      if (prior) {
        for (const field of ["planId", "requestId", "taskId", "attemptId", "runId", "expectedProjectionVersion", "message"]) if (prior[field] !== command[field]) throw new Error("A different durable Plan Attention reply is already queued");
      } else await control.writeAttentionReply(command);
      return toolResult({ status: "queued", planId: params.planId, requestId: params.requestId });
    } catch (error) { return toolResult(error instanceof Error ? error.message : String(error), true); }
  } });
  pi.registerCommand("plan-run", { description: "Run an approved plan in a dedicated worktree.", async handler(args, ctx = {}) { const request = runRequest(args, ctx, () => options.id?.() ?? crypto.randomUUID()); if (interactive(ctx) && (typeof ctx.ui?.confirm !== "function" || !(await ctx.ui.confirm("Authorize plan commits", "Allow commits in the dedicated plan branch only; merge and push remain forbidden?")))) throw new Error("Plan commit authorization was not confirmed"); return launchPlan(request, ctx); } });
  pi.on?.("session_shutdown", async () => { for (const planId of attentionPollers.keys()) stopAttentionPoller(planId); });
  pi.registerCommand("plan-status", { description: "Read Plan Runner status.", async handler(planId, ctx = {}) { const handle = await getHandle(planId, ctx); const runner = await rootIdentity().upstream.status({ runId: handle.planRunnerRunId, dir: handle.asyncDir }); let raw; try { raw = await readFile(path.join(stateRoot, "var", "plan-runs", handle.planId, "status.json"), "utf8"); } catch (error) { if (error?.code === "ENOENT") return runner; throw error; } const plan = JSON.parse(raw); await forwardAttention(handle, plan, { failClosed: true }); return { runner, plan }; } });
  pi.registerCommand("plan-open", { description: "Open the Plan Runner artifact.", async handler(planId, ctx = {}) { const handle = await getHandle(planId, ctx); const status = await rootIdentity().upstream.status({ runId: handle.planRunnerRunId, dir: handle.asyncDir }); return { asyncDir: handle.asyncDir, worktree: handle.worktree, status }; } });
  pi.registerCommand("plan-pause", { description: "Interrupt a running Plan Runner.", async handler(planId, ctx = {}) { const handle = await getHandle(planId, ctx); return rootIdentity().upstream.interrupt({ runId: handle.planRunnerRunId, dir: handle.asyncDir }); } });
  pi.registerCommand("plan-cancel", { description: "Persist cancellation intent and stop the Plan Runner.", async handler(planId, ctx = {}) { const handle = await getHandle(planId, ctx); if (typeof options.recordCancelIntent === "function") await options.recordCancelIntent(handle); else await control.requestCancel({ planId: handle.planId, runId: handle.planRunnerRunId }); await rootIdentity().upstream.stop({ runId: handle.planRunnerRunId, dir: handle.asyncDir }); stopAttentionPoller(handle.planId); activeHandles.delete(planId); return `Plan ${planId} cancelled.`; } });
  pi.registerCommand("plan-recover", { description: "Reattach the current Root Plan Runner.", async handler(planId, ctx = {}) { const handle = await getHandle(planId, ctx); startAttentionPoller(handle); return rootIdentity().upstream.status({ runId: handle.planRunnerRunId, dir: handle.asyncDir }); } });
}
