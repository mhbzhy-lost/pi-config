import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const REQUEST_SCHEMA_VERSION = "pi-root-subagent-broker-request.v1";
const PUSH_SCHEMA_VERSION = "pi-root-subagent-broker-push.v1";
const GRANT_SCHEMA_VERSION = "pi-root-subagent-broker-grant.v1";
const RESPONSE_SCHEMA_VERSION = "pi-root-subagent-broker-response.v1";
const SOCKET_PATH_LIMIT = 103;
const ERROR_MESSAGE_LIMIT = 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const METHODS = Object.freeze(["ping", "spawn", "spawn.lookup", "status", "steer", "interrupt", "stop", "supervisor.pending", "supervisor.reply", "subscribe"] as const);
const PUSH_TYPES = Object.freeze(["execution.started", "execution.completed", "supervisor.request", "root.closing"] as const);
const GRANT_ROLES = Object.freeze(["plan-runner", "executor"] as const);

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

export function parseBrokerRequest(value, { supervisorRequestId } = {}) {
  const request = exactObject(value, "request", ["schemaVersion", "requestId", "rootSessionId", "callerRunId", "callerToken", "method", "params"]);
  if (request.schemaVersion !== REQUEST_SCHEMA_VERSION) fail("request.schemaVersion is unsupported");
  identity(request.requestId, "requestId");
  identity(request.rootSessionId, "rootSessionId");
  identity(request.callerRunId, "callerRunId");
  callerToken(request.callerToken);
  if (typeof request.method !== "string" || !METHODS.includes(request.method)) fail("request.method is unsupported");
  record(request.params, "request.params");
  if (request.method === "spawn.lookup") {
    exactObject(request.params, "params", ["spawnKey"]);
    identity(request.params.spawnKey, "params.spawnKey");
  }
  if (request.method === "supervisor.reply") {
    identity(request.params.replyTo, "params.replyTo");
    if (supervisorRequestId !== undefined && request.params.replyTo !== identity(supervisorRequestId, "supervisorRequestId")) {
      fail("params.replyTo must equal the canonical supervisor requestId");
    }
  }
  return request;
}

export function createSupervisorRequestPush({ rootSessionId, callerRunId, upstreamDetails }) {
  const details = record(upstreamDetails, "upstreamDetails");
  const requestId = identity(details.id, "upstreamDetails.id");
  const executorRunId = identity(details.runId, "upstreamDetails.runId");
  const data = { ...details };
  delete data.id;
  delete data.runId;
  for (const key of Object.keys(data)) {
    if (key.endsWith("Id")) fail(`upstreamDetails contains unsupported secondary identity ${key}`);
  }
  return parseBrokerPush({
    schemaVersion: PUSH_SCHEMA_VERSION,
    rootSessionId,
    callerRunId,
    type: "supervisor.request",
    data: { requestId, executorRunId, ...data },
  });
}

export function parseBrokerPush(value) {
  const push = exactObject(value, "push", ["schemaVersion", "rootSessionId", "callerRunId", "type", "data"]);
  if (push.schemaVersion !== PUSH_SCHEMA_VERSION) fail("push.schemaVersion is unsupported");
  identity(push.rootSessionId, "rootSessionId");
  identity(push.callerRunId, "callerRunId");
  if (typeof push.type !== "string" || !PUSH_TYPES.includes(push.type)) fail("push.type is unsupported");
  record(push.data, "push.data");
  if (push.type === "supervisor.request") {
    identity(push.data.requestId, "push.data.requestId");
    identity(push.data.executorRunId, "push.data.executorRunId");
    for (const key of Object.keys(push.data)) {
      if (key.endsWith("Id") && key !== "requestId" && key !== "executorRunId") {
        fail(`push.data contains unsupported secondary identity ${key}`);
      }
    }
  }
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
