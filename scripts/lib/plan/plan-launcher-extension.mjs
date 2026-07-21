import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parsePlanDocument } from "./plan-document.mjs";
import { createPlanWorkspace, rollbackPlanWorkspace } from "./workspace.mjs";
import { createSubagentsRpcClient } from "../subagents-rpc-client.mjs";
import { createPlanControl } from "./plan-control.mjs";
import { createParentLease } from "./parent-lifecycle.mjs";

const HANDLE_TYPE = "pi-plan-launch-handle-v1";
const HANDLE_PREFIX = "PI_PLAN_HANDLE=";
const HANDLE_FIELDS = ["planId", "planHash", "runId", "asyncDir", "sessionFile", "statusPath", "worktree"];
const PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PLAN_RUNNER_RUNTIME_PATH = ".pi-subagents/plan-runner-entry.mjs";
const DEFAULT_PLAN_RUNNER_ENTRY = fileURLToPath(new URL("../../../pi/child-extensions/plan-runner.ts", import.meta.url));
const PARENT_LIFECYCLE_ENTRY = fileURLToPath(new URL("./parent-lifecycle.mjs", import.meta.url));

function handleEntries(ctx) {
  return ctx?.sessionManager?.getBranch?.().filter((entry) => entry?.customType === HANDLE_TYPE).map((entry) => entry.data) ?? [];
}

function terminal(state) {
  return ["complete", "failed", "timedOut", "cancelled", "stopped"].includes(state);
}

function runtimeState(status) {
  const structured = status?.status?.kind === "stable" ? status.status.value?.state : status?.state;
  if (structured) return structured;
  const match = typeof status?.text === "string" && /^State:\s*(\S(?:.*\S)?)\s*$/m.exec(status.text);
  return match?.[1]?.trim();
}

function trustedStatusPath(stateRoot, handle) {
  const expected = path.resolve(stateRoot, "var", "plan-runs", handle.planId, "status.json");
  if (typeof handle.statusPath !== "string" || path.resolve(handle.statusPath) !== expected) {
    throw new Error("Plan handle status path is not trusted");
  }
}

async function concreteBase(originRoot) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const { stdout } = await run("git", ["rev-parse", "--verify", "HEAD^{commit}"], { cwd: originRoot });
  return stdout.trim();
}

function bootstrap(binding) {
  return `You are the dedicated Plan Runner. Your first action must be plan_open with this exact bootstrap JSON:\n${JSON.stringify(binding)}\nYou may create commits only in the dedicated plan branch. Do not merge or push.`;
}

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
  if (!request || typeof request !== "object" || Array.isArray(request) || typeof request.planPath !== "string" || !request.planPath.trim() || request.allowPlanCommits !== true) {
    throw new Error("noninteractive plan-run requires JSON with allowPlanCommits: true");
  }
  return { planPath: request.planPath, planId: request.planId ?? id() };
}

function validHandle(handle) {
  return HANDLE_FIELDS.every((field) => typeof handle[field] === "string" && handle[field]);
}

function persistedHandlePath(stateRoot, planId) {
  if (typeof planId !== "string" || !PLAN_ID.test(planId) || planId.includes("..")) throw new Error("Invalid planId");
  return path.resolve(stateRoot, "var", "plan-runs", planId, "parent-handle.json");
}

async function persistHandle(stateRoot, handle) {
  const destination = persistedHandlePath(stateRoot, handle.planId);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(handle), { mode: 0o600 });
  await rename(temporary, destination);
}

