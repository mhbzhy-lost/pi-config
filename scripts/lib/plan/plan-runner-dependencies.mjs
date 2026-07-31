import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { allocateAttemptWorkspace as defaultAllocateAttemptWorkspace, inspectAttemptWorkspace as defaultInspectAttemptWorkspace, releaseAttemptWorkspace as defaultReleaseAttemptWorkspace } from "./attempt-workspace.mjs";
import { validateAttemptResult as defaultValidateAttemptResult } from "./attempt-validator.mjs";
import { createIntegrationQueue } from "./integration-queue.mjs";
import { createPlanCoordinator } from "./coordinator.mjs";
import { createPlanStatus, writePlanStatus } from "./plan-projection.mjs";
import { readAttemptDisposition } from "./runtime-artifacts.mjs";
import { createPlanEventWriter } from "./plan-event-writer.mjs";
import { createProjection, applyEvent } from "./plan-events.mjs";
import { createTaskCommandRegistry, resolveTaskVerification, runPlanGates } from "./gates.mjs";
import { createPlanControl } from "./plan-control.mjs";
import { createPlanRevisionStore } from "./plan-revision-store.mjs";
import { assertCurrentRevisionIdentity, createPlanAmendmentService } from "./plan-amendment.mjs";

const execFile = promisify(execFileCallback);
const TERMINAL = new Set(["validated", "blocked", "cancelled", "interrupted"]);
const ATTENTION_KINDS = new Set(["interview_request", "need_decision", "scope_change", "contract_question", "external_side_effect", "user_preference", "progress_update"]);
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BINDING_KEYS = ["allowPlanCommits", "baseCommit", "manifestSha256", "planId", "planIrHash", "revision", "worktree"];
const SHA256 = /^[0-9a-f]{64}$/;

function requireExactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) throw new Error(`Invalid ${label}.`);
}

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

async function readBinding(input, ctx, configuredRoots, revisionStore) {
  requireExactKeys(input, BINDING_KEYS, "plan binding");
  for (const field of ["planId", "manifestSha256", "planIrHash", "baseCommit", "worktree"]) if (typeof input[field] !== "string" || input[field].trim() === "") throw new Error(`Invalid ${field}.`);
  if (!SHA256.test(input.manifestSha256) || !SHA256.test(input.planIrHash)) throw new Error("Invalid plan revision hash.");
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw new Error("Invalid revision.");
  if (input.allowPlanCommits !== true) throw new Error("Plan commit authorization is required.");
  if (typeof ctx?.cwd !== "string") throw new Error("Child working directory is unavailable.");
  const [actualCwd, declaredWorktree] = await Promise.all([realpath(ctx.cwd), realpath(input.worktree)]);
  if (actualCwd !== declaredWorktree) throw new Error("Plan binding worktree does not match child cwd.");
  const roots = await validateWorkspaceRoots({ ...configuredRoots, planId: input.planId, actualCwd });
  if (!revisionStore || typeof revisionStore.readRevision !== "function") throw new Error("Plan revision store is unavailable.");
  const revision = await revisionStore.readRevision(input.planId, input.revision);
  if (!revision || revision.planId !== input.planId || revision.revision !== input.revision
    || revision.manifestSha256 !== input.manifestSha256 || revision.manifest?.planId !== input.planId
    || revision.manifest?.revision !== input.revision || revision.manifest.irHash !== input.planIrHash
    || revision.ir?.version !== revision.manifest.irVersion || revision.ir?.hash !== revision.manifest.irHash
    || !Array.isArray(revision.plan?.tasks)) throw new Error("Plan revision does not match binding.");
  const plan = revision.plan;
  const [headCommit, resolvedBase, branch] = await Promise.all([
    git(actualCwd, "rev-parse", "HEAD^{commit}"), git(actualCwd, "rev-parse", "--verify", `${input.baseCommit}^{commit}`), git(actualCwd, "branch", "--show-current"),
  ]);
  if (resolvedBase !== input.baseCommit) throw new Error("Base commit must be a concrete matching commit.");
  if (headCommit !== input.baseCommit) throw new Error("Workspace HEAD must equal the base commit at startup.");
  if (branch !== `pi-plan/${input.planId}`) throw new Error("Plan worktree branch is not owned by planId.");
  return { ...input, worktree: actualCwd, ...roots, headCommit, tasks: plan.tasks, plan, planPath: revision.planPath, planHash: revision.manifest.planHash, revision, revisionIdentity: { number: revision.revision, manifestSha256: revision.manifestSha256, sourceBytesSha256: revision.manifest.sourceBytesSha256, planHash: revision.manifest.planHash, irVersion: revision.manifest.irVersion, irHash: revision.manifest.irHash, taskHashes: revision.manifest.taskHashes } };
}

