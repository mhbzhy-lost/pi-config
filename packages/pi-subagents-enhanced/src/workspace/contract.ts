import { createHash } from "node:crypto";
import path from "node:path";

const REQUEST_V2_KEYS = ["workspaceId", "owner", "originRoot", "requestedCwd", "originRef", "baseCommit", "contractHash", "policy"];
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SHA256 = /^[a-f0-9]{64}$/;

export const WORKSPACE_COORDINATOR_PROTOCOL = "repository-workspace-coordinator.v1";

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

function writePaths(value) {
  if (!Array.isArray(value) || value.length > 32) fail("policy.writePaths must be a bounded array");
  return [...new Set(value.map((entry, index) => writePath(entry, `policy.writePaths[${index}]`)))];
}

function policy(value) {
  const input = exactObject(value, "policy", ["publication", "application", "writePaths"]);
  if (input.publication !== "forbidden" && input.publication !== "allowed") fail("policy.publication is unsupported");
  if (input.application !== "forbidden" && input.application !== "allowed") fail("policy.application is unsupported");
  const normalizedWritePaths = writePaths(input.writePaths);
  if (input.application === "allowed" && input.publication !== "allowed") fail("policy.application requires allowed publication");
  if (input.application === "allowed" && normalizedWritePaths.length === 0) fail("policy.application requires non-empty writePaths");
  return { publication: input.publication, application: input.application, writePaths: normalizedWritePaths };
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

function normalizeRequestV2(value) {
  const input = exactObject(value, "request", REQUEST_V2_KEYS);
  const normalizedOwner = owner(input.owner);
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
    policy: policy(input.policy),
  };
}

export function createManagedWorkspaceRequestV2(value) {
  return cloneFrozen(normalizeRequestV2(value));
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
