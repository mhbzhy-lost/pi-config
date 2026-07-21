import { readFile, realpath } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { createPlanCoordinator } from "./coordinator.mjs";
import { parsePlanDocument } from "./plan-document.mjs";
import { createPlanStatus, writePlanStatus } from "./plan-projection.mjs";
import { createProjection, applyEvent } from "./plan-events.mjs";
import { runPlanGates } from "./gates.mjs";
import { createPlanControl } from "./plan-control.mjs";
import { readRuntimeArtifacts as defaultReadRuntimeArtifacts } from "./runtime-artifacts.mjs";
import { createSubagentsRpcClient } from "../subagents-rpc-client.mjs";

const execFile = promisify(execFileCallback);
const TERMINAL = new Set(["validated", "blocked", "cancelled", "interrupted"]);

async function git(cwd, ...args) {
  const { stdout } = await execFile("git", args, { cwd });
  return stdout.trim();
}

function events(ctx) {
  const branch = ctx?.sessionManager?.getBranch?.();
  if (!Array.isArray(branch)) throw new Error("Current session branch is unavailable.");
  return branch.filter((entry) => entry?.customType === "pi-plan-event-v1").map((entry) => entry.data).filter(Boolean);
}

function projection(ctx) {
  let value = createProjection();
  for (const entry of events(ctx)) value = applyEvent(value, entry);
  return value;
}

function append(pi, entry) {
  pi?.appendEntry?.("pi-plan-event-v1", entry);
}

function eventFor(current, type, data, id, now) {
  return {
    schemaVersion: "pi-plan-event.v1",
    eventId: id(),
    planId: current.planId,
    occurredAt: now(),
    type,
    data,
  };
}

function sameTool(left, right) {
  return ["agent", "cwd", "context", "async", "clarify"].every((field) => left?.[field] === right?.[field]);
}

async function stateRootFor(cwd) {
  const commonDir = await git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
  return path.dirname(commonDir);
}

async function readBinding(input, ctx) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid plan binding.");
  for (const field of ["planId", "planPath", "planHash", "baseCommit", "worktree"]) {
    if (typeof input[field] !== "string" || input[field].trim() === "") throw new Error(`Invalid ${field}.`);
  }
  if (input.allowPlanCommits !== true) throw new Error("Plan commit authorization is required.");
  if (typeof ctx?.cwd !== "string") throw new Error("Child working directory is unavailable.");
  const [actualCwd, declaredWorktree] = await Promise.all([realpath(ctx.cwd), realpath(input.worktree)]);
  if (actualCwd !== declaredWorktree) throw new Error("Plan binding worktree does not match child cwd.");
  const source = await readFile(input.planPath, "utf8");
  const plan = parsePlanDocument(source, input.planPath);
  if (plan.sha256 !== input.planHash) throw new Error("Plan hash does not match approved plan.");
  const [headCommit, resolvedBase, branch, commonDir] = await Promise.all([
    git(actualCwd, "rev-parse", "HEAD^{commit}"),
    git(actualCwd, "rev-parse", "--verify", `${input.baseCommit}^{commit}`),
    git(actualCwd, "branch", "--show-current"),
    git(actualCwd, "rev-parse", "--path-format=absolute", "--git-common-dir"),
  ]);
  if (resolvedBase !== input.baseCommit) throw new Error("Base commit must be a concrete matching commit.");
  if (headCommit !== input.baseCommit) throw new Error("Workspace HEAD must equal the base commit at startup.");
  if (branch !== `pi-plan/${input.planId}`) throw new Error("Plan worktree branch is not owned by planId.");
  const originRoot = path.dirname(commonDir);
  return { ...input, worktree: actualCwd, originRoot, headCommit, tasks: plan.tasks, plan };
}

