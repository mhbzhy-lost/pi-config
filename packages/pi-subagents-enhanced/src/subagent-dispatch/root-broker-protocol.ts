import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const REQUEST_SCHEMA_VERSION = "pi-root-subagent-broker-request.v1";
const PUSH_SCHEMA_VERSION = "pi-root-subagent-broker-push.v1";
const GRANT_SCHEMA_VERSION = "pi-root-subagent-broker-grant.v1";
const RESPONSE_SCHEMA_VERSION = "pi-root-subagent-broker-response.v1";
const SOCKET_PATH_LIMIT = 103;
const ERROR_MESSAGE_LIMIT = 1024;
export const BROKER_FRAME_LIMIT_BYTES = 64 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const METHODS = Object.freeze(["ping", "subscribe", "acceptance.submit"] as const);
const PUSH_TYPES = Object.freeze(["root.closing", "subscription.ready"] as const);
const GRANT_ROLES = Object.freeze(["executor"] as const);
const PROCESS_TERMINAL_STATES = Object.freeze(["pending", "observed", "unknown", "not-started"] as const);
const PROCESS_TERMINAL_REASONS = Object.freeze([
  "observer-unavailable",
  "runner-candidate-missing",
  "runner-instance-mismatch",
  "writer-close-unverified",
  "canonical-session-unavailable",
  "canonical-session-lease-active",
  "canonical-session-release-unverified",
  "proof-write-failed",
  "stale-repair",
] as const);

export const BROKER_METHODS = METHODS;

export type BrokerMethod = (typeof METHODS)[number];
export type BrokerRequest = {
  schemaVersion: "pi-root-subagent-broker-request.v1";
  requestId: string;
  rootSessionId: string;
  callerRunId: string;
  callerToken: string;
  method: BrokerMethod;
  params: Record<string, unknown>;
};
export type BrokerPush = {
  schemaVersion: "pi-root-subagent-broker-push.v1";
  rootSessionId: string;
  callerRunId: string;
  type: (typeof PUSH_TYPES)[number];
  data: Record<string, unknown>;
};
export type BrokerGrant = {
  schemaVersion: "pi-root-subagent-broker-grant.v1";
  rootSessionId: string;
  runId: string;
  callerToken: string;
  role: (typeof GRANT_ROLES)[number];
};
export type BrokerResponse = {
  schemaVersion: "pi-root-subagent-broker-response.v1";
  requestId: string;
  rootSessionId: string;
  callerRunId: string;
  success: true;
  data: unknown;
} | {
  schemaVersion: "pi-root-subagent-broker-response.v1";
  requestId: string;
  rootSessionId: string;
  callerRunId: string;
  success: false;
  error: {
    code: string;
    message: string;
  };
};
export type BrokerResponseIdentity = {
  requestId?: string;
  rootSessionId?: string;
  callerRunId?: string;
};

export class BrokerProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = "BrokerProtocolError";
  }
}

