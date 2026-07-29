import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { allocateAttemptWorkspace as defaultAllocateAttemptWorkspace, releaseAttemptWorkspace as defaultReleaseAttemptWorkspace } from "./attempt-workspace.mjs";
import { validateAttemptResult as defaultValidateAttemptResult } from "./attempt-validator.mjs";
import { createIntegrationQueue } from "./integration-queue.mjs";
import { createPlanCoordinator } from "./coordinator.mjs";
import { parsePlanDocument } from "./plan-document.mjs";
import { createPlanStatus, writePlanStatus } from "./plan-projection.mjs";
import { readAttemptDisposition } from "./runtime-artifacts.mjs";
import { createPlanEventWriter } from "./plan-event-writer.mjs";
import { createProjection, applyEvent } from "./plan-events.mjs";
import { createTaskCommandRegistry, resolveTaskVerification, runPlanGates } from "./gates.mjs";
import { createPlanControl } from "./plan-control.mjs";

const execFile = promisify(execFileCallback);
const TERMINAL = new Set(["validated", "blocked", "cancelled", "interrupted"]);
const ATTENTION_KINDS = new Set(["interview_request", "need_decision", "scope_change", "contract_question", "external_side_effect", "user_preference", "progress_update"]);
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

async function git(cwd, ...args) {
  const { stdout } = await execFile("git", args, { cwd });
  return stdout.trim();
}

function events(ctx) {
  const branch = ctx?.sessionManager?.getBranch?.();
  if (!Array.isArray(branch)) throw new Error("Current session branch is unavailable.");
  return branch.filter((entry) => entry?.customType === "pi-plan-event-v1").map((entry) => entry.data).filter(Boolean);
}


async function writeAttentionBody({ stateRoot, planId, requestId, message }) {
  if (!IDENTITY.test(requestId) || requestId.includes("..")) throw new Error("Invalid Attention requestId");
  const relativePath = path.posix.join("attention", `${requestId}.md`);
  const file = path.join(stateRoot, "var", "plan-runs", planId, relativePath);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, message, { mode: 0o600 });
  await rename(temporary, file);
  return {
    bodyPath: relativePath,
    bodySha256: createHash("sha256").update(message).digest("hex"),
  };
}

function supervisorMessageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    return message.content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
  }
  return "";
}

async function validateWorkspaceRoots({ originRoot, stateRoot, planId, actualCwd }) {
  for (const [field, value] of Object.entries({ originRoot, stateRoot })) {
    if (typeof value !== "string" || value.trim() === "") throw new Error(`Plan ${field} binding is unavailable.`);
  }
  const [resolvedOrigin, resolvedState] = await Promise.all([realpath(originRoot), realpath(stateRoot)]);
  const expectedWorktree = await realpath(path.join(resolvedState, "var", "plan-worktrees", planId));
  if (expectedWorktree !== actualCwd) throw new Error("Plan stateRoot does not own the child worktree.");
  const [originTopLevel, originCommonDir, worktreeCommonDir] = await Promise.all([
    git(resolvedOrigin, "rev-parse", "--show-toplevel").then((value) => realpath(value)),
    git(resolvedOrigin, "rev-parse", "--path-format=absolute", "--git-common-dir").then((value) => realpath(value)),
    git(actualCwd, "rev-parse", "--path-format=absolute", "--git-common-dir").then((value) => realpath(value)),
  ]);
  if (originTopLevel !== resolvedOrigin) throw new Error("Plan originRoot is not a Git worktree root.");
  if (originCommonDir !== worktreeCommonDir) throw new Error("Plan originRoot does not own the child Git worktree.");
  return { originRoot: resolvedOrigin, stateRoot: resolvedState };
}

