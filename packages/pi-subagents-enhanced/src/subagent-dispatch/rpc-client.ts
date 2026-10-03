import { randomUUID } from "node:crypto";

const REQUEST_CHANNEL = "subagents:rpc:v1:request";
const REPLY_PREFIX = "subagents:rpc:v1:reply:";
const REQUEST_ID = /^[A-Za-z0-9._-]{1,160}$/;
const SOURCE = Object.freeze({ extension: "typed-subagent-runtime" });

const SECURITY_CAPABILITIES = Object.freeze([
  "asyncSpawn",
  "processTerminalProof",
  "launchResolvedExtensions",
  "runtimeAcknowledgedExtensions",
]);
const DISPLAY_CAPABILITIES = Object.freeze([
  "status",
  "cost",
  "fleetStatus",
]);
const CONTROL_METHODS = Object.freeze(["steer", "nonRecoveringSteer", "interrupt", "stop", "resume"]);

function capabilityValue(raw, name) {
  const isPresent = (value) => value !== undefined && value !== null && value !== false;
  const capabilities = raw?.capabilities;
  const reply = capabilities?.spawnReply;
  if (reply && typeof reply === "object" && Object.hasOwn(reply, name)) return isPresent(reply[name]);
  const explicit = `spawnReply${name[0].toUpperCase()}${name.slice(1)}`;
  if (capabilities && Object.hasOwn(capabilities, explicit)) return isPresent(capabilities[explicit]);
  if (name === "runId" || name === "asyncDir") {
    if (capabilities && Object.hasOwn(capabilities, "spawnReplyIdentity")) return isPresent(capabilities.spawnReplyIdentity);
  }
  if (capabilities && Object.hasOwn(capabilities, name)) return isPresent(capabilities[name]);
  return undefined;
}

function capabilityPresent(raw, name) {
  return capabilityValue(raw, name) === true || (Array.isArray(raw?.methods) && raw.methods.includes(name));
}

function spawnReplyValue(reply) {
  return reply?.details ?? reply;
}

function spawnReplyValidation(raw, reply) {
  const details = spawnReplyValue(reply);
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    throw Object.assign(new Error("pi-subagents spawn reply must be an object"), { code: "SPAWN_REPLY_INVALID" });
  }
  const checks = [
    ["runId", "runId"],
    ["asyncDir", "asyncDir"],
    ["cwd", "cwd"],
  ];
  for (const [field, capability] of checks) {
    const enabled = capabilityValue(raw, capability);
    if (enabled === true && (typeof details[field] !== "string" || details[field].length === 0)) {
      throw Object.assign(new Error(`pi-subagents spawn reply is missing ${field}`), {
        code: "SPAWN_REPLY_INVALID", field,
      });
    }
  }
  if (capabilityValue(raw, "cwd") === true && details.cwd !== raw.session.cwd) {
    throw Object.assign(new Error("pi-subagents spawn reply cwd does not match negotiated cwd"), {
      code: "SPAWN_REPLY_INVALID", field: "cwd",
    });
  }
  return details;
}