function fail(message) {
  throw new BrokerProtocolError(message);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactObject(value, name, keys) {
  if (!isPlainObject(value)) fail(`${name} must be an object`);
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${name} contains unknown field ${key}`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail(`${name} is missing required field ${key}`);
  }
  return value;
}

function identity(value, name) {
  if (typeof value !== "string" || !ID_PATTERN.test(value) || value === "." || value === "..") {
    fail(`${name} must be a safe non-path identity`);
  }
  return value;
}

function callerToken(value) {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) fail("callerToken must be 64 lowercase hexadecimal characters");
  return value;
}

function record(value, name) {
  if (!isPlainObject(value)) fail(`${name} must be an object`);
  return value;
}

function nonEmptyString(value, name) {
  if (typeof value !== "string" || value.length === 0) fail(`${name} must be a non-empty string`);
  return value;
}

function boundedString(value, name, maxBytes = 4096) {
  const result = nonEmptyString(value, name);
  if (Buffer.byteLength(result, "utf8") > maxBytes) fail(`${name} exceeds ${maxBytes} UTF-8 bytes`);
  return result;
}

function boundedArray(value, name, { min = 0, max = 32 } = {}) {
  if (!Array.isArray(value)) fail(`${name} must be an array`);
  if (value.length < min || value.length > max) fail(`${name} must contain between ${min} and ${max} items`);
  return value;
}

function immutableRef(value, name) {
  const result = boundedString(value, name);
  if (!/^(?:sha256:[a-f0-9]{64}|cas:\/\/sha256\/[a-f0-9]{64})$/.test(result)) {
    fail(`${name} must be an immutable SHA-256 reference`);
  }
  return result;
}

function repoRelativePath(value, name) {
  const result = boundedString(value, name);
  if (result.startsWith("/") || result.includes("\\") || result.includes("\u0000")
    || result.split("/").some((component) => component === "" || component === "." || component === "..")) {
    fail(`${name} must be a normalized repository-relative POSIX path`);
  }
  return result;
}

function acceptanceParams(value) {
  const params = exactObject(value, "params", ["outcome", "criteria", "commandsRun", "changedFiles"]);
  if (params.outcome !== "succeeded" && params.outcome !== "failed") fail("params.outcome is unsupported");
  const criterionIds = new Set();
  for (const [index, value] of boundedArray(params.criteria, "params.criteria", { min: 1 }).entries()) {
    const criterion = exactObject(value, `params.criteria[${index}]`, ["id", "status", "evidence"]);
    const id = boundedString(criterion.id, `params.criteria[${index}].id`, 160);
    if (criterionIds.has(id)) fail("params.criteria contains duplicate IDs");
    criterionIds.add(id);
    if (!["satisfied", "not-satisfied", "not-applicable"].includes(criterion.status)) {
      fail(`params.criteria[${index}].status is unsupported`);
    }
    const refs = boundedArray(criterion.evidence, `params.criteria[${index}].evidence`, { min: 1 });
    const uniqueRefs = new Set();
    for (const [refIndex, ref] of refs.entries()) {
      const normalized = immutableRef(ref, `params.criteria[${index}].evidence[${refIndex}]`);
      if (uniqueRefs.has(normalized)) fail(`params.criteria[${index}].evidence contains duplicate references`);
      uniqueRefs.add(normalized);
    }
  }
  for (const [index, value] of boundedArray(params.commandsRun, "params.commandsRun").entries()) {
    const command = exactObject(value, `params.commandsRun[${index}]`, ["command", "result", "outputRef"]);
    boundedString(command.command, `params.commandsRun[${index}].command`);
    if (command.result !== "passed" && command.result !== "failed") fail(`params.commandsRun[${index}].result is unsupported`);
    immutableRef(command.outputRef, `params.commandsRun[${index}].outputRef`);
  }
  const changedFiles = new Set();
  for (const [index, value] of boundedArray(params.changedFiles, "params.changedFiles").entries()) {
    const file = repoRelativePath(value, `params.changedFiles[${index}]`);
    if (changedFiles.has(file)) fail("params.changedFiles contains duplicates");
    changedFiles.add(file);
  }
  return params;
}

function exactOptionalObject(value, name, required, optional = []) {
  if (!isPlainObject(value)) fail(`${name} must be an object`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${name} contains unknown field ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${name} is missing required field ${key}`);
  }
  return value;
}

