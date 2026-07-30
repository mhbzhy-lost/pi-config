import { createHash } from "node:crypto";

import { createPlanEventWriter } from "./plan-event-writer.mjs";
import { applyEvent, createProjection } from "./plan-events.mjs";
import { authorizedFrontier } from "./ir/frontier.mjs";
import { selectExecutionView, selectSchedulingView } from "./ir/views.mjs";
import { hashValidatedAttempt } from "./integration-queue.mjs";
import { compileCodingDispatchIR } from "../subagent-dispatch/ir.ts";

function sha256(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function replay(entries) {
  let projection = createProjection();
  for (const entry of entries) projection = applyEvent(projection, entry);
  return projection;
}

function assertCompiledIR(ir) {
  if (!ir || !["plan-ir.v1", "plan-ir.v2", "plan-ir.v3"].includes(ir.version)) {
    throw new Error("compiled Plan IR is required");
  }
  return ir;
}

function legacyExecutionView(ir, taskId) {
  const task = ir.nodes.find((node) => node.id === taskId);
  if (!task) throw new Error(`unknown IR task: ${taskId}`);
  return { task };
}

function collectDependencyReceipts(projection, task) {
  const receipts = [];
  for (const dependency of task.dependencies ?? []) {
    const integrated = [...projection.attempts.entries()]
      .filter(([, attempt]) => attempt.taskId === dependency.taskId && attempt.status === "integrated");
    if (integrated.length !== 1) throw new Error(`integrated dependency receipt is unavailable: ${dependency.taskId}`);
    const [, attempt] = integrated[0];
    const resultCommit = attempt.resultCommit;
    const integratedHead = attempt.integration?.newHead;
    if (typeof resultCommit !== "string" || !resultCommit || typeof integratedHead !== "string" || !integratedHead) {
      throw new Error(`integrated dependency receipt is incomplete: ${dependency.taskId}`);
    }
    const changedPaths = attempt.validationChangedPaths;
    const evidence = attempt.validationEvidence;
    if (!Array.isArray(changedPaths) || !Array.isArray(evidence)) throw new Error(`integrated dependency receipt is incomplete: ${dependency.taskId}`);
    receipts.push(Object.freeze({
      taskId: dependency.taskId,
      resultCommit,
      integratedHead,
      changedPaths: Object.freeze([...changedPaths]),
      verificationSummary: Object.freeze(evidence
        .filter((entry) => entry?.kind === "command")
        .map((entry) => Object.freeze({ commandId: entry.commandId, exitCode: entry.exitCode }))),
    }));
  }
  return Object.freeze(receipts);
}

function buildExecutionPrompt(view, { attemptId, baseCommit, output, receipts }) {
  const { plan, task } = view;
  const blockedResult = JSON.stringify({ attempt_id: attemptId, task_id: task.id, status: "blocked", reason: "<code>", blockers: ["<sorted-code>"], changed_files: [], commit: null });
  if (!plan) return [
    `Execute plan task ${task.id}: ${task.title}.`,
    ...((task.allowedPaths ?? task.files ?? []).length ? [`Allowed paths: ${(task.allowedPaths ?? task.files).join(", ")}`] : []),
    "Commit all changes in the attempt worktree when done.",
    "If an approved fail-closed prerequisite requires stopping without task file changes or a commit, write this JSON shape to the authoritative output:", blockedResult,
    "An optional artifact object may contain a sha256 evidence digest. Never include secrets, credentials, URLs, or local paths.",
  ].join("\n");
  return [
    `Plan: ${plan.title}`,
    `Plan instructions:\n${plan.instructions}`,
    `Task: ${task.id} ${task.title}`,
    `Task body:\n${task.body}`,
    `Dependency receipts:\n${JSON.stringify(receipts)}`,
    `Allowed paths: ${task.allowedPaths.join(", ")}`,
    `Resources: ${JSON.stringify(task.resources)}`,
    `Execution: ${JSON.stringify(task.execution)}`,
    `Acceptance: ${task.acceptance.strategy}`,
    JSON.stringify(task.acceptance),
    `Attempt: ${attemptId}`,
    `Base commit: ${baseCommit}`,
    `Authoritative output: ${output}`,
    `Result contract: ${plan.executionPolicy.resultContract}`,
    `Blocked result shape: ${blockedResult}`,
  ].join("\n");
}

function nextAttemptId(projection, taskId) {
  const sequence = [...projection.attempts.values()].filter((attempt) => attempt.taskId === taskId).length + 1;
  return `attempt-${projection.planId}-${taskId}-${sequence}`;
}

function runtimeState(artifacts) {
  return artifacts?.status?.kind === "stable" ? artifacts.status.value?.state : undefined;
}

function terminalOutcome(state) {
  if (state === "complete" || state === "completed") return "succeeded";
  if (["failed", "stopped"].includes(state)) return "failed";
  if (state === "paused") return "interrupted";
  return undefined;
}

function activeAttempts(projection) {
  return [...projection.attempts.entries()]
    .filter(([, attempt]) => ["active", "waiting-attention"].includes(attempt.status))
    .map(([attemptId, attempt]) => ({ attemptId, ...attempt }));
}

function requestedAttempts(projection) {
  return [...projection.attempts.entries()]
    .filter(([, attempt]) => attempt.status === "dispatch-requested")
    .map(([attemptId, attempt]) => ({ attemptId, ...attempt }));
}

function attemptsForTask(projection, taskId) {
  return [...projection.attempts.entries()]
    .filter(([, attempt]) => attempt.taskId === taskId)
    .map(([attemptId, attempt]) => ({ attemptId, ...attempt }));
}

function stateFor(projection) {
  if (projection.lifecycle === "blocked") return "blocked";
  if ([...projection.tasks.values()].every((task) => ["accepted", "integrated", "retired"].includes(task.status))) return "ready-to-verify";
  if ([...projection.attempts.values()].some((attempt) => ["succeeded", "validated", "integration-requested"].includes(attempt.status))) {
    return "ready-to-integrate";
  }
  if (activeAttempts(projection).length > 0 || requestedAttempts(projection).length > 0) return "waiting-executors";
  return "waiting-resources";
}

function chunkText(value) {
  const chunks = [];
  let chunk = "";
  for (const point of value) {
    if (Buffer.byteLength(chunk + point, "utf8") > 4096) {
      if (!chunk || chunks.length === 32) throw new Error("dispatch contract text exceeds capacity");
      chunks.push(chunk);
      chunk = point;
    } else chunk += point;
  }
  if (chunk) chunks.push(chunk);
  if (chunks.length > 32) throw new Error("dispatch contract text exceeds capacity");
  return chunks;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
}

function dispatchWorkflow(execution) {
  const workflow = execution?.workflow;
  if (!workflow || workflow.mode === "inherit-repository" || workflow.mode === "tdd") return { mode: "tdd" };
  return { mode: workflow.mode, reason: workflow.reason };
}

function sourceContract(view, { cwd, receipts, legacyTimeout }) {
  const { plan, task } = view;
  const verification = plan?.verification?.commands ?? [];
  const selected = task.acceptance?.strategy === "commands"
    ? verification.filter((entry) => task.acceptance.commandIds.includes(entry.id))
    : verification;
  const commands = selected.map((entry) => entry.cwd === "." ? entry.command : `cd -- ${shellQuote(entry.cwd)} && ${entry.command}`);
  const criteria = task.acceptance?.strategy === "commands"
    ? [`Selected verification commands for ${task.id}.`]
    : [JSON.stringify(task.acceptance ?? { strategy: "manual" })];
  const requirements = chunkText(task.body || task.title);
  const instructions = plan ? chunkText(`Plan instructions:\n${plan.instructions}`) : [];
  const receiptFacts = receipts.map((receipt) => JSON.stringify(receipt));
  const timeoutMs = task.execution?.timeoutMs ?? legacyTimeout;
  return {
    version: "dispatch-ir.v1",
    taskId: task.id,
    title: task.title,
    agent: task.execution?.agent ?? task.agent ?? "executor",
    risk: task.execution?.risk ?? "normal",
    objective: task.title,
    workflow: dispatchWorkflow(task.execution),
    requirements,
    context: { knownFacts: [...instructions, ...receiptFacts], decisions: [], relevantFiles: [...(task.allowedPaths ?? task.files ?? [])] },
    boundaries: { writePaths: [...(task.allowedPaths ?? task.files ?? [])], excludedWork: [], forbiddenActions: [] },
    acceptance: { criteria, commands: commands.length ? commands : ["git diff --check"] },
    execution: { cwd, timeoutMs },
  };
}

function canonicalContract(compiled) {
  const { hash, ...contract } = compiled;
  return contract;
}


export function createPlanCoordinator({
  ir,
  entries,
  append,
  writer: suppliedWriter,
  readEntries,
  readProjection,
  allocateWorkspace,
  backend,
  stateRoot,
  outputForAttempt = (attemptId) => `${stateRoot}/var/plan-runs/results/${attemptId}.json`,
  readAttemptDisposition,
  readAttemptHead,
  validateAttemptResult,
  verificationForTask = async () => [],
  integrationQueue: initialIntegrationQueue,
  integrationOwnerToken,
  timeoutMs = 900_000,
  id = () => crypto.randomUUID(),
  now = () => new Date().toISOString(),
} = {}) {
  if (!Array.isArray(entries) || (typeof append !== "function" && !suppliedWriter)) throw new Error("entries and append are required");
  if (readProjection !== undefined && typeof readProjection !== "function") throw new Error("readProjection must be a function");
  assertCompiledIR(ir);
  const localEntries = [...entries];
  const writer = suppliedWriter ?? createPlanEventWriter({
    readEntries: readEntries ?? (async () => localEntries),
    append: async (entry) => { await append(entry); localEntries.push(entry); },
    id,
    now,
  });
  let projection = replay(localEntries);
  let integrationQueue = initialIntegrationQueue;

  function setProjection(value) {
    if (!value || typeof value !== "object" || !Number.isInteger(value.version)
      || !(value.tasks instanceof Map) || !(value.attempts instanceof Map)) {
      throw new Error("readProjection must return a plan projection");
    }
    projection = value;
    return projection;
  }

  function refreshProjectionSync() {
    if (readProjection) setProjection(readProjection());
    return projection;
  }

  async function refreshProjection() {
    if (readProjection) return refreshProjectionSync();
    return setProjection(replay(await (readEntries ?? (async () => localEntries))()));
  }

  async function appendEvent(type, data) {
    await refreshProjection();
    const entry = await writer.append({
      expectedProjectionVersion: projection.version,
      planId: projection.planId,
      type,
      data,
    });
    await refreshProjection();
    return entry;
  }

  async function block(reason, detail) {
    await refreshProjection();
    if (projection.lifecycle !== "blocked") await appendEvent("plan.blocked", { reason, ...(detail ? { detail } : {}) });
    return {
      state: "blocked",
      dispatched: [],
      projectionVersion: projection.version,
    };
  }

  async function stopSpawnedBinding(binding, originalError) {
    try {
      await backend.stop?.({ runId: binding.runId, asyncDir: binding.asyncDir });
    } catch (stopError) {
      if (originalError) throw new AggregateError([originalError, stopError], "binding persistence and executor cleanup failed");
      throw stopError;
    }
    if (originalError) throw originalError;
  }

  async function bindOrCleanupSpawnedAttempt({ attemptId, taskId, dispatchId, binding }) {
    const bound = {
      attemptId,
      taskId,
      dispatchId,
      runId: binding.runId,
      asyncDir: binding.asyncDir,
      sessionFile: binding.sessionFile ?? null,
    };
    for (;;) {
      await refreshProjection();
      if (["blocked", "cancelled", "validated", "interrupted"].includes(projection.lifecycle)) {
        await stopSpawnedBinding(binding);
        return { state: projection.lifecycle };
      }
      const attempt = projection.attempts.get(attemptId);
      const sameBinding = attempt && ["active", "waiting-attention"].includes(attempt.status)
        && attempt.dispatchId === dispatchId && attempt.runId === binding.runId && attempt.asyncDir === binding.asyncDir;
      if (sameBinding) return { state: null };
      const requested = attempt?.status === "dispatch-requested"
        && attempt.taskId === taskId && attempt.dispatchId === dispatchId;
      if (!requested) {
        await stopSpawnedBinding(binding);
        return await block("protocol_violation", { attemptId, dispatchId });
      }
      try {
        await appendEvent("attempt.bound", bound);
        return { state: null };
      } catch (error) {
        await refreshProjection();
        if (error?.code === "PROJECTION_CONFLICT") continue;
        await stopSpawnedBinding(binding, error);
      }
    }
  }

  async function settleBoundAttempt(outcome, attemptId) {
    await refreshProjection();
    if (["blocked", "cancelled", "validated", "interrupted"].includes(projection.lifecycle)) {
      throw new Error("Plan cannot settle attempts");
    }
    const attempt = projection.attempts.get(attemptId);
    if (!attempt || attempt.status !== "active") throw new Error(`no bound active attempt: ${attemptId}`);
    let resultCommit;
    if (outcome === "succeeded" && typeof readAttemptDisposition === "function") {
      const disposition = await readAttemptDisposition({
        attemptId,
        taskId: attempt.taskId,
        output: outputForAttempt(attemptId),
      });
      if (disposition?.status === "blocked") {
        await appendEvent("attempt.settled", {
          attemptId,
          outcome: "blocked",
          blockerReason: disposition.reason,
          blockers: disposition.blockers,
          ...(disposition.evidenceSha256 ? { evidenceSha256: disposition.evidenceSha256 } : {}),
        });
        const detail = {
          attemptId,
          taskId: attempt.taskId,
          blockerReason: disposition.reason,
          blockers: disposition.blockers,
          ...(disposition.evidenceSha256 ? { evidenceSha256: disposition.evidenceSha256 } : {}),
        };
        await block("executor_blocked", detail);
        return {
          attemptId,
          outcome: "blocked",
          resultCommit: null,
          validation: null,
          projectionVersion: projection.version,
        };
      }
    }
    if (outcome === "succeeded") {
      if (typeof readAttemptHead !== "function") throw new Error("readAttemptHead is required to settle a successful attempt");
      resultCommit = await readAttemptHead(attempt.workspace);
      if (typeof resultCommit !== "string" || !resultCommit) throw new Error("successful attempt HEAD is unavailable");
    }
    await appendEvent("attempt.settled", { attemptId, outcome, ...(resultCommit ? { resultCommit } : {}) });
    let validation = null;
    if (outcome === "succeeded" && typeof validateAttemptResult === "function") {
      const node = ir.nodes.find((candidate) => candidate.id === attempt.taskId);
      const attemptLease = {
        ...attempt.workspace,
        planId: projection.planId,
        taskId: attempt.taskId,
        attemptId,
        baseCommit: attempt.baseCommit,
      };
      validation = await validateAttemptResult({
        lease: attemptLease,
        allowedPaths: node.allowedPaths ?? node.files,
        verification: await verificationForTask(node.id),
      });
      if (!validation?.accepted) {
        await block("attempt_validation_failed", { attemptId, code: validation?.code ?? "invalid_result" });
      } else {
        const validatedAttempt = {
          planId: projection.planId,
          taskId: attempt.taskId,
          attemptId,
          resultCommit: validation.resultCommit,
          diffSha256: validation.diffSha256,
          changedPaths: validation.changedPaths,
          evidence: validation.evidence,
          workspace: attemptLease,
          deps: ir.version === "plan-ir.v3" ? node.dependencies.map(({ taskId }) => taskId) : [...node.deps],
        };
        validatedAttempt.validationHash = hashValidatedAttempt(validatedAttempt);
        await appendEvent("attempt.validated", {
          attemptId,
          resultCommit: validation.resultCommit,
          validationHash: validatedAttempt.validationHash,
          diffSha256: validation.diffSha256,
          changedPaths: validation.changedPaths,
          evidence: validation.evidence,
        });
        integrationQueue?.enqueue(validatedAttempt);
      }
    }
    return { attemptId, outcome, resultCommit: resultCommit ?? null, validation, projectionVersion: projection.version };
  }

  async function prepareAuthorizedDispatches() {
    await refreshProjection();
    if (!projection.planId || ["blocked", "cancelled", "validated", "interrupted"].includes(projection.lifecycle)) {
      throw new Error("Plan cannot dispatch executors");
    }
    if (typeof allocateWorkspace !== "function") throw new Error("Attempt workspace allocator is required");
    if (integrationQueue) {
      const integration = await integrationQueue.drain({ expectedHead: projection.workspace.headCommit, ownerToken: integrationOwnerToken });
      if (integration?.state === "blocked") return { state: "blocked", dispatches: [], projectionVersion: projection.version };
      await refreshProjection();
    }

    const replayed = [];
    for (const attempt of requestedAttempts(projection)) {
      const contract = attempt.tool?.contract;
      if (!contract) throw new Error(`dispatch intent contract is missing: ${attempt.attemptId}`);
      const compiled = compileCodingDispatchIR(contract, { cwd: projection.workspace.originRoot });
      const expected = projection.revision?.taskHashes[attempt.taskId];
      const contextHash = sha256({
        planIrHash: attempt.planIrHash, taskHash: attempt.taskHash, schedulingHash: attempt.schedulingHash,
        attemptId: attempt.attemptId, baseCommit: attempt.baseCommit, output: attempt.tool.output,
        dependencyReceipts: attempt.tool.dependencyReceipts ?? [],
      });
      if (compiled.hash !== attempt.toolHash || compiled.execution.cwd !== attempt.workspace.path
        || (projection.revision && (attempt.planIrHash !== projection.revision.irHash
          || attempt.taskHash !== expected?.effective || attempt.schedulingHash !== expected?.scheduling
          || attempt.dispatchContextHash !== contextHash))) {
        throw new Error(`dispatch intent does not match current revision: ${attempt.attemptId}`);
      }
      replayed.push({ attemptId: attempt.attemptId, dispatchId: attempt.dispatchId, contract: canonicalContract(compiled), contractHash: compiled.hash });
    }
    if (replayed.length) return { state: "dispatch-required", dispatches: replayed, projectionVersion: projection.version };

    const authorization = authorizedFrontier(selectSchedulingView(ir), projection);
    if (!Array.isArray(authorization)) {
      const blocked = await block("authorization_deadlock", authorization);
      return { ...blocked, dispatches: [] };
    }
    const allocatedNodes = [...projection.attempts.entries()]
      .filter(([, attempt]) => attempt.status === "workspace-allocated")
      .map(([attemptId, attempt]) => {
        const node = selectSchedulingView(ir).nodes.find((candidate) => candidate.id === attempt.taskId);
        if (!node) throw new Error(`allocated attempt references unknown task: ${attemptId}`);
        return node;
      });
    const frontier = [...authorization, ...allocatedNodes.filter((node) => !authorization.some((candidate) => candidate.id === node.id))]
      .filter((node) => !attemptsForTask(projection, node.id)
        .some((attempt) => ["succeeded", "validated", "integration-requested", "integrated"].includes(attempt.status)));
    if (!frontier.length) return { state: stateFor(projection), dispatches: [], projectionVersion: projection.version };

    const dispatches = [];
    for (const node of frontier) {
      const execution = ir.version === "plan-ir.v3" ? selectExecutionView(ir, node.id) : legacyExecutionView(ir, node.id);
      const receipts = ir.version === "plan-ir.v3" ? collectDependencyReceipts(projection, execution.task) : Object.freeze([]);
      // Validate every non-workspace contract field before acquiring a worktree lease.
      compileCodingDispatchIR(sourceContract(execution, {
        cwd: projection.workspace.originRoot, receipts, legacyTimeout: timeoutMs,
      }), { cwd: projection.workspace.originRoot });
      const candidates = attemptsForTask(projection, node.id).filter((attempt) => attempt.status === "workspace-allocated");
      if (candidates.length > 1) throw new Error(`multiple allocated attempts for task: ${node.id}`);
      let attempt = candidates[0];
      let attemptId;
      let workspaceLease;
      let baseCommit;
      if (attempt) {
        attemptId = attempt.attemptId;
        workspaceLease = attempt.workspace;
        baseCommit = attempt.baseCommit;
        if (baseCommit !== projection.workspace.headCommit) throw new Error(`allocated attempt base commit is stale: ${attemptId}`);
      } else {
        attemptId = nextAttemptId(projection, node.id);
        baseCommit = projection.workspace.headCommit;
        workspaceLease = await allocateWorkspace({ originRoot: projection.workspace.originRoot, stateRoot, planId: projection.planId, taskId: node.id, attemptId, baseCommit });
        await appendEvent("attempt.workspace-allocated", { attemptId, taskId: node.id, baseCommit, workspace: workspaceLease });
      }
      const output = outputForAttempt(attemptId);
      const compiled = compileCodingDispatchIR(sourceContract(execution, {
        cwd: workspaceLease.path, receipts, legacyTimeout: timeoutMs,
      }), { cwd: projection.workspace.originRoot });
      const contract = canonicalContract(compiled);
      const dispatchId = `${attemptId}.dispatch.1`;
      const identity = projection.revision ? {
        planIrHash: projection.revision.irHash,
        taskHash: projection.revision.taskHashes[node.id].effective,
        schedulingHash: projection.revision.taskHashes[node.id].scheduling,
      } : {};
      const tool = {
        agent: contract.agent, task: buildExecutionPrompt(execution, { attemptId, baseCommit, output, receipts }), cwd: workspaceLease.path,
        context: "fresh", async: true, clarify: false, worktree: false, output, outputMode: "file-only", acceptance: false,
        artifacts: true, timeoutMs: contract.execution.timeoutMs, contract, dependencyReceipts: receipts,
      };
      const dispatchContextHash = projection.revision ? sha256({ ...identity, attemptId, baseCommit, output, dependencyReceipts: receipts }) : undefined;
      await appendEvent("attempt.dispatch-requested", {
        attemptId, taskId: node.id, dispatchId, baseCommit, workspace: workspaceLease, tool, toolHash: compiled.hash,
        ...identity, ...(projection.revision ? { dispatchContextHash } : {}),
      });
      dispatches.push({ attemptId, dispatchId, contract, contractHash: compiled.hash });
    }
    return { state: "dispatch-required", dispatches, projectionVersion: projection.version };
  }

  async function dispatchAuthorized() {
    await refreshProjection();
    if (!projection.planId || ["blocked", "cancelled", "validated", "interrupted"].includes(projection.lifecycle)) {
      throw new Error("Plan cannot dispatch executors");
    }
    if (typeof allocateWorkspace !== "function" || typeof backend?.spawn !== "function") {
      throw new Error("Attempt workspace allocator and execution backend are required");
    }
    if (integrationQueue) {
      const integration = await integrationQueue.drain({ expectedHead: projection.workspace.headCommit, ownerToken: integrationOwnerToken });
      if (integration?.state === "blocked") return { state: "blocked", dispatched: [], projectionVersion: projection.version };
    }
    const authorization = authorizedFrontier(selectSchedulingView(ir), projection);
    if (!Array.isArray(authorization)) return await block("authorization_deadlock", authorization);
    const frontier = authorization.filter((node) => !attemptsForTask(projection, node.id)
      .some((attempt) => ["succeeded", "validated", "integration-requested", "integrated"].includes(attempt.status)));
    if (frontier.length === 0) {
      return { state: stateFor(projection), dispatched: [], projectionVersion: projection.version };
    }

    const dispatched = [];
    for (const node of frontier) {
      const attemptId = nextAttemptId(projection, node.id);
      const attemptBaseCommit = projection.workspace.headCommit;
      const execution = ir.version === "plan-ir.v3" ? selectExecutionView(ir, node.id) : legacyExecutionView(ir, node.id);
      const receipts = ir.version === "plan-ir.v3" ? collectDependencyReceipts(projection, execution.task) : Object.freeze([]);
      const output = outputForAttempt(attemptId);
      const workspaceLease = await allocateWorkspace({
        originRoot: projection.workspace.originRoot,
        stateRoot,
        planId: projection.planId,
        taskId: node.id,
        attemptId,
        baseCommit: attemptBaseCommit,
      });
      await appendEvent("attempt.workspace-allocated", {
        attemptId,
        taskId: node.id,
        baseCommit: attemptBaseCommit,
        workspace: workspaceLease,
      });
      const dispatchId = `${attemptId}.dispatch.1`;
      const prompt = buildExecutionPrompt(execution, { attemptId, baseCommit: attemptBaseCommit, output, receipts });
      const tool = {
        agent: execution.task.execution?.agent ?? execution.task.agent ?? "executor",
        task: prompt,
        cwd: workspaceLease.path,
        context: "fresh",
        async: true,
        clarify: false,
        worktree: false,
        output,
        outputMode: "file-only",
        acceptance: false,
        artifacts: true,
        timeoutMs: execution.task.execution?.timeoutMs ?? timeoutMs,
      };
      const dispatchIdentity = projection.revision ? {
        planIrHash: ir.hash ?? projection.revision.irHash,
        taskHash: execution.task.hashes?.effective ?? projection.revision.taskHashes[node.id].effective,
        schedulingHash: execution.task.hashes?.scheduling ?? projection.revision.taskHashes[node.id].scheduling,
        dispatchContextHash: sha256({
          planIrHash: ir.hash ?? projection.revision.irHash,
          taskHash: execution.task.hashes?.effective ?? projection.revision.taskHashes[node.id].effective,
          schedulingHash: execution.task.hashes?.scheduling ?? projection.revision.taskHashes[node.id].scheduling,
          attemptId,
          baseCommit: attemptBaseCommit,
          output,
          dependencyReceipts: receipts,
        }),
      } : {};
      await appendEvent("attempt.dispatch-requested", {
        attemptId,
        taskId: node.id,
        dispatchId,
        baseCommit: attemptBaseCommit,
        workspace: workspaceLease,
        tool,
        toolHash: sha256(tool),
        ...dispatchIdentity,
      });

      let binding;
      try {
        binding = await backend.spawn({
          dispatchId,
          attemptId,
          agent: execution.task.execution?.agent ?? execution.task.agent ?? "executor",
          task: prompt,
          cwd: workspaceLease.path,
          output,
          timeoutMs: execution.task.execution?.timeoutMs ?? timeoutMs,
        });
        if (binding?.dispatchId !== dispatchId || binding?.attemptId !== attemptId
          || binding?.cwd !== workspaceLease.path || typeof binding?.runId !== "string"
          || typeof binding?.asyncDir !== "string") {
          return await block("protocol_violation", { attemptId, dispatchId });
        }
      } catch (error) {
        const reason = error?.code?.includes?.("MISMATCH") ? "protocol_violation" : "dispatch_uncertain";
        return await block(reason, { attemptId, dispatchId, error: error instanceof Error ? error.message : String(error) });
      }
      const bindingResult = await bindOrCleanupSpawnedAttempt({
        attemptId,
        taskId: node.id,
        dispatchId,
        binding,
      });
      if (bindingResult.state) {
        return {
          state: bindingResult.state,
          dispatched,
          projectionVersion: projection.version,
        };
      }
      dispatched.push({
        taskId: node.id,
        attemptId,
        dispatchId,
        runId: binding.runId,
        asyncDir: binding.asyncDir,
        cwd: workspaceLease.path,
      });
    }
    return { state: "waiting-executors", dispatched, projectionVersion: projection.version };
  }

  function matchingFacts(attempt, facts) {
    return facts.filter((fact) => fact?.type === "execution.started"
      && fact.dispatchId === attempt.dispatchId
      && fact.attemptId === attempt.attemptId
      && fact.cwd === attempt.workspace.path
      && typeof fact.runId === "string"
      && typeof fact.asyncDir === "string");
  }

  async function recover({ facts = [] } = {}) {
    await refreshProjection();
    if (["blocked", "cancelled", "validated", "interrupted"].includes(projection.lifecycle)) {
      return { state: projection.lifecycle, dispatched: [], projectionVersion: projection.version };
    }
    for (const attempt of requestedAttempts(projection)) {
      const matching = matchingFacts(attempt, facts);
      if (matching.length === 0) return await block("dispatch_uncertain", { attemptId: attempt.attemptId, dispatchId: attempt.dispatchId });
      if (matching.length > 1) return await block("protocol_violation", { attemptId: attempt.attemptId, dispatchId: attempt.dispatchId });
      const fact = matching[0];
      await appendEvent("attempt.bound", {
        attemptId: attempt.attemptId,
        taskId: attempt.taskId,
        dispatchId: attempt.dispatchId,
        runId: fact.runId,
        asyncDir: fact.asyncDir,
        sessionFile: fact.sessionFile ?? null,
      });
    }

    for (const attempt of activeAttempts(projection)) {
      if (attempt.status === "waiting-attention") continue;
      const artifacts = await backend.status({ runId: attempt.runId, asyncDir: attempt.asyncDir });
      const outcome = terminalOutcome(runtimeState(artifacts));
      if (outcome) await settleBoundAttempt(outcome, attempt.attemptId);
    }
    return {
      state: stateFor(projection),
      dispatched: [],
      projectionVersion: projection.version,
    };
  }

  return {
    coordinator: Object.freeze({
      dispatchAuthorized,
      prepareAuthorizedDispatches,
      recover,
      settleBoundAttempt,
      setIntegrationQueue(queue) {
        if (integrationQueue && integrationQueue !== queue) throw new Error("Integration queue is already configured");
        integrationQueue = queue;
      },
      async appendIntegrationEvent(type, data) {
        if (!["integration.requested", "integration.finished", "attempt.workspace-released", "plan.blocked"].includes(type)) {
          throw new Error(`Invalid integration event: ${type}`);
        }
        return await appendEvent(type, data);
      },
      projection: () => refreshProjectionSync(),
    }),
  };
}
