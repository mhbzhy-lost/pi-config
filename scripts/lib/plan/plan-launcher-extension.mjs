import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPlanRevisionStore } from "./plan-revision-store.mjs";
import { createPlanWorkspace, rollbackPlanWorkspace } from "./workspace.mjs";
import { createPlanControl } from "./plan-control.mjs";
import { createPlanHostRuntime } from "./plan-host-runtime.mjs";

const HANDLE_TYPE = "pi-plan-launch-handle-v3";
const HANDLE_PREFIX = "PI_PLAN_HANDLE=";
const HANDLE_SCHEMA = "pi-plan-handle.v3";
const PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DEFAULT_PLAN_RUNNER_ENTRY = fileURLToPath(new URL("../../../pi/child-extensions/plan-runner.ts", import.meta.url));
const DEFAULT_PI_SUBAGENTS_ENTRY = fileURLToPath(new URL("../../../pi/npm/node_modules/pi-subagents", import.meta.url));

function interactive(ctx) {
  return ctx?.mode === "tui" && ctx?.hasUI === true;
}

function runRequest(args, ctx, id) {
  if (interactive(ctx)) {
    if (typeof args !== "string" || !args.trim()) throw new Error("plan-run requires a plan path");
    return { planPath: args, planId: id() };
  }
  if (typeof args !== "string" || !args.trim()) throw new Error("noninteractive plan-run requires JSON with allowPlanCommits: true");
  let request;
  try { request = JSON.parse(args); } catch { throw new Error("noninteractive plan-run requires JSON with allowPlanCommits: true"); }
  if (!request || typeof request !== "object" || Array.isArray(request)
    || typeof request.planPath !== "string" || !request.planPath.trim() || request.allowPlanCommits !== true) {
    throw new Error("noninteractive plan-run requires JSON with allowPlanCommits: true");
  }
  return { planPath: request.planPath, planId: request.planId ?? id() };
}

function validHandle(handle) {
  return handle?.schemaVersion === HANDLE_SCHEMA
    && typeof handle.planId === "string" && PLAN_ID.test(handle.planId) && !handle.planId.includes("..")
    && Number.isSafeInteger(handle.revision) && handle.revision >= 1
    && typeof handle.manifestSha256 === "string" && /^[a-f0-9]{64}$/.test(handle.manifestSha256)
    && typeof handle.sourceBytesSha256 === "string" && /^[a-f0-9]{64}$/.test(handle.sourceBytesSha256)
    && typeof handle.planHash === "string" && /^[a-f0-9]{64}$/.test(handle.planHash)
    && typeof handle.planIrHash === "string" && /^[a-f0-9]{64}$/.test(handle.planIrHash)
    && typeof handle.hostRunId === "string" && handle.hostRunId
    && typeof handle.processIdentity === "string" && handle.processIdentity
    && Number.isInteger(handle.pid) && handle.pid > 0
    && ["runDir", "sessionFile", "statusPath", "worktree", "startedAt"].every((field) => typeof handle[field] === "string" && handle[field]);
}

function persistedHandlePath(stateRoot, planId) {
  if (typeof planId !== "string" || !PLAN_ID.test(planId) || planId.includes("..")) throw new Error("Invalid planId");
  return path.resolve(stateRoot, "var", "plan-runs", planId, "host-handle.json");
}

async function persistHandle(stateRoot, handle) {
  const destination = persistedHandlePath(stateRoot, handle.planId);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(handle), { mode: 0o600 });
  await rename(temporary, destination);
}

