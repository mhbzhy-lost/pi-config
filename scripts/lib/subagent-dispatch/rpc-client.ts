import { randomUUID } from "node:crypto";

const REQUEST_CHANNEL = "subagents:rpc:v1:request";
const REPLY_PREFIX = "subagents:rpc:v1:reply:";
const REQUEST_ID = /^[A-Za-z0-9._-]{1,160}$/;
const SOURCE = Object.freeze({ extension: "typed-subagent-runtime" });

export class TypedSubagentRpcError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TypedSubagentRpcError";
    this.code = code;
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

  function call(method, params = {}, options = {}) {
    if (disposed) {
      return Promise.reject(new TypedSubagentRpcError("disposed", "typed subagent RPC client is disposed"));
    }
    const requestId = validateRequestId(options.requestId ?? createId());
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
              `unexpected typed subagent RPC reply version: ${reply?.version}`,
            ),
          );
          return;
        }
        if (reply.requestId !== requestId) {
          settle(
            reject,
            new TypedSubagentRpcError(
              "protocol_error",
              `unexpected typed subagent RPC reply request id: ${reply.requestId}`,
            ),
          );
          return;
        }
        if (reply.success === true) {
          settle(resolve, reply.data);
          return;
        }
        settle(
          reject,
          new TypedSubagentRpcError(
            reply.error?.code ?? "execution_failed",
            reply.error?.message ?? "typed subagent RPC failed",
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
        () => entry.reject(new TypedSubagentRpcError("timeout", `typed subagent RPC ${method} timed out`)),
        timeoutMs,
      );
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
      return call("spawn", { ...params, async: true, clarify: false }, options);
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
