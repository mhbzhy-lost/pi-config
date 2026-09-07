import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { generationCapabilities } from "./generation-capabilities.ts";
import { normalizeAgentProfile, runCriteria } from "./task-definition.ts";
import { createManagedWorkspaceRequest, publicManagedWorkspaceReceipt } from "../../packages/pi-subagents-enhanced/src/workspace/contract.ts";

const ID = /^[A-Za-z0-9._-]{1,160}$/;
const HASH = /^[a-f0-9]{64}$/;
const HEAD = /^[a-f0-9]{40}$/;

function fail(message) { throw new Error(`RUN_BINDING_MISMATCH: ${message}`); }
function digest(value) { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
function canonical(value) { return Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value; }
function v2(projection) { return projection?.eventSchemaVersion === "planned.v2" || projection?.eventSchemaVersion === "goal-runtime.v2"; }
function taskFor(projection, taskId) { const task = projection?.tasks?.get(taskId); if (!task) fail("task is missing"); return task; }

export function prepareRunBindingTicket({ projection, taskId, contractHash, controlCwd, rootSessionId }) {
  if (!v2(projection)) return null;
  const task = taskFor(projection, taskId);
  if (["dispatch_requested", "dispatched"].includes(task.status) && task.dispatchRequest && !task.runBinding) {
    const request = task.dispatchRequest;
    if (!request || request.contractHash !== contractHash || !HASH.test(contractHash || "") || request.attempt !== task.attempts) fail("dispatch request identity is invalid");
    if (typeof controlCwd !== "string" || !isAbsolute(controlCwd) || !ID.test(rootSessionId || "")) fail("control identity is invalid");
    const executionRevision = generationCapabilities(projection.eventSchemaVersion).executionRevision ? projection.executionRevision : 1;
    const agentProfile = normalizeAgentProfile(task.agentProfile, "task agentProfile");
    const workspaceRequest = createManagedWorkspaceRequest({
      workspaceId: request.workspaceId,
      owner: { kind: "goal-task", rootSessionId, goalId: projection.goalId, taskId, attempt: request.attempt, executionRevision },
      originRoot: request.originRoot, requestedCwd: request.requestedCwd,
      originRef: request.originRef, baseCommit: request.baseCommit,
      contractHash, mode: "coding", writePaths: task.writePaths,
    });
    const identity = { goalId: projection.goalId, taskId, attempt: request.attempt, contractHash, workspaceId: request.workspaceId, headAtDispatch: request.baseCommit, agentProfile, executionRevision };
    return Object.freeze({ version: "goal-run-binding-ticket.v2", ticketId: digest({ ...identity, workspaceRequest }), controlCwd, rootSessionId, ...identity, workspaceRequest, expectedCriteria: Object.freeze(runCriteria(task.acceptance.criteria).map((criterion) => criterion.id)) });
  }
  if (task.status !== "dispatched" || task.runBinding) fail("task is not awaiting a run binding");
  if (!HASH.test(contractHash || "") || task.contractHash !== contractHash) fail("contract hash changed");
  let profile, workspace;
  try { profile = normalizeAgentProfile(task.agentProfile, "task agentProfile"); workspace = publicManagedWorkspaceReceipt(task.workspace); } catch { fail("task profile or managed workspace receipt is invalid"); }
  if (workspace.state !== "active" || workspace.run !== null || workspace.owner.kind !== "goal-task" || workspace.owner.goalId !== projection.goalId || workspace.owner.taskId !== taskId || workspace.owner.attempt !== task.attempts || workspace.owner.executionRevision !== (generationCapabilities(projection.eventSchemaVersion).executionRevision ? projection.executionRevision : 1) || !HEAD.test(workspace.baseCommit || "")) fail("workspace identity is invalid");
  if (typeof controlCwd !== "string" || !isAbsolute(controlCwd) || !ID.test(rootSessionId || "")) fail("control identity is invalid");
  const executionRevision = generationCapabilities(projection.eventSchemaVersion).executionRevision ? projection.executionRevision : 1;
  if (workspace.owner.rootSessionId !== rootSessionId) fail("workspace root session does not match ticket authority");
  const workspaceRequest = createManagedWorkspaceRequest({
    workspaceId: workspace.workspaceId,
    owner: { kind: "goal-task", rootSessionId, goalId: projection.goalId, taskId, attempt: task.attempts, executionRevision },
    originRoot: workspace.originRoot,
    requestedCwd: workspace.requestedCwd,
    originRef: workspace.originRef,
    baseCommit: workspace.baseCommit,
    contractHash,
    mode: "coding",
    writePaths: task.writePaths,
  });
  const identity = { goalId: projection.goalId, taskId, attempt: task.attempts, contractHash, workspaceId: workspace.workspaceId, workspacePath: workspace.path, workspaceLeaseId: workspace.leaseId, headAtDispatch: workspace.baseCommit, agentProfile: profile, executionRevision };
  return Object.freeze({ version: "goal-run-binding-ticket.v2", ticketId: digest({ ...identity, workspaceRequest }), controlCwd, rootSessionId, ...identity, workspaceRequest, expectedCriteria: Object.freeze(runCriteria(task.acceptance.criteria).map((criterion) => criterion.id)) });
}

export function assertRunBindingTicketCurrent(ticket, projection) {
  if (!ticket || ticket.version !== "goal-run-binding-ticket.v2" || !v2(projection)) fail("ticket is invalid");
  const task = taskFor(projection, ticket.taskId);
  if (!Object.hasOwn(ticket, "workspacePath")) {
    const pending = { ...task, status: "dispatch_requested", workspace: null };
    if (!["dispatch_requested", "dispatched"].includes(task.status) || task.runBinding) fail("ticket changed before run binding");
    const expected = prepareRunBindingTicket({ projection: { ...projection, tasks: new Map(projection.tasks).set(ticket.taskId, pending) }, taskId: ticket.taskId, contractHash: task.contractHash, controlCwd: ticket.controlCwd, rootSessionId: ticket.rootSessionId });
    if (!isDeepStrictEqual(ticket, expected)) fail("ticket changed before run binding");
    if (task.status === "dispatched") assertTicketReceipt(ticket, task.workspace);
    return task;
  }
  let workspace, profile;
  try { workspace = publicManagedWorkspaceReceipt(task.workspace); profile = normalizeAgentProfile(task.agentProfile, "task agentProfile"); } catch { fail("ticket workspace or profile is invalid"); }
  const expectedRequest = createManagedWorkspaceRequest({ workspaceId: workspace.workspaceId, owner: workspace.owner, originRoot: workspace.originRoot, requestedCwd: workspace.requestedCwd, originRef: workspace.originRef, baseCommit: workspace.baseCommit, contractHash: task.contractHash, mode: "coding", writePaths: task.writePaths });
  if (projection.goalId !== ticket.goalId || task.status !== "dispatched" || task.runBinding || task.attempts !== ticket.attempt || task.contractHash !== ticket.contractHash || profile !== ticket.agentProfile || workspace.workspaceId !== ticket.workspaceId || workspace.path !== ticket.workspacePath || workspace.baseCommit !== ticket.headAtDispatch || workspace.leaseId !== ticket.workspaceLeaseId || ticket.executionRevision !== (generationCapabilities(projection.eventSchemaVersion).executionRevision ? projection.executionRevision : 1) || !isDeepStrictEqual(ticket.workspaceRequest, expectedRequest) || !isDeepStrictEqual(ticket.expectedCriteria, runCriteria(task.acceptance.criteria).map((criterion) => criterion.id))) fail("ticket changed before run binding");
  return task;
}

export function runBoundEventData(ticket, binding, workspaceReceipt) {
  let receipt, profile;
  try { receipt = publicManagedWorkspaceReceipt(workspaceReceipt); profile = normalizeAgentProfile(binding?.agentProfile, "spawn binding agentProfile"); } catch { fail("spawn binding or managed workspace receipt is invalid"); }
  if (!ticket || ticket.version !== "goal-run-binding-ticket.v2" || !binding || !ID.test(binding.runId || "") || !isAbsolute(binding.asyncDir || "") || binding.asyncDir.includes("\0") || profile !== ticket.agentProfile) fail("spawn binding is invalid");
  assertTicketReceipt(ticket, receipt);
  return { taskId: ticket.taskId, attempt: ticket.attempt, runId: binding.runId, agentProfile: profile, contractHash: ticket.contractHash, workspaceId: ticket.workspaceId, asyncDir: binding.asyncDir, workspacePath: receipt.path, workspaceLeaseId: receipt.leaseId, headAtDispatch: ticket.headAtDispatch };
}

export function assertTicketReceipt(ticket, value) {
  const receipt = publicManagedWorkspaceReceipt(value);
  const request = ticket.workspaceRequest;
  if (receipt.workspaceId !== ticket.workspaceId || receipt.baseCommit !== ticket.headAtDispatch || receipt.state !== "active" || receipt.run !== null
    || !isDeepStrictEqual(receipt.owner, request.owner)
    || ["originRoot", "requestedCwd", "originRef", "baseCommit"].some((key) => receipt[key] !== request[key])
    || (Object.hasOwn(ticket, "workspacePath") && (receipt.path !== ticket.workspacePath || receipt.leaseId !== ticket.workspaceLeaseId))) fail("workspace receipt changed");
  return receipt;
}

export function assertExecutionSettlementProof({ task, proof, taskOutcome = "succeeded" }) {
  const binding = task?.runBinding;
  if (!binding) fail("task has no run binding");
  if (!["succeeded", "failed", "blocked"].includes(taskOutcome)) fail("task outcome is invalid");
  let profile;
  try { profile = normalizeAgentProfile(proof?.agentProfile, "execution proof agentProfile"); } catch { fail("execution proof agentProfile is invalid"); }
  if (profile !== binding.agentProfile) fail("execution proof agentProfile mismatch");
  const permittedProofOutcomes = taskOutcome === "succeeded" ? ["succeeded"] : ["succeeded", "failed"];
  if (!proof || Object.keys(proof).length !== 6 || !ID.test(proof.runId || "") || !HASH.test(proof.proofId || "") || !ID.test(proof.rootSessionId || "") || !Number.isFinite(proof.observedAt) || !permittedProofOutcomes.includes(proof.outcome) || proof.runId !== binding.runId) fail("execution proof identity is invalid");
  return { runId: proof.runId, proofId: proof.proofId, rootSessionId: proof.rootSessionId, observedAt: proof.observedAt, outcome: proof.outcome, agentProfile: profile };
}
