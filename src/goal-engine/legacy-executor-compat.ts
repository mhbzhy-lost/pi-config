const LEGACY_EXECUTOR_GENERATIONS = new Set(["planned.v1", "goal-runtime.v1"]);
const LEGACY_BINDING_FIELDS = ["attempt", "runId", "contractHash", "asyncDir", "workspacePath", "workspaceLeaseId", "headAtDispatch"];
const LEGACY_PROOF_FIELDS = ["runId", "proofId", "rootSessionId", "observedAt", "outcome"];
const RUN_BINDING_FIELDS = ["attempt", "runId", "agentProfile", "contractHash", "workspaceId", "asyncDir", "workspacePath", "workspaceLeaseId", "headAtDispatch"];
const RUN_PROOF_FIELDS = ["runId", "proofId", "rootSessionId", "observedAt", "outcome", "agentProfile"];

function fail(message) {
  throw new Error(`legacy executor compatibility: ${message}`);
}

function exactObject(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== fields.length
    || fields.some((field) => !Object.hasOwn(value, field))) fail(`${label} has an invalid shape`);
  return value;
}

function taskObject(task) {
  if (!task || typeof task !== "object" || Array.isArray(task)) fail("task is invalid");
  return task;
}

export function isLegacyExecutorGeneration(schemaVersion) {
  return LEGACY_EXECUTOR_GENERATIONS.has(schemaVersion);
}

/** The only v1 transport-profile default. It is read-time compatibility, never authorization. */
export function legacyExecutorProfile(schemaVersion, profile) {
  if (typeof profile === "string" && profile.trim()) return profile;
  if (isLegacyExecutorGeneration(schemaVersion)) return "executor";
  throw new Error("task requires agentProfile");
}

export function legacyExecutorTaskFields(schemaVersion) {
  return isLegacyExecutorGeneration(schemaVersion) ? { executorBinding: null, lastExecutorProof: null } : {};
}

export function resetLegacyExecutorTaskFields(task, schemaVersion) {
  if (isLegacyExecutorGeneration(schemaVersion)) {
    task.executorBinding = null;
    task.lastExecutorProof = null;
  }
}

/** Read-only normalized binding view for T6 callers. */
export function runBindingForTask(task, schemaVersion) {
  const source = taskObject(task);
  if (isLegacyExecutorGeneration(schemaVersion)) {
    if (Object.hasOwn(source, "runBinding") || !Object.hasOwn(source, "executorBinding")) fail("legacy task has mixed binding fields");
    if (source.executorBinding === null) return null;
    const binding = exactObject(source.executorBinding, LEGACY_BINDING_FIELDS, "legacy executor binding");
    return { ...binding, agentProfile: "executor" };
  }
  if (schemaVersion !== "planned.v2" && schemaVersion !== "goal-runtime.v2") fail("schemaVersion is unsupported");
  if (Object.hasOwn(source, "executorBinding") || !Object.hasOwn(source, "runBinding")) fail("v2 task has mixed binding fields");
  if (source.runBinding === null) return null;
  return exactObject(source.runBinding, RUN_BINDING_FIELDS, "run binding");
}

/** Read-only normalized terminal-proof view for T6 callers. */
export function runProofForTask(task, schemaVersion) {
  const source = taskObject(task);
  if (isLegacyExecutorGeneration(schemaVersion)) {
    if (Object.hasOwn(source, "lastRunProof") || !Object.hasOwn(source, "lastExecutorProof")) fail("legacy task has mixed proof fields");
    if (source.lastExecutorProof === null) return null;
    const proof = exactObject(source.lastExecutorProof, LEGACY_PROOF_FIELDS, "legacy executor proof");
    return { ...proof, agentProfile: "executor" };
  }
  if (schemaVersion !== "planned.v2" && schemaVersion !== "goal-runtime.v2") fail("schemaVersion is unsupported");
  if (Object.hasOwn(source, "lastExecutorProof") || !Object.hasOwn(source, "lastRunProof")) fail("v2 task has mixed proof fields");
  if (source.lastRunProof === null) return null;
  return exactObject(source.lastRunProof, RUN_PROOF_FIELDS, "run proof");
}

/** Exact old broker proof reader. This is replay-only and never authorizes a run. */
export function executionProofForLegacyTask(task, proof) {
  const binding = runBindingForTask(task, "planned.v1");
  if (!binding) fail("legacy task has no binding");
  if (!proof || typeof proof !== "object" || Array.isArray(proof)
    || Object.keys(proof).length !== 4
    || proof.schemaVersion !== "root-broker.executor-proof.v1"
    || proof.terminalConflict !== false
    || !proof.ownership || !proof.terminal) fail("legacy broker proof is invalid");
  const ownership = proof.ownership, terminal = proof.terminal;
  if (Object.keys(ownership).length !== 6
    || ownership.runId !== binding.runId
    || ownership.asyncDir !== binding.asyncDir
    || ownership.role !== "executor"
    || ownership.identityState !== "verified"
    || typeof ownership.rootSessionId !== "string" || !ownership.rootSessionId
    || typeof ownership.sessionId !== "string" || !ownership.sessionId
    || Object.keys(terminal).length !== 3
    || !/^[a-f0-9]{64}$/.test(terminal.proofId || "")
    || !Number.isFinite(terminal.observedAt)
    || terminal.outcome !== "succeeded") fail("legacy broker proof identity is invalid");
  return Object.freeze({ runId: binding.runId, proofId: terminal.proofId, rootSessionId: ownership.rootSessionId, observedAt: terminal.observedAt, outcome: terminal.outcome, agentProfile: "executor" });
}