async function readPersistedHandle(stateRoot, planId) {
  const file = persistedHandlePath(stateRoot, planId);
  let handle;
  try {
    handle = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  if (!validHandle(handle) || handle.planId !== planId) throw new Error("Persisted Plan handle is invalid");
  trustedStatusPath(stateRoot, handle);
  const expectedWorktree = path.resolve(stateRoot, "var", "plan-worktrees", planId);
  if (path.resolve(handle.worktree) !== expectedWorktree) throw new Error("Persisted Plan worktree is not trusted");
  return handle;
}

async function defaultRuntimeStatus(asyncDir) {
  return JSON.parse(await readFile(path.join(asyncDir, "status.json"), "utf8"));
}

async function waitForSessionFile(readStatus, asyncDir, runId, { intervalMs = 50, timeoutMs = 5_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const status = await readStatus(asyncDir);
      if (status?.runId && status.runId !== runId) throw new Error("Plan runner status runId does not match spawn reply");
      const sessionFile = status?.sessionFile ?? status?.steps?.[0]?.sessionFile;
      if (typeof sessionFile === "string" && sessionFile) return sessionFile;
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Plan runner session artifact timed out");
}

async function waitForTerminalRuntime(readStatus, asyncDir, { intervalMs = 50, timeoutMs = 5_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const status = await readStatus(asyncDir);
      const state = runtimeState(status);
      if (terminal(state)) return state;
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Plan cancellation is not confirmed by a terminal artifact");
}

async function writePlanRunnerRuntimeWrapper(worktree, entry, lifecycle) {
  const wrapper = path.join(worktree, PLAN_RUNNER_RUNTIME_PATH);
  await mkdir(path.dirname(wrapper), { recursive: true });
  await writeFile(wrapper, `import planRunner from ${JSON.stringify(pathToFileURL(entry).href)};\nimport { startParentLeaseWatchdog } from ${JSON.stringify(pathToFileURL(PARENT_LIFECYCLE_ENTRY).href)};\nconst lifecycle = ${JSON.stringify(lifecycle)};\nexport default function (pi) {\n  startParentLeaseWatchdog(lifecycle);\n  planRunner(pi);\n}\n`);
  return wrapper;
}

export function createPlanLauncherExtension(pi, options = {}) {
  const originRoot = options.originRoot ?? process.cwd();
  const stateRoot = options.stateRoot ?? originRoot;
  const rpc = () => options.createRpcClient?.() ?? createSubagentsRpcClient(pi.events);
  const readRuntimeStatus = options.readRuntimeStatus ?? defaultRuntimeStatus;
  const planRunnerEntry = options.planRunnerEntry ?? DEFAULT_PLAN_RUNNER_ENTRY;
  const parentLeaseTimeoutMs = options.parentLeaseTimeoutMs ?? 5_000;
  const control = options.planControl ?? createPlanControl({
    stateRoot,
    id: options.id,
    intervalMs: options.pollIntervalMs,
    timeoutMs: options.cancelTimeoutMs,
  });
  const activeRuns = new Map();
  const releaseRun = async (run) => {
    if (!run || run.released) return;
    run.released = true;
    activeRuns.delete(run.handle.runId);
    const errors = [];
    try {
      await run.lease.stop();
    } catch (error) {
      errors.push(error);
    }
    try {
      await run.lease.remove();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, "Plan lease release failed");
  };
  const stopRun = async (run) => {
    const errors = [];
    try {
      await rpc().stop({ runId: run.handle.runId });
      await waitForTerminalRuntime(readRuntimeStatus, run.handle.asyncDir, {
        intervalMs: options.pollIntervalMs,
        timeoutMs: options.cancelTerminalTimeoutMs ?? options.cancelTimeoutMs,
      });
    } catch (error) {
      errors.push(error);
    }
    try {
      await releaseRun(run);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, `Plan ${run.handle.planId} stop failed`);
  };
  const getHandle = async (planId, ctx) => {
    const provided = await options.findHandle?.(planId, ctx);
    if (provided) return provided;
    return handleEntries(ctx).find((handle) => handle.planId === planId) ?? readPersistedHandle(stateRoot, planId);
  };

  async function launchPlan({ planPath, planId }, ctx = {}) {
    await access(planPath);
    const plan = parsePlanDocument(await readFile(planPath, "utf8"), planPath);
    if (await getHandle(planId, ctx)) throw new Error(`Plan already exists: ${planId}`);
    const baseCommit = options.readBaseCommit ? await options.readBaseCommit(originRoot) : await concreteBase(originRoot);
    let workspaceLease;
    let parentLease;
    let runtimeWrapper;
    try {
      workspaceLease = await (options.createWorkspace ?? createPlanWorkspace)({ originRoot, stateRoot, planId, baseCommit });
      const worktree = workspaceLease.workspacePath;
      const token = crypto.randomUUID();
      parentLease = (options.createParentLease ?? createParentLease)({
        stateRoot,
        planId,
        token,
        parentPid: process.pid,
        intervalMs: options.parentLeaseIntervalMs,
      });
      await parentLease.beat();
      runtimeWrapper = await writePlanRunnerRuntimeWrapper(worktree, planRunnerEntry, {
        leasePath: parentLease.path,
        planId,
        token,
        timeoutMs: parentLeaseTimeoutMs,
      });
      parentLease.start();
      const spawned = await rpc().spawn({
        agent: "plan-runner",
        task: bootstrap({ planId, planPath, planHash: plan.sha256, baseCommit, worktree, allowPlanCommits: true }),
        cwd: worktree,
        context: "fresh",
      });
      const details = spawned?.details;
      const result = details?.results?.[0] ?? {};
      const sessionFile = typeof result.sessionFile === "string" && result.sessionFile
        ? result.sessionFile
        : await waitForSessionFile(readRuntimeStatus, details?.asyncDir, details?.runId, {
          intervalMs: options.pollIntervalMs,
          timeoutMs: options.spawnTimeoutMs,
        });
      const handle = {
        planId,
        planHash: plan.sha256,
        runId: details?.runId,
        asyncDir: details?.asyncDir,
        sessionFile,
        statusPath: path.join(stateRoot, "var", "plan-runs", planId, "status.json"),
        worktree,
      };
      if (!validHandle(handle)) throw new Error("Plan runner returned an incomplete lifecycle handle");
      await (options.persistHandle ?? persistHandle)(stateRoot, handle);
      pi.appendEntry(HANDLE_TYPE, handle);
      activeRuns.set(handle.runId, { handle, lease: parentLease, released: false });
      ctx.ui?.notify?.(`${HANDLE_PREFIX}${JSON.stringify(handle)}`, "info");
      return handle;
    } catch (error) {
      if (parentLease) {
        await parentLease.stop();
        await parentLease.remove();
      }
      if (runtimeWrapper) await rm(runtimeWrapper, { force: true });
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
    description: "Launch an approved plan in a dedicated worktree via the plan-runner agent.",
    parameters: {
      type: "object",
      properties: { planPath: { type: "string", minLength: 1, description: "Path to the approved plan document" } },
      required: ["planPath"],
      additionalProperties: false,
    },
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const planId = options.id?.() ?? crypto.randomUUID();
        const handle = await launchPlan({ planPath: params.planPath, planId }, ctx);
        return { content: [{ type: "text", text: JSON.stringify(handle, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : "Plan launch failed." }], isError: true };
      }
    },
  });

  pi.registerCommand("plan-run", {
    description: "Run an approved plan in a dedicated worktree.",
    async handler(args, ctx = {}) {
      const request = runRequest(args, ctx, () => options.id?.() ?? crypto.randomUUID());
      if (interactive(ctx)) {
        if (typeof ctx.ui?.confirm !== "function" || !(await ctx.ui.confirm("Authorize plan commits", "Allow commits in the dedicated plan branch only; merge and push remain forbidden?"))) {
          throw new Error("Plan commit authorization was not confirmed");
        }
      }
      return launchPlan(request, ctx);
    },
  });

  pi.on?.("session_shutdown", async () => {
    const results = await Promise.allSettled([...activeRuns.values()].map(stopRun));
    const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, "Plan shutdown cleanup failed");
  });

  pi.registerCommand("plan-status", {
    description: "Read the Plan Session derived status.",
    async handler(planId, ctx = {}) {
      const handle = await getHandle(planId, ctx);
      if (!handle) throw new Error(`Unknown plan: ${planId}`);
      const status = JSON.parse(await readFile(handle.statusPath, "utf8"));
      ctx.ui?.notify?.(JSON.stringify(status), "info");
      return status;
    },
  });

  pi.registerCommand("plan-open", {
    description: "Open the Plan Session artifact.",
    async handler(planId, ctx = {}) {
      const handle = await getHandle(planId, ctx);
      if (!handle) throw new Error(`Unknown plan: ${planId}`);
      const artifact = { sessionFile: handle.sessionFile, statusPath: handle.statusPath };
      ctx.ui?.notify?.(JSON.stringify(artifact), "info");
      return artifact;
    },
  });

  pi.registerCommand("plan-pause", {
    description: "Interrupt a running Plan Session.",
    async handler(planId, ctx = {}) {
      const handle = await getHandle(planId, ctx);
      if (!handle) throw new Error(`Unknown plan: ${planId}`);
      return rpc().interrupt({ runId: handle.runId });
    },
  });

  pi.registerCommand("plan-cancel", {
    description: "Cancel a Plan Session after recording child intent.",
      async handler(planId, ctx = {}) {
        const handle = await getHandle(planId, ctx);
        if (!handle) throw new Error(`Unknown plan: ${planId}`);
        trustedStatusPath(stateRoot, handle);
        if (typeof options.recordCancelIntent === "function") await options.recordCancelIntent(handle);
        else await control.requestCancel(handle);
        const run = activeRuns.get(handle.runId);
        await rpc().stop({ runId: handle.runId });
        const rawState = await waitForTerminalRuntime(readRuntimeStatus, handle.asyncDir, {
          intervalMs: options.pollIntervalMs,
          timeoutMs: options.cancelTerminalTimeoutMs ?? options.cancelTimeoutMs,
        });
        if (run) await releaseRun(run);
        return `Plan ${planId} cancelled (upstream state: ${rawState}).`;
    },
  });

  pi.registerCommand("plan-recover", {
    description: "Reconcile an existing Plan Session without spawning.",
    async handler(planId, ctx = {}) {
      const handle = await getHandle(planId, ctx);
      if (!handle) throw new Error(`Unknown plan: ${planId}`);
      const status = await rpc().status({ runId: handle.runId });
      const recovery = {
        runId: handle.runId,
        asyncDir: handle.asyncDir,
        sessionFile: handle.sessionFile,
        worktree: handle.worktree,
        status,
      };
      if (!activeRuns.has(handle.runId) && !terminal(runtimeState(status))) {
        recovery.ownerState = "orphaned-owner";
        recovery.blocked = true;
      }
      ctx.ui?.notify?.(JSON.stringify(recovery), "info");
      return recovery;
    },
  });
}