export function createPlanRunnerDependencies({ pi, audit, externalReview, taskReview, readRuntimeArtifacts = defaultReadRuntimeArtifacts, runtimePollIntervalMs = 50, runtimePollTimeoutMs = 300_000, id = () => crypto.randomUUID(), now = () => new Date().toISOString(), controlIntervalMs = 50, stopNestedRun } = {}) {
  let pendingCoordinator;
  let stoppingActiveRuns;
  const activeRuns = new Map();
  const localEntries = [];
  function combinedEvents(ctx) {
    const seen = new Set();
    return [...events(ctx), ...localEntries].filter((entry) => {
      if (seen.has(entry.eventId)) return false;
      seen.add(entry.eventId);
      return true;
    });
  }
  function currentProjection(ctx) {
    let value = createProjection();
    for (const entry of combinedEvents(ctx)) value = applyEvent(value, entry);
    return value;
  }
  function appendLocal(entry) {
    localEntries.push(entry);
    append(pi, entry);
  }
  async function derivedStatus(ctx) {
    const current = currentProjection(ctx);
    if (!current.planId) throw new Error("Plan is not open.");
    const status = createPlanStatus({ entries: combinedEvents(ctx) });
    await writePlanStatus({ stateRoot: await stateRootFor(ctx.cwd), status });
    return status;
  }
  async function waitForRuntimeOutcome(asyncDir) {
    const deadline = Date.now() + runtimePollTimeoutMs;
    while (true) {
      const artifacts = await readRuntimeArtifacts({ artifactDir: asyncDir });
      const status = artifacts?.status;
      const state = status?.kind === "stable" ? status.value?.state : undefined;
      if (state === "complete") return "succeeded";
      if (state === "failed") return "failed";
      if (state === "paused") return "interrupted";
      if (Date.now() >= deadline) return undefined;
      await new Promise((resolve) => setTimeout(resolve, runtimePollIntervalMs));
    }
  }
  function strictReview(result) {
    return result
      && typeof result === "object"
      && !Array.isArray(result)
      && result.accepted === true
      && Array.isArray(result.findings)
      && result.findings.length === 0
      && Object.keys(result).every((key) => ["accepted", "findings"].includes(key));
  }
  function controlFor(binding) {
    return createPlanControl({ stateRoot: binding.originRoot, id, now });
  }
  async function processCancelControl({ binding, ctx }) {
    const control = controlFor(binding);
    const request = await control.readRequest(binding.planId);
    if (!request) return null;
    const current = currentProjection(ctx);
    if (current.lifecycle === "cancelled") {
      const ack = { ...request, lifecycle: "cancelled", result: "accepted", occurredAt: now() };
      await control.writeAck(ack);
      return ack;
    }
    if (TERMINAL.has(current.lifecycle)) {
      const ack = { ...request, lifecycle: "rejected", result: "terminal", occurredAt: now() };
      await control.writeAck(ack);
      return ack;
    }
    const entry = eventFor(current, "plan.cancelled", { reason: "parent_cancel", requestId: request.requestId }, id, now);
    applyEvent(current, entry);
    appendLocal(entry);
    await derivedStatus(ctx);
    const ack = { ...request, lifecycle: "cancelled", result: "accepted", occurredAt: now() };
    await control.writeAck(ack);
    return ack;
  }
  async function defaultStopNestedRun({ runId }) {
    const rpc = createSubagentsRpcClient(pi.events);
    try {
      await rpc.stop({ runId });
    } finally {
      rpc.dispose();
    }
  }

  return {
    validateBinding(input, { ctx }) {
      return readBinding(input, ctx);
    },
    processCancelControl,
    stopActiveRuns() {
      if (stoppingActiveRuns) return stoppingActiveRuns;
      const runs = [...activeRuns.values()];
      activeRuns.clear();
      stoppingActiveRuns = Promise.allSettled(runs.map((run) => (stopNestedRun ?? defaultStopNestedRun)(run))).then((results) => {
        const errors = results.filter((entry) => entry.status === "rejected").map((entry) => entry.reason);
        if (errors.length) throw new AggregateError(errors, "Stopping active nested runs failed");
      });
      return stoppingActiveRuns;
    },
    startPlanControl({ binding, ctx }) {
      let processing = false;
      const timer = setInterval(async () => {
        if (processing) return;
        processing = true;
        try { await processCancelControl({ binding, ctx }); } catch {}
        finally { processing = false; }
      }, controlIntervalMs);
      timer.unref?.();
      return () => clearInterval(timer);
    },
    async status({ ctx }) {
      return derivedStatus(ctx);
    },
    canContinue(current) {
      return Boolean(current?.planId && !TERMINAL.has(current.lifecycle) && ["created", "running"].includes(current.lifecycle));
    },
    async getHeadCommit() {
      const proj = localEntries.reduce((p, e) => applyEvent(p, e), createProjection());
      if (!proj.workspace?.worktree) throw new Error("Plan worktree is unknown");
      return git(proj.workspace.worktree, "rev-parse", "HEAD");
    },
    async blockPlan({ reason }, { ctx }) {
      if (typeof reason !== "string" || !reason.trim()) throw new Error("Block reason is required.");
      const current = currentProjection(ctx);
      const entry = eventFor(current, "plan.blocked", { reason }, id, now);
      applyEvent(current, entry);
      appendLocal(entry);
      return derivedStatus(ctx);
    },
    async continuePlan(_input, { ctx }) {
      const current = currentProjection(ctx);
      if (!current.planId || TERMINAL.has(current.lifecycle)) throw new Error("Plan cannot continue.");
      const source = await readFile(current.workspace.planPath, "utf8").catch(() => undefined);
      if (!source) throw new Error("Approved plan artifact is unavailable.");
      const plan = parsePlanDocument(source, current.workspace.planPath);
      if (plan.sha256 !== current.workspace.planHash) throw new Error("Approved plan hash no longer matches the binding.");
      pendingCoordinator = createPlanCoordinator({ plan, entries: combinedEvents(ctx), append: appendLocal, id, now }).coordinator;
      return pendingCoordinator.authorizeNext();
    },
    authorizeNestedSubagent(tool, { ctx }) {
      if (!pendingCoordinator) throw new Error("No nested subagent dispatch is authorized.");
      return pendingCoordinator.authorizeNestedSubagent(tool);
    },
    async handleNestedResult(event, { ctx }) {
      if (event?.toolName !== "subagent" || event?.isError === true || !event?.details || typeof event.details.runId !== "string" || event.details.runId === "") {
        return { state: "ignored" };
      }
      const current = currentProjection(ctx);
      const requested = [...current.attempts.entries()].find(([, attempt]) => attempt.status === "dispatch-requested");
      if (!requested) return { state: "ignored" };
      const [attemptId, attempt] = requested;
      if (!pendingCoordinator) {
        const source = await readFile(current.workspace.planPath, "utf8");
        const plan = parsePlanDocument(source, current.workspace.planPath);
        pendingCoordinator = createPlanCoordinator({ plan, entries: combinedEvents(ctx), append: appendLocal, id, now }).coordinator;
      }
      if (!sameTool(event.input, attempt.tool)) return { state: "ignored" };
       const bound = pendingCoordinator.bindNestedResult(event);
       activeRuns.set(event.details.runId, { runId: event.details.runId, asyncDir: event.details.asyncDir });
       let outcome = bound.terminalOutcome;
      if (!outcome && typeof event.details.asyncDir === "string" && event.details.asyncDir !== "") {
        outcome = await waitForRuntimeOutcome(event.details.asyncDir);
      }
       if (!outcome) {
        await derivedStatus(ctx);
        return { state: "active" };
       }
       activeRuns.delete(event.details.runId);
       pendingCoordinator.settleBoundAttempt(outcome);
      if (outcome !== "succeeded") {
        await derivedStatus(ctx);
        return { state: outcome };
      }
      const next = currentProjection(ctx);
      const settledAttempt = next.attempts.get(attemptId);
      let review;
      let reviewSkipped = false;
      try {
        review = typeof taskReview === "function" ? await taskReview({ taskId: attempt.taskId, attempt: { attemptId, ...settledAttempt }, projection: next, ctx }) : undefined;
      } catch {
        review = undefined;
      }
      if (!strictReview(review)) {
        if (typeof taskReview === "function") {
          await derivedStatus(ctx);
          return { state: "awaiting-review" };
        }
        reviewSkipped = true;
      }
      pendingCoordinator.acceptReviewedTask(attempt.taskId);
      await derivedStatus(ctx);
      return { state: "succeeded", reviewSkipped };
    },
    async verifyPlan({ ctx }) {
      const current = currentProjection(ctx);
      if (!current.planId) throw new Error("Plan is not open.");
      const plan = parsePlanDocument(await readFile(current.workspace.planPath, "utf8"), current.workspace.planPath);
      if (plan.sha256 !== current.workspace.planHash) throw new Error("Approved plan hash no longer matches the binding.");
      let next = current;
      const headCommit = await git(current.workspace.worktree, "rev-parse", "HEAD^{commit}");
      if (headCommit !== next.workspace.headCommit) {
        const entry = eventFor(next, "workspace.head-observed", { headCommit }, id, now);
        next = applyEvent(next, entry);
        appendLocal(entry);
      }
      const result = await runPlanGates({
        cwd: current.workspace.worktree,
        baseCommit: next.workspace.baseCommit,
        projection: next,
        commands: plan.verification,
        audit,
        externalReview,
      });
      for (const attempt of result.attempts) {
        const entry = eventFor(next, "gate.finished", attempt, id, now);
        next = applyEvent(next, entry);
        appendLocal(entry);
      }
      if (result.validated) {
        const entry = eventFor(next, "plan.validated", { worktreeClean: true }, id, now);
        applyEvent(next, entry);
        appendLocal(entry);
      }
      await derivedStatus(ctx);
      return result;
    },
  };
}
