const LEGACY_GRANT_SCHEMA = "pi-root-subagent-broker-grant.v1";
const LEGACY_PROOF_SCHEMA = "root-broker.executor-proof.v1";
const CAPABILITIES = Object.freeze(["acceptance.submit", "root.subscribe"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const PROOF_ID = /^[a-f0-9]{64}$/;

function exact(value: unknown, name: string, keys: string[], fail: (message: string) => never): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${name} must be an object`);
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== keys.length || keys.some((key) => !Object.hasOwn(object, key)) || Object.keys(object).some((key) => !keys.includes(key))) fail(`${name} must contain exact fields`);
  return object;
}

function id(value: unknown, name: string, fail: (message: string) => never): string {
  if (typeof value !== "string" || !ID.test(value) || value === "." || value === "..") fail(`${name} must be a safe non-path identity`);
  return value;
}

/** Read-only adapter for persisted grants written before capability grants. */
export function readLegacyExecutorGrant(value: unknown, fail: (message: string) => never) {
  const grant = exact(value, "grant", ["schemaVersion", "rootSessionId", "runId", "callerToken", "role"], fail);
  if (grant.schemaVersion !== LEGACY_GRANT_SCHEMA || grant.role !== "executor") fail("grant.schemaVersion or role is unsupported");
  if (typeof grant.callerToken !== "string" || !TOKEN.test(grant.callerToken)) fail("callerToken must be 64 lowercase hexadecimal characters");
  return Object.freeze({
    schemaVersion: "pi-root-subagent-broker-grant.v2" as const,
    rootSessionId: id(grant.rootSessionId, "rootSessionId", fail),
    runId: id(grant.runId, "runId", fail),
    callerToken: grant.callerToken,
    capabilities: [...CAPABILITIES],
  });
}

/** Read-only adapter for the retired Goal inspector proof shape. */
/** Registry-bound v1 settlement adapter. Canonical envelope outcome lives in terminal,
 * never in the raw upstream process-terminal proof. */
export function executionProofForLegacySettlement(value: unknown, fail: (message: string) => never) {
  const envelope = exact(value, "execution proof", ["schemaVersion", "binding", "authorization", "capabilities", "terminal", "terminalConflict"], fail);
  if (envelope.schemaVersion !== "root-broker.execution-proof.v2" || envelope.terminalConflict !== false) fail("execution proof schema or conflict flag is unsupported");
  const binding = exact(envelope.binding, "execution proof binding", ["rootSessionId", "runId", "asyncDir", "sessionId", "pid", "agentProfile"], fail);
  const authorization = exact(envelope.authorization, "execution proof authorization", ["state"], fail);
  if (authorization.state !== "verified" || typeof binding.asyncDir !== "string" || !binding.asyncDir.startsWith("/") || binding.asyncDir.includes("\0")) fail("execution proof authorization is unsupported");
  if (!Array.isArray(envelope.capabilities) || !envelope.capabilities.includes("acceptance.submit")) fail("execution proof capabilities are unsupported");
  const terminal = exact(envelope.terminal, "execution proof terminal", ["proofId", "observedAt", "outcome", "proof"], fail);
  if (typeof terminal.proofId !== "string" || !PROOF_ID.test(terminal.proofId) || !Number.isFinite(terminal.observedAt) || !["succeeded", "failed"].includes(terminal.outcome as string)) fail("execution proof terminal is unsupported");
  return Object.freeze({ runId: id(binding.runId, "runId", fail), proofId: terminal.proofId, rootSessionId: id(binding.rootSessionId, "rootSessionId", fail), observedAt: terminal.observedAt as number, outcome: terminal.outcome as "succeeded" | "failed", agentProfile: id(binding.agentProfile, "agentProfile", fail) });
}

export function readLegacyExecutorProof(value: unknown, fail: (message: string) => never) {
  const proof = exact(value, "executor proof", ["schemaVersion", "ownership", "terminal", "terminalConflict"], fail);
  if (proof.schemaVersion !== LEGACY_PROOF_SCHEMA || typeof proof.terminalConflict !== "boolean") fail("executor proof schema or conflict flag is unsupported");
  const ownership = exact(proof.ownership, "executor proof ownership", ["rootSessionId", "runId", "role", "asyncDir", "sessionId", "identityState"], fail);
  if (ownership.role !== "executor" || ownership.identityState !== "verified" || typeof ownership.asyncDir !== "string" || !ownership.asyncDir.startsWith("/") || ownership.asyncDir.includes("\0")) fail("executor proof ownership is unsupported");
  const binding = {
    rootSessionId: id(ownership.rootSessionId, "rootSessionId", fail),
    runId: id(ownership.runId, "runId", fail),
    asyncDir: ownership.asyncDir,
    sessionId: id(ownership.sessionId, "sessionId", fail),
    agentProfile: "executor",
  };
  let terminal = null;
  if (proof.terminal !== null) {
    const observed = exact(proof.terminal, "executor proof terminal", ["proofId", "observedAt", "outcome"], fail);
    if (typeof observed.proofId !== "string" || !PROOF_ID.test(observed.proofId) || !Number.isFinite(observed.observedAt) || !["succeeded", "failed"].includes(observed.outcome as string)) fail("executor proof terminal is unsupported");
    terminal = { proofId: observed.proofId, observedAt: observed.observedAt as number, outcome: observed.outcome as "succeeded" | "failed" };
  }
  return Object.freeze({ schemaVersion: "root-broker.execution-proof.v2" as const, binding, capabilities: [...CAPABILITIES], terminal, terminalConflict: proof.terminalConflict });
}
