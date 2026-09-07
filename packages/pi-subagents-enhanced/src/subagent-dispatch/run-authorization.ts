import path from "node:path";

export type ExecutionKind = "coding" | "generic";
export type RunCapability = "root.subscribe" | "acceptance.submit";

export type RunBindingIdentity = {
  runId: string;
  asyncDir: string;
  sessionId: string;
  pid: number;
  agentProfile: string;
};

export type GoalRunAuthority = {
  ticketId: string;
  goalId: string;
  taskId: string;
  attempt: number;
  contractHash: string;
  workspaceId: string;
  executionRevision: number;
  expectedCriteria: string[];
};

export type RunAuthorization = {
  version: "subagent-run-authorization.v1";
  kind: ExecutionKind;
  binding: RunBindingIdentity;
  capabilities: RunCapability[];
  goal: GoalRunAuthority | null;
};

type CreateRunAuthorizationInput = {
  kind: ExecutionKind;
  binding: RunBindingIdentity;
  goal: GoalRunAuthority | null;
};

const AUTHORIZATION_KEYS = ["version", "kind", "binding", "capabilities", "goal"];
const INPUT_KEYS = ["kind", "binding", "goal"];
const BINDING_KEYS = ["runId", "asyncDir", "sessionId", "pid", "agentProfile"];
const GOAL_KEYS = ["ticketId", "goalId", "taskId", "attempt", "contractHash", "workspaceId", "executionRevision", "expectedCriteria"];
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_CRITERIA = 32;
const MAX_AGENT_PROFILE_BYTES = 256;
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F-\u009F]/;

function fail(message: string): never {
  throw new Error(`Run authorization is invalid: ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactObject(value: unknown, keys: string[], label: string): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) fail(`${label} must be an exact object`);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) fail(`${label} contains unknown or missing fields`);
}

function safeIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value) || value.includes("..")) fail(`${label} must be a safe identity`);
  return value;
}

function agentProfileIdentity(value: unknown): string {
  if (typeof value !== "string") fail("binding.agentProfile must be a string");
  const normalized = value.trim();
  if (!normalized || CONTROL_CHARACTER.test(normalized) || Buffer.byteLength(normalized, "utf8") > MAX_AGENT_PROFILE_BYTES) {
    fail("binding.agentProfile must be a non-empty public profile identity without control characters and at most 256 UTF-8 bytes");
  }
  return normalized;
}

function lifecycleSessionIdentity(value: unknown): string {
  if (typeof value !== "string" || !value || CONTROL_CHARACTER.test(value) || Buffer.byteLength(value, "utf8") > 4096) {
    fail("binding.sessionId must be a bounded lifecycle identity without control characters");
  }
  // upstream 持久化会话使用 sessionFile；它不是 grant 路径使用的 rootSessionId。
  if (path.isAbsolute(value) && path.normalize(value) === value && value !== path.parse(value).root) return value;
  return safeIdentity(value, "binding.sessionId");
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(`${label} must be a lowercase SHA-256 hash`);
  return value;
}

function absolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.includes("\0") || !path.isAbsolute(value) || path.normalize(value) !== value) fail(`${label} must be a normalized absolute path`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${label} must be a positive safe integer`);
  return value;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function normalizeBinding(value: unknown): RunBindingIdentity {
  assertExactObject(value, BINDING_KEYS, "binding");
  return {
    runId: safeIdentity(value.runId, "binding.runId"),
    asyncDir: absolutePath(value.asyncDir, "binding.asyncDir"),
    sessionId: lifecycleSessionIdentity(value.sessionId),
    pid: positiveInteger(value.pid, "binding.pid"),
    agentProfile: agentProfileIdentity(value.agentProfile),
  };
}

function normalizeCriteria(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CRITERIA) fail("goal.expectedCriteria must be a non-empty bounded array");
  const criteria = Array.from(value, (criterion, index) => safeIdentity(criterion, `goal.expectedCriteria[${index}]`));
  if (new Set(criteria).size !== criteria.length) fail("goal.expectedCriteria must not contain duplicates");
  return criteria;
}

function normalizeGoal(value: unknown): GoalRunAuthority | null {
  if (value === null) return null;
  assertExactObject(value, GOAL_KEYS, "goal");
  return {
    ticketId: sha256(value.ticketId, "goal.ticketId"),
    goalId: safeIdentity(value.goalId, "goal.goalId"),
    taskId: safeIdentity(value.taskId, "goal.taskId"),
    attempt: positiveInteger(value.attempt, "goal.attempt"),
    contractHash: sha256(value.contractHash, "goal.contractHash"),
    workspaceId: safeIdentity(value.workspaceId, "goal.workspaceId"),
    executionRevision: positiveInteger(value.executionRevision, "goal.executionRevision"),
    expectedCriteria: normalizeCriteria(value.expectedCriteria),
  };
}

function normalizeKind(value: unknown): ExecutionKind {
  if (value !== "coding" && value !== "generic") fail("kind must be coding or generic");
  return value;
}

export function capabilitiesForRun(input: { kind: ExecutionKind; goal: GoalRunAuthority | null }): RunCapability[] {
  assertExactObject(input, ["kind", "goal"], "capability input");
  const kind = normalizeKind(input.kind);
  const goal = normalizeGoal(input.goal);
  if (kind === "generic") {
    if (goal !== null) fail("generic runs cannot carry Goal authority");
    return [];
  }
  return goal === null ? ["root.subscribe"] : ["acceptance.submit", "root.subscribe"];
}

export function createRunAuthorization(input: CreateRunAuthorizationInput): Readonly<RunAuthorization> {
  assertExactObject(input, INPUT_KEYS, "authorization input");
  const kind = normalizeKind(input.kind);
  const binding = normalizeBinding(input.binding);
  const goal = normalizeGoal(input.goal);
  const capabilities = capabilitiesForRun({ kind, goal });
  return deepFreeze({
    version: "subagent-run-authorization.v1",
    kind,
    binding,
    capabilities,
    goal,
  }) as Readonly<RunAuthorization>;
}

export function assertRunAuthorization(value: unknown): asserts value is Readonly<RunAuthorization> {
  assertExactObject(value, AUTHORIZATION_KEYS, "authorization");
  if (value.version !== "subagent-run-authorization.v1") fail("authorization.version is unsupported");
  const kind = normalizeKind(value.kind);
  const binding = normalizeBinding(value.binding);
  const goal = normalizeGoal(value.goal);
  const capabilities = capabilitiesForRun({ kind, goal });
  if (!Array.isArray(value.capabilities) || value.capabilities.length !== capabilities.length || value.capabilities.some((capability, index) => capability !== capabilities[index])) {
    fail("authorization.capabilities must match the canonical authorization matrix");
  }
  if (!Object.isFrozen(value) || !Object.isFrozen(value.binding) || !Object.isFrozen(value.capabilities) || (value.goal !== null && (!Object.isFrozen(value.goal) || !Object.isFrozen(value.goal.expectedCriteria)))) {
    fail("authorization must be deeply frozen");
  }
  void binding;
}
