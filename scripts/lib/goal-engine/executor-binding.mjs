import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { compileTaskContract } from "./dispatch.mjs";
import { splitDispatchEnvelope } from "./dispatch-ir.mjs";
import { generationCapabilities } from "./generation-capabilities.mjs";

function fail(code, message) {
  throw Object.assign(new Error(`${code}: ${message}`), { code });
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function expectedContract(projection, taskId, workspacePath) {
  const tasks = new Map(projection.tasks);
  tasks.set(taskId, { ...projection.tasks.get(taskId), status: "pending" });
  return compileTaskContract({ ...projection, tasks }, taskId, workspacePath);
}

function selectedTaskId(projection, contract) {
  const byTaskId = [...projection.tasks].find(([taskId, task]) => task.status === "dispatched" && contract.taskId === `${projection.goalId}.${taskId}`)?.[0];
  const byWorkspace = [...projection.tasks].find(([, task]) => task.status === "dispatched" && task.workspace?.path === contract.execution?.cwd)?.[0];
  if (byTaskId && byWorkspace && byTaskId !== byWorkspace) fail("EXECUTOR_BINDING_MISMATCH", "taskId and workspace identify different Goal tasks");
  return byTaskId ?? byWorkspace ?? null;
}

export function prepareExecutorBindingTicket({ projection, contract, contractHash, controlCwd, workspaceLeaseIdForTask }) {
  if (!projection?.eventSchemaVersion || generationCapabilities(projection.eventSchemaVersion).executorBinding !== "strict") return null;
  const taskId = selectedTaskId(projection, contract);
  if (!taskId) return null;
  const task = projection.tasks.get(taskId);
  const workspace = task.workspace;
  if (task.status !== "dispatched" || workspace?.phase !== "active") fail("EXECUTOR_BINDING_MISMATCH", "Goal task is not actively dispatched");
  if (!/^[a-f0-9]{64}$/.test(contractHash ?? "") || contractHash !== task.contractHash) fail("EXECUTOR_CONTRACT_MISMATCH", "execute-time contract hash does not match the dispatch ticket");
  const expected = expectedContract(projection, taskId, workspace.path);
  const envelope = splitDispatchEnvelope(expected);
  if (envelope.contractHash !== contractHash || !isDeepStrictEqual(contract, envelope.contract)) {
    fail("EXECUTOR_CONTRACT_MISMATCH", "execute-time contract was replaced after Goal dispatch");
  }
  if (contract.execution.cwd !== workspace.path || !isAbsolute(workspace.path)) fail("EXECUTOR_BINDING_MISMATCH", "execute-time cwd does not match the Goal workspace");
  const workspaceLeaseId = workspaceLeaseIdForTask?.(taskId);
  if (!/^[a-f0-9]{64}$/.test(workspaceLeaseId ?? "")) fail("EXECUTOR_BINDING_MISMATCH", "workspace lease identity is invalid");
  const identity = {
    goalId: projection.goalId,
    taskId,
    attempt: task.attempts,
    contractHash,
    workspacePath: workspace.path,
    workspaceLeaseId,
    headAtDispatch: workspace.baseCommit,
    schemaVersion: projection.eventSchemaVersion,
    executionRevision: generationCapabilities(projection.eventSchemaVersion).executionRevision ? projection.executionRevision : null,
  };
  const ticketId = digest(identity);
  return Object.freeze({
    version: "goal-executor-binding-ticket.v1",
    ticketId,
    controlCwd,
    ...identity,
    spawnIdentity: Object.freeze({
      requestId: `goal-executor-${ticketId.slice(0, 48)}`,
      spawnKey: `goal-executor-${ticketId.slice(0, 48)}`,
    }),
  });
}

export function assertExecutorBindingTicketCurrent(ticket, projection) {
  if (!ticket || ticket.version !== "goal-executor-binding-ticket.v1") fail("EXECUTOR_BINDING_MISMATCH", "binding ticket is invalid");
  const task = projection?.tasks?.get(ticket.taskId);
  const workspace = task?.workspace;
  if (projection?.goalId !== ticket.goalId || !projection?.eventSchemaVersion || generationCapabilities(projection.eventSchemaVersion).executorBinding !== "strict"
      || task?.status !== "dispatched" || task.attempts !== ticket.attempt
      || task.contractHash !== ticket.contractHash || workspace?.phase !== "active"
      || workspace.path !== ticket.workspacePath || workspace.baseCommit !== ticket.headAtDispatch
      || ticket.schemaVersion !== projection.eventSchemaVersion
      || ticket.executionRevision !== (generationCapabilities(projection.eventSchemaVersion).executionRevision ? projection.executionRevision : null)) {
    fail("EXECUTOR_BINDING_MISMATCH", "Goal dispatch ticket changed before executor binding");
  }
  return task;
}

export function executorBoundEventData(ticket, binding) {
  if (!binding || !/^[A-Za-z0-9._-]{1,160}$/.test(binding.runId ?? "")) fail("EXECUTOR_BINDING_MISMATCH", "spawn reply runId is invalid");
  if (typeof binding.asyncDir !== "string" || !isAbsolute(binding.asyncDir) || binding.asyncDir.includes("\0")) fail("EXECUTOR_BINDING_MISMATCH", "spawn reply asyncDir is invalid");
  return {
    taskId: ticket.taskId,
    attempt: ticket.attempt,
    runId: binding.runId,
    contractHash: ticket.contractHash,
    asyncDir: binding.asyncDir,
    workspacePath: ticket.workspacePath,
    workspaceLeaseId: ticket.workspaceLeaseId,
    headAtDispatch: ticket.headAtDispatch,
  };
}

export function assertExecutorSettlementProof({ task, proof }) {
  const binding = task?.executorBinding;
  if (!binding) fail("EXECUTOR_BINDING_MISSING", "Planned task has no durable executor binding");
  if (!proof) fail("EXECUTOR_TERMINAL_PROOF_MISSING", `Root Broker has no official terminal proof for ${binding.runId}`);
  if (proof.schemaVersion !== "root-broker.executor-proof.v1" || !proof.ownership || typeof proof.ownership !== "object") {
    fail("EXECUTOR_TERMINAL_PROOF_INVALID", "Root Broker proof snapshot is invalid");
  }
  if (proof.terminalConflict === true) fail("EXECUTOR_TERMINAL_PROOF_CONFLICT", "Root Broker observed conflicting terminal proofs");
  const owner = proof.ownership;
  if (owner.runId !== binding.runId || owner.asyncDir !== binding.asyncDir || owner.role !== "executor" || owner.identityState !== "verified") {
    fail("EXECUTOR_OWNERSHIP_MISMATCH", "Root Broker ownership does not match the bound executor");
  }
  const terminal = proof.terminal;
  if (!terminal) fail("EXECUTOR_TERMINAL_PROOF_MISSING", `Root Broker has no official terminal proof for ${binding.runId}`);
  if (!/^[a-f0-9]{64}$/.test(terminal.proofId ?? "") || typeof terminal.observedAt !== "number" || !Number.isFinite(terminal.observedAt)) {
    fail("EXECUTOR_TERMINAL_PROOF_INVALID", "Root Broker terminal proof identity is invalid");
  }
  if (terminal.outcome !== "succeeded") fail("EXECUTOR_TERMINAL_NOT_SUCCESSFUL", "Root Broker terminal proof is not successful");
  if (typeof owner.rootSessionId !== "string" || !owner.rootSessionId || typeof owner.sessionId !== "string" || !owner.sessionId) {
    fail("EXECUTOR_OWNERSHIP_MISMATCH", "Root Broker host or session ownership is missing");
  }
  return {
    runId: binding.runId,
    proofId: terminal.proofId,
    rootSessionId: owner.rootSessionId,
    observedAt: terminal.observedAt,
    outcome: terminal.outcome,
  };
}
