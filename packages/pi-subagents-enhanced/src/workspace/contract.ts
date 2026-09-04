import { createHash } from "node:crypto";
import path from "node:path";

const REQUEST_KEYS = ["workspaceId", "owner", "originRoot", "requestedCwd", "originRef", "baseCommit", "contractHash", "mode", "writePaths"];
const RECEIPT_KEYS = ["schemaVersion", "workspaceId", "leaseId", "owner", "originRoot", "requestedCwd", "originRef", "baseCommit", "path", "dispatchCwd", "branchRef", "state", "run", "disposition", "cleanupDebt"];
const STATES = new Set(["reserved", "allocating", "active", "disposing", "preserved", "released", "cleanup-debt"]);
const MODES = new Set(["coding", "generic", "validation"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SHA256 = /^[a-f0-9]{64}$/;

function fail(message) {
  throw new TypeError(`Managed workspace contract: ${message}`);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactObject(value, location, keys) {
  if (!isPlainObject(value)) fail(`${location} must be an object`);
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${location} contains unknown field ${key}`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail(`${location} is missing required field ${key}`);
  }
  return value;
}

function text(value, location, { maxBytes = 4096 } = {}) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.includes("\0")) fail(`${location} must be a non-empty exact string`);
  if (Buffer.byteLength(value, "utf8") > maxBytes) fail(`${location} is too large`);
  return value;
}

function identity(value, location) {
  const result = text(value, location, { maxBytes: 160 });
  if (!SAFE_ID.test(result) || result.includes("..")) fail(`${location} must be a safe identity`);
  return result;
}

function positiveInteger(value, location) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${location} must be a positive safe integer`);
  return value;
}

function digest(value, location, pattern = SHA) {
  const result = text(value, location, { maxBytes: 64 });
  if (!pattern.test(result)) fail(`${location} must be a lowercase hexadecimal digest`);
  return result;
}

function absolutePath(value, location) {
  const result = text(value, location);
  if (!path.isAbsolute(result) || path.normalize(result) !== result) fail(`${location} must be a normalized absolute path`);
  return result;
}

function inside(root, candidate, location) {
  const relative = path.relative(root, candidate);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) fail(`${location} must remain inside its owner path`);
  return candidate;
}

function gitRef(value, location) {
  const result = text(value, location);
  if (!/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(result)
      || result.includes("//") || result.includes("..") || result.includes("@{") || result.endsWith("/") || result.includes("\\")) {
    fail(`${location} must be a safe full branch ref`);
  }
  return result;
}

function writePath(value, location) {
  const result = text(value, location);
  if (result.startsWith("/") || result.includes("\\") || /^[A-Za-z]:\//.test(result)) fail(`${location} must be repo-relative POSIX`);
  const recursive = result.endsWith("/**");
  const base = recursive ? result.slice(0, -3) : result;
  if (!base || base.endsWith("/") || /[*?\[\]{}]/.test(base)) fail(`${location} has an unsupported pattern`);
  if (base.split("/").some((segment) => !segment || segment === "." || segment === "..")) fail(`${location} has an unsafe segment`);
  return result;
}

function writePaths(value, mode) {
  if (!Array.isArray(value) || value.length > 32) fail("writePaths must be a bounded array");
  const result = [...new Set(value.map((entry, index) => writePath(entry, `writePaths[${index}]`)))];
  if (mode === "coding" && result.length === 0) fail("coding writePaths must not be empty");
  if (mode !== "coding" && result.length !== 0) fail(`${mode} writePaths must be empty`);
  return result;
}

function owner(value) {
  if (!isPlainObject(value)) fail("owner must be an object");
  if (value.kind === "standalone-subagent") {
    exactObject(value, "owner", ["kind", "rootSessionId", "toolCallId"]);
    return { kind: value.kind, rootSessionId: identity(value.rootSessionId, "owner.rootSessionId"), toolCallId: identity(value.toolCallId, "owner.toolCallId") };
  }
  if (value.kind === "goal-task") {
    exactObject(value, "owner", ["kind", "rootSessionId", "goalId", "taskId", "attempt", "executionRevision"]);
    return {
      kind: value.kind,
      rootSessionId: identity(value.rootSessionId, "owner.rootSessionId"),
      goalId: identity(value.goalId, "owner.goalId"),
      taskId: identity(value.taskId, "owner.taskId"),
      attempt: positiveInteger(value.attempt, "owner.attempt"),
      executionRevision: positiveInteger(value.executionRevision, "owner.executionRevision"),
    };
  }
  if (value.kind === "goal-validation") {
    exactObject(value, "owner", ["kind", "rootSessionId", "goalId", "validationId", "executionRevision"]);
    return {
      kind: value.kind,
      rootSessionId: identity(value.rootSessionId, "owner.rootSessionId"),
      goalId: identity(value.goalId, "owner.goalId"),
      validationId: identity(value.validationId, "owner.validationId"),
      executionRevision: positiveInteger(value.executionRevision, "owner.executionRevision"),
    };
  }
  fail("owner.kind is unsupported");
}

function cloneFrozen(value) {
  const clone = structuredClone(value);
  function freeze(current) {
    if (!current || typeof current !== "object" || Object.isFrozen(current)) return current;
    for (const child of Object.values(current)) freeze(child);
    return Object.freeze(current);
  }
  return freeze(clone);
}

function normalizeRequest(value) {
  const input = exactObject(value, "request", REQUEST_KEYS);
  const mode = text(input.mode, "mode", { maxBytes: 16 });
  if (!MODES.has(mode)) fail("mode is unsupported");
  const normalizedOwner = owner(input.owner);
  if (mode === "validation" ? normalizedOwner.kind !== "goal-validation" : mode === "generic" ? normalizedOwner.kind !== "standalone-subagent" : normalizedOwner.kind === "goal-validation") {
    fail(`owner is incompatible with ${mode} mode`);
  }
  const originRoot = absolutePath(input.originRoot, "originRoot");
  const requestedCwd = inside(originRoot, absolutePath(input.requestedCwd, "requestedCwd"), "requestedCwd");
  return {
    workspaceId: identity(input.workspaceId, "workspaceId"),
    owner: normalizedOwner,
    originRoot,
    requestedCwd,
    originRef: gitRef(input.originRef, "originRef"),
    baseCommit: digest(input.baseCommit, "baseCommit"),
    contractHash: digest(input.contractHash, "contractHash", SHA256),
    mode,
    writePaths: writePaths(input.writePaths, mode),
  };
}

export function createManagedWorkspaceRequest(value) {
  return cloneFrozen(normalizeRequest(value));
}

function run(value) {
  if (value === null) return null;
  const input = exactObject(value, "run", ["runId", "asyncDir"]);
  return { runId: identity(input.runId, "run.runId"), asyncDir: absolutePath(input.asyncDir, "run.asyncDir") };
}

function disposition(value) {
  if (value === null) return null;
  if (!isPlainObject(value)) fail("disposition must be an object or null");
  if (value.action === "integrate") {
    exactObject(value, "disposition", ["action", "strategy"]);
    if (value.strategy !== "cherry-pick" && value.strategy !== "merge") fail("disposition.strategy is unsupported");
    return { action: value.action, strategy: value.strategy };
  }
  if (value.action === "discard") {
    exactObject(value, "disposition", ["action"]);
    return { action: value.action };
  }
  if (value.action === "preserve") {
    exactObject(value, "disposition", ["action", "reason"]);
    return { action: value.action, reason: text(value.reason, "disposition.reason") };
  }
  fail("disposition.action is unsupported");
}

function cleanupDebt(value) {
  if (value === null) return null;
  const input = exactObject(value, "cleanupDebt", ["phase", "code", "message"]);
  return { phase: identity(input.phase, "cleanupDebt.phase"), code: identity(input.code, "cleanupDebt.code"), message: text(input.message, "cleanupDebt.message") };
}

function normalizeReceipt(value) {
  const input = exactObject(value, "receipt", RECEIPT_KEYS);
  if (input.schemaVersion !== "managed-workspace.v1") fail("schemaVersion is unsupported");
  const state = text(input.state, "state", { maxBytes: 32 });
  if (!STATES.has(state)) fail("state is unsupported");
  const normalizedOwner = owner(input.owner);
  const originRoot = absolutePath(input.originRoot, "originRoot");
  const requestedCwd = inside(originRoot, absolutePath(input.requestedCwd, "requestedCwd"), "requestedCwd");
  const workspacePath = absolutePath(input.path, "path");
  const dispatchCwd = inside(workspacePath, absolutePath(input.dispatchCwd, "dispatchCwd"), "dispatchCwd");
  const normalizedDisposition = disposition(input.disposition);
  const normalizedDebt = cleanupDebt(input.cleanupDebt);
  if (state === "cleanup-debt" ? normalizedDebt === null : normalizedDebt !== null) fail("cleanupDebt must match state");
  if (state === "disposing" && normalizedDisposition === null) fail("disposing receipt requires disposition");
  if (["reserved", "allocating", "active"].includes(state) && normalizedDisposition !== null) fail(`${state} receipt cannot have disposition`);
  if (state === "preserved" && normalizedDisposition?.action !== "preserve") fail("preserved receipt requires preserve disposition");
  if (state === "released" && normalizedDisposition === null) fail("released receipt requires disposition");
  return {
    schemaVersion: input.schemaVersion,
    workspaceId: identity(input.workspaceId, "workspaceId"),
    leaseId: digest(input.leaseId, "leaseId", SHA256),
    owner: normalizedOwner,
    originRoot,
    requestedCwd,
    originRef: gitRef(input.originRef, "originRef"),
    baseCommit: digest(input.baseCommit, "baseCommit"),
    path: workspacePath,
    dispatchCwd,
    branchRef: gitRef(input.branchRef, "branchRef"),
    state,
    run: run(input.run),
    disposition: normalizedDisposition,
    cleanupDebt: normalizedDebt,
  };
}

export function validateManagedWorkspaceReceipt(value) {
  return cloneFrozen(normalizeReceipt(value));
}

export function publicManagedWorkspaceReceipt(value) {
  if (!isPlainObject(value)) fail("receipt must be an object");
  const allowed = new Set([...RECEIPT_KEYS, "ownerToken"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`receipt contains unknown field ${key}`);
  }
  const projected = Object.fromEntries(RECEIPT_KEYS.map((key) => [key, value[key]]));
  if (Object.hasOwn(value, "ownerToken")) {
    const token = text(value.ownerToken, "ownerToken");
    if (!/^managed-workspace-owner\.v1:[a-f0-9]{64}$/.test(token)) fail("ownerToken is invalid");
    const expectedLeaseId = createHash("sha256").update(token).digest("hex");
    if (projected.leaseId !== expectedLeaseId) fail("leaseId does not match ownerToken");
  }
  return validateManagedWorkspaceReceipt(projected);
}

export function deterministicGoalWorkspaceId(value) {
  const input = exactObject(value, "Goal workspace identity", ["goalId", "taskId", "attempt", "executionRevision", "contractHash", "baseCommit"]);
  const facts = [
    "managed-workspace-goal-id.v1",
    identity(input.goalId, "goalId"),
    identity(input.taskId, "taskId"),
    positiveInteger(input.attempt, "attempt"),
    positiveInteger(input.executionRevision, "executionRevision"),
    digest(input.contractHash, "contractHash", SHA256),
    digest(input.baseCommit, "baseCommit"),
  ];
  return `goal-${createHash("sha256").update(facts.join("\0")).digest("hex")}`;
}