async function readBinding(input, ctx, configuredRoots) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid plan binding.");
  for (const field of ["planId", "planPath", "planHash", "baseCommit", "worktree"]) {
    if (typeof input[field] !== "string" || input[field].trim() === "") throw new Error(`Invalid ${field}.`);
  }
  if (input.allowPlanCommits !== true) throw new Error("Plan commit authorization is required.");
  if (typeof ctx?.cwd !== "string") throw new Error("Child working directory is unavailable.");
  const [actualCwd, declaredWorktree] = await Promise.all([realpath(ctx.cwd), realpath(input.worktree)]);
  if (actualCwd !== declaredWorktree) throw new Error("Plan binding worktree does not match child cwd.");
  const roots = await validateWorkspaceRoots({ ...configuredRoots, planId: input.planId, actualCwd });
  const source = await readFile(input.planPath, "utf8");
  const plan = parsePlanDocument(source, input.planPath);
  const effectiveHash = input.approvedHash ?? input.planHash;
  if (plan.sha256 !== effectiveHash) throw new Error("Plan hash does not match approved plan.");
  const [headCommit, resolvedBase, branch] = await Promise.all([
    git(actualCwd, "rev-parse", "HEAD^{commit}"),
    git(actualCwd, "rev-parse", "--verify", `${input.baseCommit}^{commit}`),
    git(actualCwd, "branch", "--show-current"),
  ]);
  if (resolvedBase !== input.baseCommit) throw new Error("Base commit must be a concrete matching commit.");
  if (headCommit !== input.baseCommit) throw new Error("Workspace HEAD must equal the base commit at startup.");
  if (branch !== `pi-plan/${input.planId}`) throw new Error("Plan worktree branch is not owned by planId.");
  return { ...input, worktree: actualCwd, ...roots, headCommit, tasks: plan.tasks, plan };
}