export function parseProcessTerminal(value) {
  const terminal = exactOptionalObject(value, "push.data.processTerminal", ["version", "runnerProcessInstanceId", "state"], ["childIndex", "resumeDisposition", "observedAt", "instances", "canonicalSession", "reason", "diagnostic"]);
  if (terminal.version !== 1) fail("push.data.processTerminal.version must equal 1");
  nonEmptyString(terminal.runnerProcessInstanceId, "push.data.processTerminal.runnerProcessInstanceId");
  if (typeof terminal.state !== "string" || !PROCESS_TERMINAL_STATES.includes(terminal.state)) fail("push.data.processTerminal.state is unsupported");
  if (terminal.childIndex !== undefined && (!Number.isSafeInteger(terminal.childIndex) || terminal.childIndex < 0)) fail("push.data.processTerminal.childIndex must be a non-negative safe integer");
  if (terminal.resumeDisposition !== undefined && !["resumable", "non-resumable", "unavailable"].includes(terminal.resumeDisposition)) fail("push.data.processTerminal.resumeDisposition is unsupported");

  if (terminal.state === "pending" || terminal.state === "not-started") {
    exactOptionalObject(terminal, "push.data.processTerminal", ["version", "runnerProcessInstanceId", "state"], ["childIndex", "resumeDisposition"]);
  } else if (terminal.state === "unknown") {
    exactOptionalObject(terminal, "push.data.processTerminal", ["version", "runnerProcessInstanceId", "state", "reason"], ["childIndex", "resumeDisposition", "diagnostic"]);
    if (typeof terminal.reason !== "string" || !PROCESS_TERMINAL_REASONS.includes(terminal.reason)) fail("push.data.processTerminal.reason is unsupported");
    if (terminal.diagnostic !== undefined && typeof terminal.diagnostic !== "string") fail("push.data.processTerminal.diagnostic must be a string");
  } else {
    exactOptionalObject(terminal, "push.data.processTerminal", ["version", "runnerProcessInstanceId", "state", "observedAt", "instances"], ["childIndex", "resumeDisposition", "canonicalSession"]);
    if (typeof terminal.observedAt !== "number" || !Number.isFinite(terminal.observedAt)) fail("push.data.processTerminal.observedAt must be finite");
    if (!Array.isArray(terminal.instances)) fail("push.data.processTerminal.instances must be an array");
    let matchingRunner = false;
    for (const [index, instance] of terminal.instances.entries()) {
      const instanceName = `push.data.processTerminal.instances[${index}]`;
      if (!isPlainObject(instance) || (instance.kind !== "runner" && instance.kind !== "pi-writer")) fail(`${instanceName} is unsupported`);
      const required = instance.kind === "runner" ? ["processInstanceId", "kind", "closeObservedAt", "exitCode", "signal"] : ["processInstanceId", "kind", "attempt", "closeObservedAt", "exitCode", "signal"];
      exactOptionalObject(instance, instanceName, required);
      nonEmptyString(instance.processInstanceId, `${instanceName}.processInstanceId`);
      if (typeof instance.closeObservedAt !== "number" || !Number.isFinite(instance.closeObservedAt)) fail(`${instanceName}.closeObservedAt must be finite`);
      if (instance.exitCode !== null && !Number.isInteger(instance.exitCode)) fail(`${instanceName}.exitCode must be an integer or null`);
      if (instance.signal !== null && typeof instance.signal !== "string") fail(`${instanceName}.signal must be a string or null`);
      if (instance.kind === "pi-writer" && (!Number.isSafeInteger(instance.attempt) || instance.attempt < 0)) fail(`${instanceName}.attempt must be a non-negative safe integer`);
      if (instance.kind === "runner" && instance.processInstanceId === terminal.runnerProcessInstanceId) matchingRunner = true;
    }
    if (!matchingRunner) fail("push.data.processTerminal.instances must contain the matching runner instance");
    if (terminal.canonicalSession !== undefined) {
      const session = exactOptionalObject(terminal.canonicalSession, "push.data.processTerminal.canonicalSession", ["canonicalSessionId", "leaseDisposition", "freeAtObservation"], ["canonicalSessionLeaseReleased"]);
      nonEmptyString(session.canonicalSessionId, "push.data.processTerminal.canonicalSession.canonicalSessionId");
      if (session.leaseDisposition !== "released" && session.leaseDisposition !== "not-held") fail("push.data.processTerminal.canonicalSession.leaseDisposition is unsupported");
      if (session.freeAtObservation !== true) fail("push.data.processTerminal.canonicalSession.freeAtObservation must equal true");
      if (session.canonicalSessionLeaseReleased !== undefined && session.canonicalSessionLeaseReleased !== true) fail("push.data.processTerminal.canonicalSession.canonicalSessionLeaseReleased must equal true");
    }
  }
  return terminal;
}

