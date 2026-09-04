import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { compileTaskContract } from "./dispatch.ts";
import { splitDispatchEnvelope } from "../../packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts";
import {
  createManagedWorkspaceRequest,
  deterministicGoalWorkspaceId,
  publicManagedWorkspaceReceipt,
} from "../../packages/pi-subagents-enhanced/src/workspace/contract.ts";
import { generationCapabilities } from "./generation-capabilities.ts";
import { executorCriteria } from "./task-definition.ts";

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

function expectedContract(projection, taskId, requestedCwd) {
  const tasks = new Map(projection.tasks);
  tasks.set(taskId, { ...projection.tasks.get(taskId), status: "pending" });
  return compileTaskContract({ ...projection, tasks }, taskId, requestedCwd);
}

function selectedTaskId(projection, contract) {
  return [...projection.tasks].find(([taskId, task]) => ["dispatch_requested", "dispatched"].includes(task.status) && task.dispatchRequest && contract.taskId === `${projection.goalId}.${taskId}`)?.[0] ?? null;
}

function executionRevision(projection) {
  return generationCapabilities(projection.eventSchemaVersion).executionRevision ? projection.executionRevision : 1;
}

function assertReceiptMatchesTicket(ticket, value) {
  const receipt = publicManagedWorkspaceReceipt(value);
  const request = ticket.workspaceRequest;
  if (receipt.state !== "active" || receipt.workspaceId !== request.workspaceId
      || receipt.owner.kind !== "goal-task" || !isDeepStrictEqual(receipt.owner, request.owner)
      || receipt.originRoot !== request.originRoot || receipt.requestedCwd !== request.requestedCwd
      || receipt.originRef !== request.originRef || receipt.baseCommit !== request.baseCommit) {
    fail("EXECUTOR_BINDING_MISMATCH", "workspace receipt does not match the Goal dispatch ticket");
  }
  return receipt;
}

export function prepareExecutorBindingTicket({ projection, contract, contractHash, controlCwd, rootSessionId }) {
  if (!projection?.eventSchemaVersion || generationCapabilities(projection.eventSchemaVersion).executorBinding !== "strict") return null;
  const taskId = selectedTaskId(projection, contract);
  if (!taskId) return null;
  const task = projection.tasks.get(taskId);
  const request = task.dispatchRequest;
  if (!["dispatch_requested", "dispatched"].includes(task.status) || !request) fail("EXECUTOR_BINDING_MISMATCH", "Goal task has no current workspace request");
  if (!/^[a-f0-9]{64}$/.test(contractHash ?? "") || contractHash !== task.contractHash) fail("EXECUTOR_CONTRACT_MISMATCH", "execute-time contract hash does not match the dispatch ticket");
  const expected = expectedContract(projection, taskId, request.requestedCwd);
  const envelope = splitDispatchEnvelope(expected);
  if (envelope.contractHash !== contractHash || !isDeepStrictEqual(contract, envelope.contract)) {
    fail("EXECUTOR_CONTRACT_MISMATCH", "execute-time contract was replaced after Goal dispatch");
  }
  if (contract.execution.cwd !== request.requestedCwd || contract.execution.worktree !== true) fail("EXECUTOR_BINDING_MISMATCH", "execute-time workspace request does not match Goal dispatch");
  const revision = executionRevision(projection);
  const workspaceId = deterministicGoalWorkspaceId({ goalId: projection.goalId, taskId, attempt: request.attempt, executionRevision: revision, contractHash, baseCommit: request.baseCommit });
  if (workspaceId !== request.workspaceId) fail("EXECUTOR_BINDING_MISMATCH", "workspace request identity changed before spawn");
  const workspaceRequest = createManagedWorkspaceRequest({
    workspaceId,
    owner: { kind: "goal-task", rootSessionId, goalId: projection.goalId, taskId, attempt: request.attempt, executionRevision: revision },
    originRoot: request.originRoot,
    requestedCwd: request.requestedCwd,
    originRef: request.originRef,
    baseCommit: request.baseCommit,
    contractHash,
    mode: "coding",
    writePaths: task.writePaths,
  });
  const identity = {
    goalId: projection.goalId,
    taskId,
    attempt: request.attempt,
    contractHash,
    workspaceId,
    headAtDispatch: request.baseCommit,
    schemaVersion: projection.eventSchemaVersion,
    executionRevision: revision,
    expectedCriteria: executorCriteria(task.acceptance.criteria).map((criterion) => criterion.id),
  };
  const ticketId = digest({ ...identity, workspaceRequest });
  return Object.freeze({
    version: "goal-executor-binding-ticket.v1",
    ticketId,
    controlCwd,
    rootSessionId,
    ...identity,
    workspaceRequest,
    spawnIdentity: Object.freeze({
      requestId: `goal-executor-${ticketId.slice(0, 48)}`,
      spawnKey: `goal-executor-${ticketId.slice(0, 48)}`,
    }),
  });
}

export function assertExecutorBindingTicketCurrent(ticket, projection, workspaceReceipt = null) {
  if (!ticket || ticket.version !== "goal-executor-binding-ticket.v1") fail("EXECUTOR_BINDING_MISMATCH", "binding ticket is invalid");
  const task = projection?.tasks?.get(ticket.taskId);
  const request = task?.dispatchRequest;
  const expectedStatus = workspaceReceipt ? "dispatched" : "dispatch_requested";
  if (projection?.goalId !== ticket.goalId || !projection?.eventSchemaVersion || generationCapabilities(projection.eventSchemaVersion).executorBinding !== "strict"
      || task?.status !== expectedStatus || task.attempts !== ticket.attempt
      || task.contractHash !== ticket.contractHash || request?.workspaceId !== ticket.workspaceId
      || request.baseCommit !== ticket.headAtDispatch
      || ticket.schemaVersion !== projection.eventSchemaVersion
      || ticket.executionRevision !== executionRevision(projection)) {
    fail("EXECUTOR_BINDING_MISMATCH", "Goal dispatch ticket changed before executor binding");
  }
  if (!isDeepStrictEqual(ticket.expectedCriteria, executorCriteria(task.acceptance.criteria).map((criterion) => criterion.id))) {
    fail("EXECUTOR_BINDING_MISMATCH", "Goal acceptance criteria changed before executor binding");
  }
  if (workspaceReceipt && !isDeepStrictEqual(task.workspace, assertReceiptMatchesTicket(ticket, workspaceReceipt))) {
    fail("EXECUTOR_BINDING_MISMATCH", "allocated workspace receipt changed before executor binding");
  }
  return task;
}

export function executorBoundEventData(ticket, binding, workspaceReceipt) {
  if (!binding || !/^[A-Za-z0-9._-]{1,160}$/.test(binding.runId ?? "")) fail("EXECUTOR_BINDING_MISMATCH", "spawn reply runId is invalid");
  if (typeof binding.asyncDir !== "string" || !isAbsolute(binding.asyncDir) || binding.asyncDir.includes("\0")) fail("EXECUTOR_BINDING_MISMATCH", "spawn reply asyncDir is invalid");
  const receipt = assertReceiptMatchesTicket(ticket, workspaceReceipt);
  return {
    taskId: ticket.taskId,
    attempt: ticket.attempt,
    runId: binding.runId,
    contractHash: ticket.contractHash,
    asyncDir: binding.asyncDir,
    workspacePath: receipt.path,
    workspaceLeaseId: receipt.leaseId,
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