export function createPlanRunnerDependencies({
  pi,
  originRoot: configuredOriginRoot,
  stateRoot: configuredStateRoot,
  audit,
  externalReview,
  executionBackend,
  allocateAttemptWorkspace = defaultAllocateAttemptWorkspace,
  inspectAttemptWorkspace = defaultInspectAttemptWorkspace,
  releaseAttemptWorkspace = defaultReleaseAttemptWorkspace,
  validateAttemptResult = defaultValidateAttemptResult,
  integrationQueueFactory = createIntegrationQueue,
  integrationOwnerToken = crypto.randomUUID(),
  takeExecutionFacts = () => [],
  id = () => crypto.randomUUID(),
  now = () => new Date().toISOString(),
  controlIntervalMs = 50,
  planControlFactory = createPlanControl,
  revisionStore = createPlanRevisionStore({ stateRoot: configuredStateRoot }),
  legacyDirectDispatch = false,
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

  function matchingAttentionResolution(ctx, command, { expectedProjectionVersion } = {}) {
    const resolutionSha256 = createHash("sha256").update(command.message).digest("hex");
    let projection = createProjection();
    for (const entry of combinedEvents(ctx)) {
      if (entry.type === "attempt.attention-resolved") {
        const attempt = projection.attempts.get(command.attemptId);
        if (entry.planId === command.planId
          && entry.data?.requestId === command.requestId
          && entry.data?.attemptId === command.attemptId
          && entry.data?.runId === command.runId
          && entry.data?.resolutionSha256 === resolutionSha256
          && (expectedProjectionVersion === undefined || entry.data?.expectedProjectionVersion === expectedProjectionVersion)
          && attempt?.status === "waiting-attention"
          && attempt.taskId === command.taskId
          && attempt.runId === command.runId
          && attempt.attention?.requestId === command.requestId
          && attempt.attention.status === "pending"
          && attempt.attention.projectionVersion === command.expectedProjectionVersion) return true;
      }
      projection = applyEvent(projection, entry);
    }
    return false;
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

  async function appendEvent(ctx, type, data, expectedProjectionVersion, planId) {
    const current = currentProjection(ctx);
    const expected = expectedProjectionVersion ?? current.version;
    return writer.append({ expectedProjectionVersion: expected, planId: current.planId ?? planId, type, data });
  }

  async function derivedStatus(ctx) {
    const current = currentProjection(ctx);
    if (!current.planId) throw new Error("Plan is not open.");
    const status = createPlanStatus({ entries: combinedEvents(ctx) });
    const { stateRoot } = await rootsFor(ctx, current.planId);
    await writePlanStatus({ stateRoot, status });
    return status;
  }

  async function readCurrentRevision({ ctx } = {}) {
    const projection = currentProjection(ctx);
    if (!projection?.revision || !projection?.planId) throw new Error("Plan current revision is unavailable.");
    const current = assertCurrentRevisionIdentity(
      await revisionStore.readRevision(projection.planId, projection.revision.number), projection,
    );
    if (!Buffer.isBuffer(current.sourceBytes) && !(current.sourceBytes instanceof Uint8Array)) throw new Error("Plan current revision source is unavailable.");
    const source = Buffer.from(current.sourceBytes).toString("utf8");
    if (Buffer.from(source, "utf8").compare(Buffer.from(current.sourceBytes)) !== 0) throw new Error("Plan current revision source is not valid UTF-8.");
    return { revision: current.revision, planHash: current.manifest.planHash, irHash: current.manifest.irHash, source };
  }

  async function releaseSupersededWorkspace(attemptId, { ctx } = {}) {
    const projection = currentProjection(ctx);
    const attempt = projection.attempts.get(attemptId);
    if (!attempt || attempt.workspaceReleased || attempt.status !== "superseded") return;
    let clean = false;
    if (attempt.supersedeProof?.kind === "never-started" && !attempt.resultCommit) {
      try { clean = (await inspectAttemptWorkspace(attempt.workspace)).clean === true; } catch {}
    }
    const disposition = clean ? "superseded-cleanup" : "superseded-preserve";
    await appendEvent(ctx, "attempt.workspace-released", { attemptId, disposition, evidence: { kind: disposition } }, projection.version);
    await derivedStatus(ctx);
    await releaseAttemptWorkspace(attempt.workspace, { ownerToken: attempt.workspace.ownerToken, disposition });
  }

  async function supersedeAttempt({ attemptId, expectedTaskHash }, { ctx } = {}) {
    let projection = currentProjection(ctx);
    const attempt = projection.attempts.get(attemptId);
    if (!attempt || attempt.status !== "supersede-requested" || attempt.supersededTaskHash !== expectedTaskHash
      || attempt.supersededByRevision !== projection.revision?.number) throw new Error("Attempt supersede cleanup identity is stale.");
    let evidence;
    if (attempt.supersededFromStatus === "workspace-allocated") {
      evidence = { kind: "never-started", dispatchId: null };
    } else {
      if (!executionBackend?.supersede) throw new Error("Execution supersede capability is unavailable.");
      try {
        evidence = await executionBackend.supersede({ dispatchId: attempt.dispatchId, attemptId });
      } catch (error) {
        if (error?.code !== "EXECUTION_DISPATCH_NOT_FOUND") throw error;
        if (attempt.supersededFromStatus === "dispatch-requested") {
          if (typeof executionBackend.recoverDispatch !== "function") throw new Error("Execution dispatch recovery capability is unavailable.");
          const request = { dispatchId: attempt.dispatchId, attemptId, agent: attempt.tool?.agent, task: attempt.tool?.task, cwd: attempt.tool?.cwd, output: attempt.tool?.output, timeoutMs: attempt.tool?.timeoutMs };
          if (Object.values(request).some((value) => value === undefined || value === null)) throw new Error("Persisted execution dispatch recovery data is incomplete.");
          await executionBackend.recoverDispatch(request);
        } else {
          if (typeof executionBackend.recoverBinding !== "function") throw new Error("Execution binding recovery capability is unavailable.");
          if (!attempt.sessionFile || !attempt.runId || !attempt.asyncDir || !attempt.tool?.output) throw new Error("Persisted execution binding recovery data is incomplete.");
          await executionBackend.recoverBinding({ dispatchId: attempt.dispatchId, attemptId, runId: attempt.runId, asyncDir: attempt.asyncDir, cwd: attempt.tool.cwd, output: attempt.tool.output, sessionId: attempt.sessionFile, sessionFile: attempt.sessionFile });
        }
        evidence = await executionBackend.supersede({ dispatchId: attempt.dispatchId, attemptId });
      }
    }
    projection = currentProjection(ctx);
    const latest = projection.attempts.get(attemptId);
    if (!latest || latest.status !== "supersede-requested" || latest.supersededTaskHash !== expectedTaskHash || latest.supersededByRevision !== projection.revision.number) throw new Error("Attempt supersede cleanup changed during proof.");
    await appendEvent(ctx, "attempt.superseded", { attemptId, taskId: latest.taskId, supersededByRevision: projection.revision.number, oldTaskHash: expectedTaskHash, evidence }, projection.version);
    await releaseSupersededWorkspace(attemptId, { ctx });
  }

  async function recoverSupersededAttempts({ ctx } = {}) {
    const projection = currentProjection(ctx);
    if (!projection?.revision || !projection.planId) return;
    const errors = [];
    try {
      const committed = assertCurrentRevisionIdentity(await revisionStore.readRevision(projection.planId, projection.revision.number), projection);
      let current;
      try { current = await revisionStore.readCurrent?.(projection.planId); } catch {}
      if (!current || current.revision !== committed.revision || current.manifestSha256 !== committed.manifestSha256
        || current.manifest?.irHash !== committed.manifest.irHash) await revisionStore.writeCurrent(committed);
    } catch (error) { errors.push(error); }
    for (const [attemptId, attempt] of [...currentProjection(ctx).attempts].sort(([a], [b]) => a.localeCompare(b))) {
      if (attempt.workspaceReleased || !["supersede-requested", "superseded"].includes(attempt.status)) continue;
      try {
        if (attempt.status === "superseded") {
          await releaseSupersededWorkspace(attemptId, { ctx });
        } else await supersedeAttempt({ attemptId, expectedTaskHash: attempt.supersededTaskHash }, { ctx });
      } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Superseded Attempt recovery failed");
  }

  function executionRecoveryOperation(attemptId, attempt) {
    if (attempt.status === "dispatch-requested") {
      if (typeof executionBackend?.recoverDispatch !== "function") throw new Error("Execution dispatch recovery capability is unavailable.");
      const request = { dispatchId: attempt.dispatchId, attemptId, agent: attempt.tool?.agent, task: attempt.tool?.task, cwd: attempt.tool?.cwd, output: attempt.tool?.output, timeoutMs: attempt.tool?.timeoutMs };
      if (Object.values(request).some((value) => value === undefined || value === null)) throw new Error("Persisted execution dispatch recovery data is incomplete.");
      return () => executionBackend.recoverDispatch(request);
    }
    if (!["active", "waiting-attention"].includes(attempt.status)) return null;
    if (typeof executionBackend?.recoverBinding !== "function") throw new Error("Execution binding recovery capability is unavailable.");
    const binding = { dispatchId: attempt.dispatchId, attemptId, runId: attempt.runId, asyncDir: attempt.asyncDir, cwd: attempt.tool?.cwd, output: attempt.tool?.output, sessionId: attempt.sessionFile, sessionFile: attempt.sessionFile };
    if (Object.values(binding).some((value) => typeof value !== "string" || value.length === 0)) throw new Error("Persisted execution binding recovery data is incomplete.");
    return () => executionBackend.recoverBinding(binding);
  }

  async function recoverExecutionState({ ctx } = {}) {
    let projection;
    try {
      projection = currentProjection(ctx);
    } catch (error) {
      if (error instanceof Error && error.message === "invalid sessionFile") {
        throw new Error("Persisted execution binding recovery data is incomplete.");
      }
      throw error;
    }
    const operations = [...projection.attempts]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([attemptId, attempt]) => executionRecoveryOperation(attemptId, attempt))
      .filter(Boolean);
    for (const recover of operations) await recover();
  }

  async function approvedPlan(current) {
    if (current.revision) {
      const revision = await revisionStore.readRevision(current.planId, current.revision.number);
      if (!revision || revision.manifestSha256 !== current.revision.manifestSha256 || revision.manifest.irHash !== current.revision.irHash) {
        throw new Error("Approved plan revision is unavailable.");
      }
      return revision.plan;
    }
    const source = await readFile(current.workspace.planPath, "utf8").catch(() => undefined);
    if (!source) throw new Error("Approved plan artifact is unavailable.");
    const { parsePlanDocument } = await import("./plan-document.mjs");
    const plan = parsePlanDocument(source, current.workspace.planPath);
    if (plan.sha256 !== current.workspace.planHash) throw new Error("Approved plan hash no longer matches the binding.");
    return plan;
  }

  async function coordinatorFor(ctx) {
    const current = currentProjection(ctx);
    let plan;
    let ir;
    if (current.revision) {
      const revision = assertCurrentRevisionIdentity(await revisionStore.readRevision(current.planId, current.revision.number), current);
      if (revision.manifest.planHash !== current.revision.planHash || revision.ir.version !== revision.manifest.irVersion
        || revision.ir.hash !== revision.manifest.irHash) throw new Error("Current compiled Plan IR is unavailable.");
      plan = revision.plan;
      ir = revision.ir;
    } else {
      plan = await approvedPlan(current);
      const { compilePlanToIR } = await import("./ir/index.mjs");
      ir = compilePlanToIR(plan);
    }
    const { stateRoot } = await rootsFor(ctx, current.planId);
    const resultsDir = path.join(stateRoot, "var", "plan-runs", current.planId, "results");
    await mkdir(resultsDir, { recursive: true });
    let commandRegistry;
    const verificationForTask = async (taskId) => {
      commandRegistry ??= createTaskCommandRegistry({ cwd: current.workspace.worktree, ir, legacyPlan: plan });
      return resolveTaskVerification({ ir, legacyPlan: plan, taskId, registry: await commandRegistry });
    };
    const coordinator = createPlanCoordinator({
      ir,
      entries: combinedEvents(ctx),
      writer,
      readEntries: async () => combinedEvents(ctx),
      readProjection: () => currentProjection(ctx),
      allocateWorkspace: allocateAttemptWorkspace,
      inspectWorkspace: inspectAttemptWorkspace,
      backend: executionBackend,
      stateRoot,
      outputForAttempt: (attemptId) => path.join(resultsDir, `${attemptId}.json`),
      readAttemptDisposition,
      readAttemptHead: (lease) => git(lease.path, "rev-parse", "HEAD^{commit}"),
      validateAttemptResult,
      verificationForTask,
      integrationOwnerToken,
      id,
      now,
    }).coordinator;
    const taskById = new Map(plan.tasks.map((task) => [task.id, task]));
    const projection = coordinator.projection();
    const queue = integrationQueueFactory({
      accumulator: current.workspace.worktree,
      integrationOwnerToken,
      nodeOrder: current.revision && ir.version === "plan-ir.v3"
        ? ir.nodes.map((node) => node.id)
        : plan.tasks.map((task) => task.id),
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
        deps: current.revision ? (ir.nodes.find((node) => node.id === attempt.taskId)?.dependencies ?? []).map(({ taskId }) => taskId) : [...(task?.deps ?? [])],
      });
    }
    return coordinator;
  }

  function resolvedSupersedeStopViolation(current, fact) {
    if (fact?.type !== "execution.protocol-violation" || fact.code !== "SUPERSEDE_STOP_FAILED") return false;
    if (![fact.attemptId, fact.dispatchId, fact.runId, fact.asyncDir].every((value) => typeof value === "string" && value.length > 0)) return false;
    const attempt = current.attempts.get(fact.attemptId);
    const proof = attempt?.supersedeProof;
    return attempt?.dispatchId === fact.dispatchId
      && attempt.status === "superseded"
      && attempt.workspaceReleased === true
      && proof?.kind === "terminal"
      && proof.dispatchId === fact.dispatchId
      && proof.runId === fact.runId
      && proof.asyncDir === fact.asyncDir
      && attempt.runId === fact.runId
      && attempt.asyncDir === fact.asyncDir;
  }

  async function consumeExecutionFacts(ctx) {
    const facts = takeExecutionFacts();
    if (!Array.isArray(facts) || facts.length === 0) return null;
    const current = currentProjection(ctx);
    const unresolvedFacts = facts.filter((fact) => !resolvedSupersedeStopViolation(current, fact));
    const violation = unresolvedFacts.find((fact) => fact?.type === "execution.protocol-violation");
    if (violation) {
      await appendEvent(ctx, "plan.blocked", { reason: "execution_protocol_violation", code: violation.code }, current.version);
      return { state: "blocked", projectionVersion: currentProjection(ctx).version };
    }
    const coordinator = await coordinatorFor(ctx);
    return coordinator.recover({ facts: unresolvedFacts });
  }

  function controlFor(binding) {
    return planControlFactory({ stateRoot: binding.stateRoot, id, now });
  }

  async function processCancelControl({ binding, ctx }) {
    const control = controlFor(binding);
    const request = await control.readRequest(binding.planId);
    if (!request) return null;
    await recoverSupersededAttempts({ ctx });
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
    const control = controlFor(binding);
    const commands = await control.readAttentionReplies(binding.planId);
    const ready = [];
    for (const command of commands) {
      if (matchingAttentionResolution(ctx, command)) {
        await control.writeAttentionAck({ ...command, result: "delivered", deliveredAt: now() });
        announcedAttentionReplies.delete(command.requestId);
        continue;
      }
      const attempt = current.attempts.get(command.attemptId);
      if (command.planId !== binding.planId || !attempt || attempt.status !== "waiting-attention"
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
    readCurrentRevision,
    amendPlan: (input, { ctx }) => createPlanAmendmentService({ revisionStore, eventWriter: writer, currentProjection: () => currentProjection(ctx), supersedeAttempt: (input) => supersedeAttempt(input, { ctx }) }).amend(input),
    recoverExecutionState,
    recoverSupersededAttempts,
    writeCurrentRevision: (revision) => revisionStore.writeCurrent(revision),
    async validateBinding(input, { ctx }) {
      const binding = await readBinding(input, ctx, configuredRoots, revisionStore);
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
      const control = planControlFactory({ stateRoot, id, now });
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
      const command = authorization?.command;
      if (!command || command.planId !== authorization.planId || command.taskId !== authorization.taskId
        || command.attemptId !== authorization.attemptId || command.requestId !== authorization.requestId
        || command.runId !== authorization.runId
        || createHash("sha256").update(command.message ?? "").digest("hex") !== authorization.resolutionSha256) {
        throw new Error("Supervisor reply authorization command does not match");
      }
      if (authorization.planId !== current.planId) throw new Error("Supervisor reply plan does not match");
      if (!matchingAttentionResolution(ctx, command, { expectedProjectionVersion: authorization.expectedProjectionVersion })) {
        if (authorization.expectedProjectionVersion !== current.version) throw new Error("Supervisor reply projection version is stale");
        await appendEvent(ctx, "attempt.attention-resolved", {
          attemptId: authorization.attemptId,
          requestId: authorization.requestId,
          runId: authorization.runId,
          expectedProjectionVersion: authorization.expectedProjectionVersion,
          resolutionSha256: authorization.resolutionSha256,
        }, current.version);
      }
      const { stateRoot } = await rootsFor(ctx, current.planId);
      const control = planControlFactory({ stateRoot, id, now });
      await control.writeAttentionAck({ ...command, result: "delivered", deliveredAt: now() });
      announcedAttentionReplies.delete(authorization.requestId);
      await derivedStatus(ctx);
      return { resolved: true, requestId: authorization.requestId, projectionVersion: currentProjection(ctx).version };
    },
    async bindExecutorDispatch(input, { ctx }) {
      const coordinator = await coordinatorFor(ctx);
      const result = await coordinator.bindAuthorizedDispatch(input);
      await derivedStatus(ctx);
      return result;
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
      await recoverSupersededAttempts({ ctx });
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
      await recoverSupersededAttempts({ ctx });
      const current = currentProjection(ctx);
      await appendEvent(ctx, "plan.blocked", { reason }, current.version);
      return derivedStatus(ctx);
    },
    async continuePlan(input = {}, { ctx }) {
      await recoverSupersededAttempts({ ctx });
      const current = currentProjection(ctx);
      if (!current.planId || TERMINAL.has(current.lifecycle)) throw new Error("Plan cannot continue.");
      if (input.expectedProjectionVersion !== undefined && input.expectedProjectionVersion !== current.version) {
        throw new Error(`Projection version conflict: expected ${input.expectedProjectionVersion}, current ${current.version}`);
      }
      const coordinator = await coordinatorFor(ctx);
      const result = current.revision && legacyDirectDispatch !== true
        ? await coordinator.prepareAuthorizedDispatches()
        : await coordinator.dispatchAuthorized();
      await derivedStatus(ctx);
      return result;
    },
    async recoverExecutors({ facts = [] } = {}, { ctx }) {
      await recoverSupersededAttempts({ ctx });
      const coordinator = await coordinatorFor(ctx);
      const result = await coordinator.recover({ facts });
      await derivedStatus(ctx);
      return result;
    },
    async collectExecutorResults({ facts = [] } = {}, { ctx }) {
      await recoverSupersededAttempts({ ctx });
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
      await recoverSupersededAttempts({ ctx });
      const current = currentProjection(ctx);
      if (!current.planId) throw new Error("Plan is not open.");
      const plan = await approvedPlan(current);
      const revision = current.revision
        ? assertCurrentRevisionIdentity(await revisionStore.readRevision(current.planId, current.revision.number), current)
        : undefined;
      const commands = revision?.ir?.version === "plan-ir.v3" ? revision.ir.verification.commands : plan.verification;
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
        commands,
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