export function createPlanRunnerDependencies({
  pi,
  originRoot: configuredOriginRoot,
  stateRoot: configuredStateRoot,
  audit,
  externalReview,
  executionBackend,
  allocateAttemptWorkspace = defaultAllocateAttemptWorkspace,
  releaseAttemptWorkspace = defaultReleaseAttemptWorkspace,
  validateAttemptResult = defaultValidateAttemptResult,
  integrationOwnerToken = crypto.randomUUID(),
  takeExecutionFacts = () => [],
  id = () => crypto.randomUUID(),
  now = () => new Date().toISOString(),
  controlIntervalMs = 50,
} = {}) {
  const localEntries = [];
  let stoppingActiveRuns;
  let lastWorkspace;
  let lastCtx;
  const announcedAttentionReplies = new Set();
  const configuredRoots = { originRoot: configuredOriginRoot, stateRoot: configuredStateRoot };

  async function rootsFor(ctx, planId) {
    if (typeof ctx?.cwd !== "string") throw new Error("Child working directory is unavailable.");
    return validateWorkspaceRoots({
      ...configuredRoots,
      planId,
      actualCwd: await realpath(ctx.cwd),
    });
  }

  function combinedEvents(ctx) {
    const seen = new Set();
    return [...events(ctx), ...localEntries].filter((entry) => {
      if (seen.has(entry.eventId)) return false;
      seen.add(entry.eventId);
      return true;
    });
  }

  function currentProjection(ctx) {
    if (ctx) lastCtx = ctx;
    let value = createProjection();
    for (const entry of combinedEvents(ctx)) value = applyEvent(value, entry);
    return value;
  }

  const writer = createPlanEventWriter({
    readEntries: async () => combinedEvents(lastCtx),
    append: async (entry) => {
      if (pi?.appendEntry) await pi.appendEntry("pi-plan-event-v1", entry);
      localEntries.push(entry);
    },
    id,
    now,
  });

  async function appendEvent(ctx, type, data, expectedProjectionVersion) {
    const current = currentProjection(ctx);
    const expected = expectedProjectionVersion ?? current.version;
    return writer.append({ expectedProjectionVersion: expected, planId: current.planId, type, data });
  }

  async function derivedStatus(ctx) {
    const current = currentProjection(ctx);
    if (!current.planId) throw new Error("Plan is not open.");
    const status = createPlanStatus({ entries: combinedEvents(ctx) });
    const { stateRoot } = await rootsFor(ctx, current.planId);
    await writePlanStatus({ stateRoot, status });
    return status;
  }

  async function approvedPlan(current) {
    const source = await readFile(current.workspace.planPath, "utf8").catch(() => undefined);
    if (!source) throw new Error("Approved plan artifact is unavailable.");
    const plan = parsePlanDocument(source, current.workspace.planPath);
    if (plan.sha256 !== current.workspace.planHash) throw new Error("Approved plan hash no longer matches the binding.");
    return plan;
  }

  async function coordinatorFor(ctx) {
    const current = currentProjection(ctx);
    const plan = await approvedPlan(current);
    const { stateRoot } = await rootsFor(ctx, current.planId);
    const resultsDir = path.join(stateRoot, "var", "plan-runs", current.planId, "results");
    await mkdir(resultsDir, { recursive: true });
    const commandRegistry = await createTaskCommandRegistry({ cwd: current.workspace.worktree, plan });
    const coordinator = createPlanCoordinator({
      plan,
      entries: combinedEvents(ctx),
      writer,
      readEntries: async () => combinedEvents(ctx),
      allocateWorkspace: allocateAttemptWorkspace,
      backend: executionBackend,
      stateRoot,
      outputForAttempt: (attemptId) => path.join(resultsDir, `${attemptId}.json`),
      readAttemptDisposition,
      readAttemptHead: (lease) => git(lease.path, "rev-parse", "HEAD^{commit}"),
      validateAttemptResult,
      verificationForTask: (taskId) => resolveTaskVerification({ plan, taskId, registry: commandRegistry }),
      integrationOwnerToken,
      id,
      now,
    }).coordinator;
    const taskById = new Map(plan.tasks.map((task) => [task.id, task]));
    const projection = coordinator.projection();
    const queue = createIntegrationQueue({
      accumulator: current.workspace.worktree,
      integrationOwnerToken,
      nodeOrder: plan.tasks.map((task) => task.id),
      integratedTaskIds: [...projection.tasks.entries()]
        .filter(([, task]) => ["accepted", "integrated"].includes(task.status))
        .map(([taskId]) => taskId),
      isPlanActive: () => !TERMINAL.has(coordinator.projection().lifecycle),
      append: (type, data) => coordinator.appendIntegrationEvent(type, data),
      releaseWorkspace: async (attempt) => {
        await coordinator.appendIntegrationEvent("attempt.workspace-released", {
          attemptId: attempt.attemptId,
          disposition: "integrated-cleanup",
          evidence: { kind: "integration-cleanup", resultCommit: attempt.resultCommit },
        });
        await derivedStatus(ctx);
        await releaseAttemptWorkspace(attempt.workspace, {
          ownerToken: attempt.workspace.ownerToken,
          disposition: "integrated-cleanup",
        });
      },
    });
    coordinator.setIntegrationQueue(queue);
    for (const [attemptId, attempt] of projection.attempts) {
      if (attempt.status !== "validated") continue;
      const task = taskById.get(attempt.taskId);
      queue.enqueue({
        planId: projection.planId,
        taskId: attempt.taskId,
        attemptId,
        resultCommit: attempt.resultCommit,
        diffSha256: attempt.validationDiffSha256,
        changedPaths: attempt.validationChangedPaths,
        evidence: attempt.validationEvidence,
        validationHash: attempt.validationHash,
        workspace: attempt.workspace,
        integration: attempt.integration ? { ...attempt.integration } : undefined,
        deps: [...(task?.deps ?? [])],
      });
    }
    return coordinator;
  }

  async function consumeExecutionFacts(ctx) {
    const facts = takeExecutionFacts();
    if (!Array.isArray(facts) || facts.length === 0) return null;
    const current = currentProjection(ctx);
    const violation = facts.find((fact) => fact?.type === "execution.protocol-violation");
    if (violation) {
      await appendEvent(ctx, "plan.blocked", { reason: "execution_protocol_violation", code: violation.code }, current.version);
      return { state: "blocked", projectionVersion: currentProjection(ctx).version };
    }
    const coordinator = await coordinatorFor(ctx);
    return coordinator.recover({ facts });
  }

  function controlFor(binding) {
    return createPlanControl({ stateRoot: binding.stateRoot, id, now });
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
    await appendEvent(ctx, "plan.cancelled", { reason: "parent_cancel", requestId: request.requestId }, current.version);
    await derivedStatus(ctx);
    const ack = { ...request, lifecycle: "cancelled", result: "accepted", occurredAt: now() };
    await control.writeAck(ack);
    return ack;
  }

  async function processAttentionReplies({ binding, ctx }) {
    const current = currentProjection(ctx);
    const commands = await controlFor(binding).readAttentionReplies(binding.planId);
    const ready = [];
    for (const command of commands) {
      const attempt = current.attempts.get(command.attemptId);
      if (!attempt || attempt.status !== "waiting-attention"
        || attempt.attention?.requestId !== command.requestId
        || attempt.runId !== command.runId) continue;
      if (command.expectedProjectionVersion !== attempt.attention.projectionVersion) continue;
      if (announcedAttentionReplies.has(command.requestId)) continue;
      await pi?.sendMessage?.(
        {
          customType: "pi-plan-attention-reply-v1",
          content: command.message,
          details: {
            planId: command.planId,
            taskId: command.taskId,
            attemptId: command.attemptId,
            runId: command.runId,
            requestId: command.requestId,
            expectedProjectionVersion: command.expectedProjectionVersion,
          },
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
      announcedAttentionReplies.add(command.requestId);
      ready.push(command);
    }
    return ready;
  }

  return {
    appendPlanEvent: appendEvent,
    async validateBinding(input, { ctx }) {
      const binding = await readBinding(input, ctx, configuredRoots);
      lastWorkspace = binding.worktree;
      return binding;
    },
    processCancelControl,
    async recordSupervisorRequest(message, { ctx }) {
      const details = message?.details;
      const requestId = details?.id;
      if (!details || !IDENTITY.test(requestId ?? "") || !IDENTITY.test(details.runId ?? "")
        || details.agent !== "executor" || !Number.isInteger(details.childIndex) || details.childIndex < 0) {
        throw new Error("Invalid native Supervisor request identity");
      }
      const body = supervisorMessageText(message);
      if (!body.trim() || Buffer.byteLength(body, "utf8") > 64 * 1024) throw new Error("Invalid native Supervisor request body");
      let current = currentProjection(ctx);
      const match = [...current.attempts.entries()].find(([, attempt]) => attempt.status === "active" && attempt.runId === details.runId);
      if (!match) throw new Error("Native Supervisor request does not match an active Attempt");
      const [attemptId, attempt] = match;
      const { stateRoot } = await rootsFor(ctx, current.planId);
      const evidence = await writeAttentionBody({ stateRoot, planId: current.planId, requestId, message: body });
      const kind = ATTENTION_KINDS.has(details.reason) ? details.reason : "need_decision";
      await appendEvent(ctx, "attempt.attention-requested", {
        requestId,
        taskId: attempt.taskId,
        attemptId,
        runId: attempt.runId,
        kind,
        message: body,
        projectionVersion: current.version + 1,
        createdAt: now(),
        evidence,
      }, current.version);
      current = currentProjection(ctx);
      if (kind !== "progress_update") {
        await appendEvent(ctx, "attempt.attention-escalated", {
          attemptId,
          requestId,
          runId: attempt.runId,
          expectedProjectionVersion: current.version,
          evidence,
        }, current.version);
      }
      await derivedStatus(ctx);
      return { requestId, attemptId, runId: attempt.runId, projectionVersion: currentProjection(ctx).version, evidence };
    },
    async authorizeSupervisorReply(input, { ctx }) {
      if (input?.action !== "reply" || !IDENTITY.test(input.replyTo ?? "")
        || typeof input.message !== "string" || !input.message.trim()
        || Buffer.byteLength(input.message, "utf8") > 64 * 1024) {
        throw new Error("Invalid Supervisor reply");
      }
      const current = currentProjection(ctx);
      const match = [...current.attempts.entries()].find(([, attempt]) =>
        attempt.status === "waiting-attention" && attempt.attention?.requestId === input.replyTo
      );
      if (!match) throw new Error("Supervisor reply does not match pending Attention");
      const [attemptId, attempt] = match;
      const { stateRoot } = await rootsFor(ctx, current.planId);
      const control = createPlanControl({ stateRoot, id, now });
      const commands = await control.readAttentionReplies(current.planId);
      const command = commands.find((candidate) => candidate.requestId === input.replyTo);
      if (!command) throw new Error("Durable Root Attention reply is required before native Supervisor delivery");
      if (command.attemptId !== attemptId || command.runId !== attempt.runId
        || command.expectedProjectionVersion !== attempt.attention.projectionVersion || command.message !== input.message) {
        throw new Error("Durable Attention reply command is stale or does not match");
      }
      return {
        planId: current.planId,
        taskId: attempt.taskId,
        attemptId,
        requestId: input.replyTo,
        runId: attempt.runId,
        expectedProjectionVersion: current.version,
        resolutionSha256: createHash("sha256").update(input.message).digest("hex"),
        command,
      };
    },
    async resolveSupervisorReply(authorization, { ctx }) {
      const current = currentProjection(ctx);
      if (authorization?.expectedProjectionVersion !== current.version) throw new Error("Supervisor reply projection version is stale");
      await appendEvent(ctx, "attempt.attention-resolved", {
        attemptId: authorization.attemptId,
        requestId: authorization.requestId,
        runId: authorization.runId,
        expectedProjectionVersion: authorization.expectedProjectionVersion,
        resolutionSha256: authorization.resolutionSha256,
      }, current.version);
      if (authorization.command) {
        const { stateRoot } = await rootsFor(ctx, current.planId);
        const control = createPlanControl({ stateRoot, id, now });
        await control.writeAttentionAck({ ...authorization.command, result: "delivered", deliveredAt: now() });
      }
      announcedAttentionReplies.delete(authorization.requestId);
      await derivedStatus(ctx);
      return { resolved: true, requestId: authorization.requestId, projectionVersion: currentProjection(ctx).version };
    },
    processAttentionReplies,
    startPlanControl({ binding, ctx }) {
      let processing = false;
      const timer = setInterval(async () => {
        if (processing) return;
        processing = true;
        try {
          await processCancelControl({ binding, ctx });
          await processAttentionReplies({ binding, ctx });
        } catch {}
        finally { processing = false; }
      }, controlIntervalMs);
      timer.unref?.();
      return () => clearInterval(timer);
    },
    async status({ ctx }) {
      await consumeExecutionFacts(ctx);
      return derivedStatus(ctx);
    },
    canContinue(current) {
      return Boolean(current?.planId && !TERMINAL.has(current.lifecycle) && ["created", "running"].includes(current.lifecycle));
    },
    async getHeadCommit() {
      if (!lastWorkspace) throw new Error("Plan worktree is unknown");
      return git(lastWorkspace, "rev-parse", "HEAD");
    },
    async blockPlan({ reason }, { ctx }) {
      if (typeof reason !== "string" || !reason.trim()) throw new Error("Block reason is required.");
      const current = currentProjection(ctx);
      await appendEvent(ctx, "plan.blocked", { reason }, current.version);
      return derivedStatus(ctx);
    },
    async continuePlan(input = {}, { ctx }) {
      const current = currentProjection(ctx);
      if (!current.planId || TERMINAL.has(current.lifecycle)) throw new Error("Plan cannot continue.");
      if (input.expectedProjectionVersion !== undefined && input.expectedProjectionVersion !== current.version) {
        throw new Error(`Projection version conflict: expected ${input.expectedProjectionVersion}, current ${current.version}`);
      }
      const coordinator = await coordinatorFor(ctx);
      const result = await coordinator.dispatchAuthorized();
      await derivedStatus(ctx);
      return result;
    },
    async recoverExecutors({ facts = [] } = {}, { ctx }) {
      const coordinator = await coordinatorFor(ctx);
      const result = await coordinator.recover({ facts });
      await derivedStatus(ctx);
      return result;
    },
    async collectExecutorResults({ facts = [] } = {}, { ctx }) {
      const coordinator = await coordinatorFor(ctx);
      const result = await coordinator.recover({ facts });
      await derivedStatus(ctx);
      return result;
    },
    stopActiveRuns({ ctx } = {}) {
      if (stoppingActiveRuns) return stoppingActiveRuns;
      const effectiveCtx = ctx ?? lastCtx;
      if (!effectiveCtx || !executionBackend?.stop) return Promise.resolve([]);
      const current = currentProjection(effectiveCtx);
      const targets = [...current.attempts.values()]
        .filter((attempt) => ["active", "waiting-attention"].includes(attempt.status) && attempt.runId && attempt.asyncDir)
        .map((attempt) => ({ runId: attempt.runId, asyncDir: attempt.asyncDir }));
      stoppingActiveRuns = Promise.allSettled(targets.map((target) => executionBackend.stop(target))).then((results) => {
        const errors = results.filter((entry) => entry.status === "rejected").map((entry) => entry.reason);
        if (errors.length) throw new AggregateError(errors, "Stopping active executor runs failed");
        return results;
      });
      return stoppingActiveRuns;
    },
    async verifyPlan({ ctx }) {
      const current = currentProjection(ctx);
      if (!current.planId) throw new Error("Plan is not open.");
      const plan = await approvedPlan(current);
      let next = current;
      const headCommit = await git(current.workspace.worktree, "rev-parse", "HEAD^{commit}");
      if (headCommit !== next.workspace.headCommit) {
        await appendEvent(ctx, "workspace.head-observed", { headCommit }, next.version);
        next = currentProjection(ctx);
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
        await appendEvent(ctx, "gate.finished", attempt, next.version);
        next = currentProjection(ctx);
      }
      if (result.validated) {
        await appendEvent(ctx, "plan.validated", { worktreeClean: true }, next.version);
        next = currentProjection(ctx);
      }
      await derivedStatus(ctx);
      return result;
    },
  };
}
