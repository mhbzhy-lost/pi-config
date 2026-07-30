import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

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

export function createPlanCoordinator({
  ir,
  entries,
  append,
  writer: suppliedWriter,
  readEntries,
  readProjection,
  allocateWorkspace,
  inspectWorkspace,
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

  async function bindOrCleanupSpawnedAttempt({ attemptId, taskId, dispatchId, binding }, { stopOnPersistenceError = true } = {}) {
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
        if (["blocked", "cancelled", "validated", "interrupted"].includes(projection.lifecycle)) {
          await stopSpawnedBinding(binding);
          return { state: projection.lifecycle };
        }
        if (error?.code === "PROJECTION_CONFLICT") continue;
        if (!stopOnPersistenceError) throw error;
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

  async function prepareAuthorizedDispatches() {
    return prepareDurableDispatches();
  }

  async function prepareDurableDispatches() {
    await refreshProjection();
    if (ir.version !== "plan-ir.v3") throw new Error("not implemented in initial intent path: legacy Plan IR");
    if (!projection.planId || ["blocked", "cancelled", "validated", "interrupted"].includes(projection.lifecycle)) {
      throw new Error("Plan cannot dispatch executors");
    }
    const ensureRevision = () => {
      const revision = projection.revision;
      if (!revision || revision.irHash !== ir.hash
        || revision.irVersion !== ir.version
        || revision.number !== ir.source?.revision
        || revision.planHash !== ir.source?.planHash) {
        throw new Error("stale revision/context");
      }
      const taskIds = ir.nodes.map((task) => task.id).sort();
      const revisionTaskIds = Object.keys(revision.taskHashes ?? {}).sort();
      const projectionTaskIds = [...projection.tasks.keys()].sort();
      if (revisionTaskIds.join("\0") !== taskIds.join("\0")
        || projectionTaskIds.join("\0") !== taskIds.join("\0")) {
        throw new Error("stale revision/context");
      }
      for (const task of ir.nodes) {
        const hashes = revision.taskHashes[task.id];
        if (!hashes || hashes.full !== task.hashes.full
          || hashes.effective !== task.hashes.effective
          || hashes.scheduling !== task.hashes.scheduling) {
          throw new Error("stale revision/context");
        }
      }
    };
    const split = (text, max = 4096) => {
      if (/^\s|\s$/.test(text)) throw new Error("capacity");
      const chars = Array.from(text);
      const parts = [];
      let start = 0;
      while (start < chars.length) {
        let end = start;
        let bytes = 0;
        while (end < chars.length) {
          const size = Buffer.byteLength(chars[end]);
          if (bytes + size > max) break;
          bytes += size;
          end += 1;
        }
        if (end === start) throw new Error("capacity");
        if (end < chars.length) {
          while (end > start && (/\s/.test(chars[end - 1]) || /\s/.test(chars[end]))) {
            end -= 1;
          }
          if (end === start) throw new Error("capacity");
        }
        parts.push(chars.slice(start, end).join(""));
        start = end;
      }
      return parts;
    };
    const makeSource = (execution, attemptId, baseCommit, cwd, receipts) => {
      const { task, plan } = execution;
      const instructionParts = split(plan.instructions, 4000);
      const instructionFacts = instructionParts.length === 1
        ? [`Plan instructions: ${instructionParts[0]}`]
        : instructionParts.map((part, index) => `Plan instructions (${index + 1}/${instructionParts.length}): ${part}`);
      const selected = task.acceptance.strategy === "commands"
        ? task.acceptance.commandIds
          .map((id) => ir.verification.commands.find((command) => command.id === id))
          .filter(Boolean)
        : [];
      const commands = task.acceptance.strategy === "commands"
        ? selected.map((command) => command.cwd === "." ? command.command : `cd -- '${command.cwd.replaceAll("'", "'\"'\"'")}' && ${command.command}`)
        : [`git diff --check ${baseCommit}..HEAD`];
      const workflow = task.execution.workflow.mode === "inherit-repository"
        ? { mode: "tdd" }
        : task.execution.workflow;
      const knownFacts = [
        `Plan title: ${plan.title}`,
        ...instructionFacts,
        `Task resources: ${JSON.stringify(task.resources)}`,
      ];
      if (receipts.length) {
        knownFacts.push(`Dependency receipts: ${JSON.stringify(receipts)}`);
      }
      const acceptance = task.acceptance.strategy === "commands"
        ? task.acceptance
        : Object.fromEntries(Object.entries(task.acceptance).filter(([key]) => key !== "commandIds"));
      return {
        version: "dispatch-ir.v1",
        taskId: task.id,
        title: task.title,
        agent: task.execution.agent,
        risk: task.execution.risk,
        objective: `Complete approved plan task ${task.id}: ${task.title}.`,
        workflow,
        requirements: split(task.body),
        context: {
          knownFacts,
          decisions: [JSON.stringify(plan.executionPolicy)],
          relevantFiles: task.allowedPaths,
        },
        boundaries: {
          writePaths: task.allowedPaths,
          excludedWork: [],
          forbiddenActions: [],
        },
        acceptance: {
          criteria: [JSON.stringify(acceptance)],
          commands,
        },
        execution: {
          cwd,
          timeoutMs: task.execution.timeoutMs,
        },
      };
    };
    const compile = (execution, attemptId, baseCommit, cwd, receipts) => {
      try {
        return compileCodingDispatchIR(
          makeSource(execution, attemptId, baseCommit, cwd, receipts),
          { cwd: projection.workspace.originRoot },
        );
      } catch (error) {
        throw new Error(`capacity: ${error.message}`);
      }
    };
    const makeDurableTool = (execution, attemptId, baseCommit, workspace, receipts) => {
      const output = outputForAttempt(attemptId);
      const { hash: contractHash, ...contract } = compile(execution, attemptId, baseCommit, workspace.path, receipts);
      return {
        agent: execution.task.execution.agent,
        task: buildExecutionPrompt(execution, { attemptId, baseCommit, output, receipts }),
        cwd: workspace.path,
        context: "fresh",
        async: true,
        clarify: false,
        worktree: false,
        output,
        outputMode: "file-only",
        acceptance: false,
        artifacts: true,
        timeoutMs: execution.task.execution.timeoutMs,
        contract,
        dependencyReceipts: receipts,
        contractHash,
      };
    };
    const inspectAttemptLease = async (attemptId, attempt) => {
      if (typeof inspectWorkspace !== "function") throw new Error("Attempt workspace inspector is required");
      return await inspectWorkspace({
        ...attempt.workspace,
        planId: projection.planId,
        taskId: attempt.taskId,
        attemptId,
        baseCommit: attempt.baseCommit,
      });
    };
    const emit = async (execution, attemptId, baseCommit, workspace, allocation) => {
      ensureRevision();
      const receipts = collectDependencyReceipts(projection, execution.task);
      const { contractHash, ...tool } = makeDurableTool(execution, attemptId, baseCommit, workspace, receipts);
      const { contract } = tool;
      const dispatchId = `${attemptId}.dispatch.1`;
      const output = tool.output;
      if (allocation) {
        await appendEvent("attempt.workspace-allocated", {
          attemptId,
          taskId: execution.task.id,
          baseCommit,
          workspace,
        });
      }
      await appendEvent("attempt.dispatch-requested", {
        attemptId,
        taskId: execution.task.id,
        dispatchId,
        baseCommit,
        workspace,
        tool,
        toolHash: contractHash,
        planIrHash: ir.hash,
        taskHash: execution.task.hashes.effective,
        schedulingHash: execution.task.hashes.scheduling,
        dispatchContextHash: sha256({
          planIrHash: ir.hash,
          taskHash: execution.task.hashes.effective,
          schedulingHash: execution.task.hashes.scheduling,
          attemptId,
          baseCommit,
          output,
          dependencyReceipts: receipts,
        }),
      });
      return { attemptId, dispatchId, contract, contractHash };
    };
    ensureRevision();
    const pending = [];
    for (const attempt of requestedAttempts(projection)) {
      const execution = selectExecutionView(ir, attempt.taskId);
      const output = outputForAttempt(attempt.attemptId);
      const receipts = collectDependencyReceipts(projection, execution.task);
      if (attempt.tool?.output !== output
        || !Array.isArray(attempt.tool?.dependencyReceipts)
        || !isDeepStrictEqual(attempt.tool.dependencyReceipts, receipts)) {
        throw new Error("stale revision/context");
      }
      const expectedTool = makeDurableTool(execution, attempt.attemptId, attempt.baseCommit, attempt.workspace, receipts);
      let stored;
      try {
        stored = compileCodingDispatchIR(attempt.tool?.contract, { cwd: projection.workspace.originRoot });
      } catch {
        throw new Error("contract hash mismatch");
      }
      if (stored.hash !== attempt.toolHash || attempt.toolHash !== expectedTool.contractHash) throw new Error("contract hash mismatch");
      const contextHash = sha256({ planIrHash: ir.hash, taskHash: execution.task.hashes.effective, schedulingHash: execution.task.hashes.scheduling, attemptId: attempt.attemptId, baseCommit: attempt.baseCommit, output, dependencyReceipts: receipts });
      if (attempt.dispatchContextHash !== contextHash) throw new Error("stale revision/context");
      const { contractHash, ...expectedToolWithoutHash } = expectedTool;
      if (!isDeepStrictEqual(attempt.tool, expectedToolWithoutHash)) throw new Error("stale revision/context");
      await inspectAttemptLease(attempt.attemptId, attempt);
      pending.push({ attemptId: attempt.attemptId, dispatchId: attempt.dispatchId, contract: expectedTool.contract, contractHash });
    }
    if (pending.length) {
      return { state: "dispatch-required", dispatches: pending, projectionVersion: projection.version };
    }
    const recovery = [...projection.attempts.entries()].find(([, attempt]) => attempt.status === "workspace-allocated");
    if (recovery) {
      const [attemptId, attempt] = recovery;
      if (attempt.baseCommit !== projection.workspace.headCommit || attempt.workspace.baseCommit !== projection.workspace.headCommit) {
        throw new Error("stale base");
      }
      const inspection = await inspectAttemptLease(attemptId, attempt);
      if (!inspection || typeof inspection !== "object"
        || inspection.headCommit !== attempt.baseCommit || inspection.clean !== true) {
        throw new Error("workspace recovery inspection head/clean stale identity check failed");
      }
      const dispatch = await emit(
        selectExecutionView(ir, attempt.taskId),
        attemptId,
        attempt.baseCommit,
        attempt.workspace,
        false,
      );
      return {
        state: "dispatch-required",
        dispatches: [dispatch],
        projectionVersion: projection.version,
      };
    }
    if (integrationQueue) {
      const drained = await integrationQueue.drain({
        expectedHead: projection.workspace.headCommit,
        ownerToken: integrationOwnerToken,
      });
      await refreshProjection();
      if (drained?.state === "blocked" || drained?.state === "cancelled"
        || ["blocked", "cancelled", "validated", "interrupted"].includes(projection.lifecycle)) {
        const state = drained?.state === "blocked" || drained?.state === "cancelled"
          ? drained.state
          : projection.lifecycle;
        return { state, dispatches: [], projectionVersion: projection.version };
      }
    }
    ensureRevision();
    if (typeof allocateWorkspace !== "function") throw new Error("Attempt workspace allocator is required");
    const frontier = authorizedFrontier(selectSchedulingView(ir), projection);
    if (!Array.isArray(frontier)) throw new Error("authorization deadlock");
    const prepared = frontier.map((node) => {
      const execution = selectExecutionView(ir, node.id);
      const attemptId = nextAttemptId(projection, node.id);
      compile(
        execution,
        attemptId,
        projection.workspace.headCommit,
        projection.workspace.originRoot,
        collectDependencyReceipts(projection, execution.task),
      );
      return { execution, attemptId };
    });
    const dispatches = [];
    for (const { execution, attemptId } of prepared) {
      const baseCommit = projection.workspace.headCommit;
      const workspace = await allocateWorkspace({
        originRoot: projection.workspace.originRoot,
        stateRoot,
        planId: projection.planId,
        taskId: execution.task.id,
        attemptId,
        baseCommit,
      });
      dispatches.push(await emit(execution, attemptId, baseCommit, workspace, true));
    }
    return { state: dispatches.length ? "dispatch-required" : stateFor(projection), dispatches, projectionVersion: projection.version };
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
      bindAuthorizedDispatch: (input) => bindOrCleanupSpawnedAttempt(input, { stopOnPersistenceError: false }),
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