async function readPersistedHandle(stateRoot, planId) {
  let handle;
  try {
    handle = JSON.parse(await readFile(persistedHandlePath(stateRoot, planId), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  if (handle?.schemaVersion !== HANDLE_SCHEMA) throw new Error("Legacy Plan handle requires explicit migration to v3");
  if (!validHandle(handle) || handle.planId !== planId) throw new Error("Persisted v3 Plan handle is invalid");
  return handle;
}

async function concreteBase(originRoot) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)("git", ["rev-parse", "--verify", "HEAD^{commit}"], { cwd: originRoot });
  return stdout.trim();
}

function trustedHandle(stateRoot, handle) {
  if (!validHandle(handle)) throw new Error("Plan handle must be pi-plan-handle.v3");
  const runRoot = path.resolve(stateRoot, "var", "plan-runs", handle.planId);
  const expectedStatus = path.join(runRoot, "status.json");
  const expectedRunDir = path.join(runRoot, "host");
  const expectedWorktree = path.resolve(stateRoot, "var", "plan-worktrees", handle.planId);
  if (path.resolve(handle.statusPath) !== expectedStatus || path.resolve(handle.runDir) !== expectedRunDir
    || path.resolve(handle.worktree) !== expectedWorktree) {
    throw new Error("Plan v3 handle contains an untrusted path");
  }
  return handle;
}


function toolResult(value, isError = false) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function pendingAttention(plan, { planId, requestId, expectedProjectionVersion }) {
  if (plan?.planId !== undefined && plan.planId !== planId) throw new Error("Plan Attention planId does not match");
  if (!Number.isInteger(expectedProjectionVersion) || expectedProjectionVersion < 1) {
    throw new Error("Plan Attention projection version is invalid");
  }
  const matches = [];
  for (const task of plan?.tasks ?? []) {
    for (const attempt of task.attempts ?? []) {
      if (attempt.status !== "waiting-attention" || attempt.attention?.status !== "pending"
        || attempt.attention.requestId !== requestId) continue;
      matches.push({ taskId: task.taskId, attemptId: attempt.attemptId, runId: attempt.runId, attention: attempt.attention });
    }
  }
  if (matches.length !== 1) throw new Error("Plan Attention does not match exactly one pending Attempt");
  if (matches[0].attention.projectionVersion !== expectedProjectionVersion) {
    throw new Error("Plan Attention projection version is stale");
  }
  return matches[0];
}

export function createPlanLauncherExtension(pi, options = {}) {
  const originRoot = path.resolve(options.originRoot ?? process.cwd());
  const stateRoot = path.resolve(options.stateRoot ?? originRoot);
  const planRunnerEntry = options.planRunnerEntry ?? DEFAULT_PLAN_RUNNER_ENTRY;
  const hostRuntime = options.hostRuntime ?? createPlanHostRuntime({
    emitAttention: (message) => pi.sendMessage?.(message, { triggerTurn: true, deliverAs: "followUp" }),
    extraExtensions: [DEFAULT_PI_SUBAGENTS_ENTRY],
    noExtensions: true,
  });
  const revisionStore = options.revisionStore ?? createPlanRevisionStore({ stateRoot, now: options.now });
  const control = options.planControl ?? createPlanControl({ stateRoot, id: options.id, now: options.now });
  const activeHandles = new Map();
  const attentionPollers = new Map();
  const schedule = options.schedule ?? setInterval;
  const cancelSchedule = options.cancelSchedule ?? clearInterval;
  const attentionPollIntervalMs = options.attentionPollIntervalMs ?? 1_000;

  function stopAttentionPoller(hostRunId) {
    const timer = attentionPollers.get(hostRunId);
    if (timer === undefined) return;
    cancelSchedule(timer);
    attentionPollers.delete(hostRunId);
  }

  function startAttentionPoller(handle) {
    if (attentionPollers.has(handle.hostRunId)) return;
    let polling = false;
    const timer = schedule(async () => {
      if (polling) return;
      polling = true;
      try {
        const observed = await hostRuntime.status(handle);
        if (["complete", "failed", "stopped"].includes(observed.host?.state)
          || ["validated", "blocked", "cancelled", "interrupted"].includes(observed.plan?.lifecycle)) {
          stopAttentionPoller(handle.hostRunId);
        }
      } catch {
        // Durable status remains authoritative; a later poll or explicit status can retry.
      } finally {
        polling = false;
      }
    }, attentionPollIntervalMs);
    timer?.unref?.();
    attentionPollers.set(handle.hostRunId, timer);
  }

  async function getHandle(planId, ctx) {
    const provided = await options.findHandle?.(planId, ctx);
    if (provided) return trustedHandle(stateRoot, provided);
    const branch = ctx?.sessionManager?.getBranch?.() ?? [];
    const fromSession = branch
      .filter((entry) => entry?.customType === HANDLE_TYPE)
      .map((entry) => entry.data)
      .find((handle) => handle.planId === planId);
    const handle = fromSession ?? await readPersistedHandle(stateRoot, planId);
    if (!handle) throw new Error(`Unknown plan: ${planId}`);
    return trustedHandle(stateRoot, handle);
  }

  async function launchPlan({ planPath, planId }, ctx = {}) {
    const sourceBytes = await readFile(planPath);
    const prepared = await revisionStore.prepareRevision({ planId, sourceBytes, reason: "initial-approval", initiator: { kind: "launcher" } });
    let existing;
    try { existing = await getHandle(planId, ctx); } catch (error) {
      if (!/Unknown plan/.test(error.message)) throw error;
    }
    if (existing) throw new Error(`Plan already exists: ${planId}`);
    const baseCommit = options.readBaseCommit ? await options.readBaseCommit(originRoot) : await concreteBase(originRoot);
    let workspaceLease;
    let handle;
    try {
      workspaceLease = await (options.createWorkspace ?? createPlanWorkspace)({ originRoot, stateRoot, planId, baseCommit });
      const worktree = workspaceLease.workspacePath;
      const runDir = path.join(stateRoot, "var", "plan-runs", planId, "host");
      const statusPath = path.join(stateRoot, "var", "plan-runs", planId, "status.json");
      handle = await hostRuntime.spawnPlanRunner({
        planId,
        revision: prepared.revision,
        manifestSha256: prepared.manifestSha256,
        sourceBytesSha256: prepared.manifest.sourceBytesSha256,
        planHash: prepared.manifest.planHash,
        planIrHash: prepared.manifest.irHash,
        baseCommit,
        originRoot,
        stateRoot,
        cwd: worktree,
        extension: planRunnerEntry,
        runDir,
        statusPath,
      });
      trustedHandle(stateRoot, handle);
      const expectedIdentity = {
        planId,
        revision: prepared.revision,
        manifestSha256: prepared.manifestSha256,
        sourceBytesSha256: prepared.manifest.sourceBytesSha256,
        planHash: prepared.manifest.planHash,
        planIrHash: prepared.manifest.irHash,
      };
      for (const [field, expected] of Object.entries(expectedIdentity)) {
        if (handle[field] !== expected) throw new Error(`Plan Host returned mismatched ${field}`);
      }
      await (options.persistHandle ?? persistHandle)(stateRoot, handle);
      pi.appendEntry(HANDLE_TYPE, handle);
      activeHandles.set(handle.hostRunId, handle);
      startAttentionPoller(handle);
      ctx.ui?.notify?.(`${HANDLE_PREFIX}${JSON.stringify(handle)}`, "info");
      return handle;
    } catch (error) {
      if (handle) await hostRuntime.stop(handle).catch(() => {});
      if (workspaceLease) {
        try {
          await (options.rollbackWorkspace ?? rollbackPlanWorkspace)(workspaceLease);
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "Plan launch failed and workspace rollback failed", { cause: error });
        }
      }
      throw error;
    }
  }

  pi.registerTool({
    name: "plan_run",
    label: "Run plan",
    description: "Launch an approved plan in a dedicated worktree via the standalone plan-runner.",
    parameters: {
      type: "object",
      properties: { planPath: { type: "string", minLength: 1 } },
      required: ["planPath"],
      additionalProperties: false,
    },
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const handle = await launchPlan({ planPath: params.planPath, planId: options.id?.() ?? crypto.randomUUID() }, ctx);
        return { content: [{ type: "text", text: JSON.stringify(handle, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : "Plan launch failed." }], isError: true };
      }
    },
  });

  pi.registerTool({
    name: "plan_attention_reply",
    label: "Reply to plan attention",
    description: "Queue an explicit user decision for one pending durable Plan Attention request.",
    parameters: {
      type: "object",
      properties: {
        planId: { type: "string", minLength: 1 },
        requestId: { type: "string", minLength: 1 },
        expectedProjectionVersion: { type: "integer", minimum: 0 },
        message: { type: "string", minLength: 1, maxLength: 65_536 },
      },
      required: ["planId", "requestId", "expectedProjectionVersion", "message"],
      additionalProperties: false,
    },
    async execute(_id, params, _signal, _update, ctx) {
      try {
        if (typeof params.message !== "string" || !params.message.trim()) throw new Error("Plan Attention reply message is required");
        const handle = await getHandle(params.planId, ctx);
        const observed = await hostRuntime.status(handle);
        const match = pendingAttention(observed.plan, params);
        const command = {
          planId: params.planId,
          requestId: params.requestId,
          taskId: match.taskId,
          attemptId: match.attemptId,
          runId: match.runId,
          expectedProjectionVersion: params.expectedProjectionVersion,
          message: params.message,
          occurredAt: options.now?.() ?? new Date().toISOString(),
        };
        const prior = (await control.readAttentionReplies(params.planId))
          .find((candidate) => candidate.requestId === params.requestId);
        if (prior) {
          for (const field of ["planId", "requestId", "taskId", "attemptId", "runId", "expectedProjectionVersion", "message"]) {
            if (prior[field] !== command[field]) throw new Error("A different durable Plan Attention reply is already queued");
          }
        } else {
          await control.writeAttentionReply(command);
        }
        return toolResult({ status: "queued", planId: params.planId, requestId: params.requestId });
      } catch (error) {
        return toolResult(error instanceof Error ? error.message : "Plan Attention reply failed.", true);
      }
    },
  });

  pi.registerCommand("plan-run", {
    description: "Run an approved plan in a dedicated worktree.",
    async handler(args, ctx = {}) {
      const request = runRequest(args, ctx, () => options.id?.() ?? crypto.randomUUID());
      if (interactive(ctx) && (typeof ctx.ui?.confirm !== "function"
        || !(await ctx.ui.confirm("Authorize plan commits", "Allow commits in the dedicated plan branch only; merge and push remain forbidden?")))) {
        throw new Error("Plan commit authorization was not confirmed");
      }
      return launchPlan(request, ctx);
    },
  });

  // Root lifecycle does not own the Standalone Host lifetime.
  pi.on?.("session_shutdown", async () => {
    for (const hostRunId of attentionPollers.keys()) stopAttentionPoller(hostRunId);
  });

  pi.registerCommand("plan-status", {
    description: "Read Host and Plan domain status.",
    async handler(planId, ctx = {}) {
      const result = await hostRuntime.status(await getHandle(planId, ctx));
      ctx.ui?.notify?.(JSON.stringify(result), "info");
      return result;
    },
  });

  pi.registerCommand("plan-open", {
    description: "Open the Plan Session artifact.",
    async handler(planId, ctx = {}) {
      const handle = await getHandle(planId, ctx);
      const artifact = { sessionFile: handle.sessionFile, statusPath: handle.statusPath, worktree: handle.worktree };
      ctx.ui?.notify?.(JSON.stringify(artifact), "info");
      return artifact;
    },
  });

  pi.registerCommand("plan-pause", {
    description: "Interrupt a running Standalone Plan Runner.",
    async handler(planId, ctx = {}) {
      await hostRuntime.interrupt(await getHandle(planId, ctx));
    },
  });

  pi.registerCommand("plan-cancel", {
    description: "Persist cancellation intent and stop the Standalone Host.",
    async handler(planId, ctx = {}) {
      const handle = await getHandle(planId, ctx);
      if (typeof options.recordCancelIntent === "function") await options.recordCancelIntent(handle);
      else await control.requestCancel({ planId: handle.planId, runId: handle.hostRunId });
      await hostRuntime.stop(handle);
      stopAttentionPoller(handle.hostRunId);
      activeHandles.delete(handle.hostRunId);
      return `Plan ${planId} cancelled.`;
    },
  });

  pi.registerCommand("plan-recover", {
    description: "Attach a verified v3 Host handle without spawning.",
    async handler(planId, ctx = {}) {
      const handle = await getHandle(planId, ctx);
      const result = await hostRuntime.reconcile(handle);
      if (result.attached) {
        activeHandles.set(handle.hostRunId, handle);
        startAttentionPoller(handle);
      }
      ctx.ui?.notify?.(JSON.stringify(result), "info");
      return result;
    },
  });
}