export async function negotiateCapabilities(rpc: any, { cwd, diagnostic, response }: { cwd?: string; diagnostic?: unknown; response?: any } = {}) {
  if (response === undefined && (!rpc || typeof rpc.ping !== "function")) {
    throw new TypedSubagentRpcError("invalid_rpc", "capability negotiation requires an RPC ping endpoint", "ping");
  }
  const raw = response ?? await rpc.ping(diagnostic === undefined ? undefined : { diagnostic });
  if (process.env.T11B1_DEBUG === "1") console.error(`[negotiation-debug] raw=${JSON.stringify(raw)?.slice(0, 900)}`);
  const methods = new Set(Array.isArray(raw?.methods) ? raw.methods : []);
  const missing = [];
  if (raw?.version !== 1) missing.push("rpc:v1");
  for (const method of ["ping", "spawn"]) if (!methods.has(method)) missing.push(method);
  if (!raw?.session || typeof raw.session !== "object") {
    missing.push("session.sessionId", "session.sessionFile", "session.cwd");
  } else {
    for (const field of ["sessionId", "sessionFile", "cwd"]) {
      if (typeof raw.session[field] !== "string" || raw.session[field].length === 0) missing.push(`session.${field}`);
    }
    if (typeof cwd === "string" && raw.session.cwd !== cwd) missing.push("session.cwd");
  }
  for (const capability of SECURITY_CAPABILITIES) {
    if (!capabilityPresent(raw, capability)) missing.push(capability);
  }
  const enabled = Object.create(null);
  enabled.spawn = methods.has("spawn") && missing.length === 0;
  enabled.status = methods.has("status") && capabilityPresent(raw, "statusProjection");
  enabled.cost = methods.has("cost") && (capabilityValue(raw, "cost") !== false);
  enabled.fleetStatus = capabilityPresent(raw, "fleetStatus");
  for (const method of CONTROL_METHODS) enabled[method] = methods.has(method);
  enabled.processTerminal = capabilityPresent(raw, "processTerminalProof");
  enabled.launchResolvedExtensions = capabilityPresent(raw, "launchResolvedExtensions");
  enabled.runtimeAcknowledgedExtensions = capabilityPresent(raw, "runtimeAcknowledgedExtensions");
  const displayUnavailable = DISPLAY_CAPABILITIES.filter((name) => !enabled[name]);
  const diagnostics = displayUnavailable.map((name) => ({
    code: "DISPLAY_CAPABILITY_UNAVAILABLE", capability: name, unavailable: true,
  }));
  const negotiated = {
    version: raw?.version,
    methods: Object.freeze([...methods]),
    capabilities: raw?.capabilities ?? {},
    events: raw?.events,
    session: raw?.session,
    enabled: Object.freeze(enabled),
    securityMissing: Object.freeze([...new Set(missing)]),
    displayUnavailable: Object.freeze(displayUnavailable),
    diagnostics: Object.freeze(diagnostics),
    canSpawn: missing.length === 0,
    upgradeStopped: missing.length > 0,
    raw,
    assertSpawnAllowed() {
      if (missing.length === 0) return;
      const error: any = new Error(`RPC capability negotiation failed; missing: ${[...new Set(missing)].join(", ")}`);
      error.name = "CapabilityNegotiationError";
      error.code = "CAPABILITY_NEGOTIATION_FAILED";
      error.operation = "spawn";
      error.missingCapabilities = [...new Set(missing)];
      error.upgradeStopped = true;
      throw error;
    },
    validateSpawnReply(reply) {
      return spawnReplyValidation(raw, reply);
    },
    isTerminalStatus(status) {
      return status === "terminal" || status === "terminal-proof" || status === "completed";
    },
  };
  return Object.freeze(negotiated);
}

export class TypedSubagentRpcError extends Error {
  code: string;
  operation: string;
  constructor(code, message, operation = "unknown") {
    super(message);
    this.name = "TypedSubagentRpcError";
    this.code = code;
    this.operation = operation;
  }
}

function validateRequestId(value) {
  if (typeof value !== "string" || !REQUEST_ID.test(value)) {
    throw new TypedSubagentRpcError(
      "invalid_request_id",
      "typed subagent RPC requestId must match ^[A-Za-z0-9._-]{1,160}$",
    );
  }
  return value;
}

export function createRenewableTypedSubagentRpcClient(createClient) {
  if (typeof createClient !== "function") {
    throw new TypedSubagentRpcError("invalid_factory", "typed subagent RPC client factory must be a function");
  }
  let current = createClient();
  const active = () => {
    current ??= createClient();
    return current;
  };
  return Object.freeze({
    renew() {
      current?.dispose?.();
      current = undefined;
      current = createClient();
      return current;
    },
    ping: (...args) => active().ping(...args),
    spawn: (...args) => active().spawn(...args),
    status: (...args) => active().status(...args),
    resume: (...args) => active().resume(...args),
    steer: (...args) => active().steer(...args),
    interrupt: (...args) => active().interrupt(...args),
    stop: (...args) => active().stop(...args),
    dispose() {
      current?.dispose?.();
      current = undefined;
    },
  });
}