function assertPushFrameSize(push) {
  try {
    const frame = `${JSON.stringify(push)}\n`;
    const size = Buffer.byteLength(frame, "utf8");
    if (size > BROKER_FRAME_LIMIT_BYTES) fail(`push frame is too large: ${size} bytes exceeds ${BROKER_FRAME_LIMIT_BYTES}`);
  } catch (error) {
    if (error instanceof BrokerProtocolError) throw error;
    fail("push frame must be JSON serializable");
  }
}

function responseData(value) {
  if (value === undefined) fail("response.data must not be undefined");
  try {
    if (!Object.hasOwn(JSON.parse(JSON.stringify({ data: value })), "data")) {
      fail("response.data must be JSON serializable");
    }
  } catch (error) {
    if (error instanceof BrokerProtocolError) throw error;
    fail("response.data must be JSON serializable");
  }
  return value;
}

function errorMessage(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > ERROR_MESSAGE_LIMIT) {
    fail(`error.message must be a non-empty string of at most ${ERROR_MESSAGE_LIMIT} characters`);
  }
  return value;
}

function shortRoot() {
  const uid = typeof process.getuid === "function" ? process.getuid() : process.pid;
  return `/tmp/pi-root-subagent-${uid}`;
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertShortPath(value) {
  if (Buffer.byteLength(value, "utf8") > SOCKET_PATH_LIMIT) fail("broker path exceeds 103 UTF-8 bytes");
  return value;
}

export function resolveRootSessionId(sessionManager) {
  const sessionId = sessionManager?.getSessionId?.();
  return identity(sessionId, "rootSessionId");
}

export function brokerSocketPath(rootSessionId) {
  return assertShortPath(path.posix.join(shortRoot(), `${digest(identity(rootSessionId, "rootSessionId"))}.sock`));
}

export function brokerGrantPath(rootSessionId, runId) {
  return assertShortPath(path.posix.join(shortRoot(), "grants", `${digest(`${identity(rootSessionId, "rootSessionId")}\u0000${identity(runId, "runId")}`)}.json`));
}

export async function ensureBrokerSocketDirectory(rootSessionId) {
  const socketPath = brokerSocketPath(rootSessionId);
  const directory = path.posix.dirname(socketPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  return directory;
}

export async function setBrokerSocketPermissions(socketPath) {
  await chmod(socketPath, 0o600);
}

export function parseBrokerRequest(value) {
  const request = exactObject(value, "request", ["schemaVersion", "requestId", "rootSessionId", "callerRunId", "callerToken", "method", "params"]);
  if (request.schemaVersion !== REQUEST_SCHEMA_VERSION) fail("request.schemaVersion is unsupported");
  identity(request.requestId, "requestId");
  identity(request.rootSessionId, "rootSessionId");
  identity(request.callerRunId, "callerRunId");
  callerToken(request.callerToken);
  if (typeof request.method !== "string" || !METHODS.includes(request.method)) fail("request.method is unsupported");
  if (request.method === "acceptance.submit") acceptanceParams(request.params);
  else exactObject(request.params, "params", []);
  try {
    const size = Buffer.byteLength(`${JSON.stringify(request)}\n`, "utf8");
    if (size > BROKER_FRAME_LIMIT_BYTES) fail(`request frame is too large: ${size} bytes exceeds ${BROKER_FRAME_LIMIT_BYTES}`);
  } catch (error) {
    if (error instanceof BrokerProtocolError) throw error;
    fail("request frame must be JSON serializable");
  }
  return request;
}

export function parseBrokerPush(value) {
  const push = exactObject(value, "push", ["schemaVersion", "rootSessionId", "callerRunId", "type", "data"]);
  if (push.schemaVersion !== PUSH_SCHEMA_VERSION) fail("push.schemaVersion is unsupported");
  identity(push.rootSessionId, "rootSessionId");
  identity(push.callerRunId, "callerRunId");
  if (typeof push.type !== "string" || !PUSH_TYPES.includes(push.type)) fail("push.type is unsupported");
  exactObject(push.data, "push.data", []);
  assertPushFrameSize(push);
  return push;
}

export function parseBrokerResponse(value, expectedIdentity: BrokerResponseIdentity = {}) {
  if (!isPlainObject(value)) fail("response must be an object");
  if (typeof value.success !== "boolean") fail("response.success must be a boolean");
  const response = value.success
    ? exactObject(value, "response", ["schemaVersion", "requestId", "rootSessionId", "callerRunId", "success", "data"])
    : exactObject(value, "response", ["schemaVersion", "requestId", "rootSessionId", "callerRunId", "success", "error"]);
  if (response.schemaVersion !== RESPONSE_SCHEMA_VERSION) fail("response.schemaVersion is unsupported");
  identity(response.requestId, "requestId");
  identity(response.rootSessionId, "rootSessionId");
  identity(response.callerRunId, "callerRunId");
  for (const key of ["requestId", "rootSessionId", "callerRunId"]) {
    if (expectedIdentity[key] !== undefined && response[key] !== identity(expectedIdentity[key], `expectedIdentity.${key}`)) {
      fail(`response.${key} does not match expected identity`);
    }
  }
  if (response.success) {
    responseData(response.data);
  } else {
    const error = exactObject(response.error, "response.error", ["code", "message"]);
    identity(error.code, "error.code");
    errorMessage(error.message);
  }
  return response as BrokerResponse;
}

export function createBrokerSuccessResponse({ requestId, rootSessionId, callerRunId, data }: {
  requestId: string;
  rootSessionId: string;
  callerRunId: string;
  data: unknown;
}): BrokerResponse {
  return parseBrokerResponse({
    schemaVersion: RESPONSE_SCHEMA_VERSION,
    requestId,
    rootSessionId,
    callerRunId,
    success: true,
    data,
  });
}

export function createBrokerFailureResponse({ requestId, rootSessionId, callerRunId, code, message }: {
  requestId: string;
  rootSessionId: string;
  callerRunId: string;
  code: string;
  message: string;
}): BrokerResponse {
  return parseBrokerResponse({
    schemaVersion: RESPONSE_SCHEMA_VERSION,
    requestId,
    rootSessionId,
    callerRunId,
    success: false,
    error: { code, message },
  });
}

export function parseBrokerGrant(value) {
  const grant = exactObject(value, "grant", ["schemaVersion", "rootSessionId", "runId", "callerToken", "role"]);
  if (grant.schemaVersion !== GRANT_SCHEMA_VERSION) fail("grant.schemaVersion is unsupported");
  identity(grant.rootSessionId, "rootSessionId");
  identity(grant.runId, "runId");
  callerToken(grant.callerToken);
  if (typeof grant.role !== "string" || !GRANT_ROLES.includes(grant.role)) fail("grant.role is unsupported");
  return grant;
}

export function serializeBrokerGrant(value) {
  return `${JSON.stringify(parseBrokerGrant(value))}\n`;
}

export async function writeBrokerGrant(value) {
  const grant = parseBrokerGrant(value);
  const grantPath = brokerGrantPath(grant.rootSessionId, grant.runId);
  const directory = path.posix.dirname(grantPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${grantPath}.${process.pid}.tmp`;
  await writeFile(temporary, serializeBrokerGrant(grant), { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, grantPath);
  await chmod(grantPath, 0o600);
  return grantPath;
}

export async function readBrokerGrant(rootSessionId, runId) {
  const grantPath = brokerGrantPath(rootSessionId, runId);
  const grant = parseBrokerGrant(JSON.parse(await readFile(grantPath, "utf8")));
  if (grant.rootSessionId !== rootSessionId || grant.runId !== runId) fail("grant identity does not match its path");
  return grant;
}