export function createTypedSubagentRpcClient(
  events,
  { timeoutMs = 5000, randomUUID: createId = randomUUID } = {},
) {
  if (!events || typeof events.on !== "function" || typeof events.emit !== "function") {
    throw new TypedSubagentRpcError("invalid_events", "typed subagent RPC requires an event bus");
  }

  const pending = new Map();
  let disposed = false;

  function call(method, params = {}, options: { requestId?: string; diagnostic?: { toolCallId?: string; sink?: (phase: string, fields?: Record<string, unknown>) => void } } = {}) {
    if (disposed) {
      return Promise.reject(new TypedSubagentRpcError("disposed", "typed subagent RPC client is disposed"));
    }
    const requestId = validateRequestId(options.requestId ?? createId());
    const diagnostic = options.diagnostic;
    const trace = (phase, fields = {}) => {
      if (typeof diagnostic?.sink !== "function" || typeof diagnostic.toolCallId !== "string") return;
      try { diagnostic.sink(phase, { method, requestId, ...fields }); } catch { /* 诊断输出不得改变 RPC 语义。 */ }
    };
    if (pending.has(requestId)) {
      throw new TypedSubagentRpcError(
        "duplicate_request_id",
        `typed subagent RPC requestId is already pending: ${requestId}`,
      );
    }

    const replyChannel = `${REPLY_PREFIX}${requestId}`;
    return new Promise((resolve, reject) => {
      let settled = false;
      let timeout;
      let unsubscribe = () => {};
      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        unsubscribe();
        pending.delete(requestId);
        callback(value);
      };

      unsubscribe = events.on(replyChannel, (reply) => {
        if (!reply || reply.version !== 1) {
          settle(
            reject,
            new TypedSubagentRpcError(
              "protocol_error",
              `unexpected typed subagent RPC reply version: ${reply?.version}`, method,
            ),
          );
          return;
        }
        if (reply.requestId !== requestId) {
          settle(
            reject,
            new TypedSubagentRpcError(
              "protocol_error",
              `unexpected typed subagent RPC reply request id: ${reply.requestId}`, method,
            ),
          );
          return;
        }
        if (reply.success === true) {
          trace(`rpc-${method}-replied`);
          settle(resolve, reply.data);
          return;
        }
        settle(
          reject,
          new TypedSubagentRpcError(
            reply.error?.code ?? "execution_failed",
            reply.error?.message ?? "typed subagent RPC failed", method,
          ),
        );
      }) ?? (() => {});

      const entry = {
        reject(error) {
          settle(reject, error);
        },
      };
      pending.set(requestId, entry);
      timeout = setTimeout(
        () => entry.reject(new TypedSubagentRpcError("timeout", `typed subagent RPC ${method} timed out`, method)),
        timeoutMs,
      );
      trace(`rpc-${method}-sent`);
      events.emit(REQUEST_CHANNEL, {
        version: 1,
        requestId,
        method,
        params,
        source: SOURCE,
      });
    });
  }

  return Object.freeze({
    ping(options) {
      return call("ping", {}, options);
    },
    spawn(params = {}, options) {
      if (params && typeof params === "object" && "action" in params) {
        throw new TypedSubagentRpcError("invalid_params", "RPC spawn does not accept action");
      }
      return call("spawn", { ...params }, options);
    },
    status(params, options) {
      return call("status", params, options);
    },
    resume(params, options) {
      return call("resume", params, options);
    },
    steer(params, options) {
      return call("steer", params, options);
    },
    interrupt(params, options) {
      return call("interrupt", params, options);
    },
    stop(params, options) {
      return call("stop", params, options);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of [...pending.values()]) {
        entry.reject(new TypedSubagentRpcError("disposed", "typed subagent RPC client is disposed"));
      }
    },
  });
}
