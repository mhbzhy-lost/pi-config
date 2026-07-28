const REQUEST_CHANNEL = "subagents:rpc:v1:request";
const REPLY_PREFIX = "subagents:rpc:v1:reply:";
const SOURCE = { extension: "pi-plan-capsule" };
const REQUEST_ID = /^[A-Za-z0-9._-]{1,160}$/;

export class SubagentsRpcError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SubagentsRpcError";
    this.code = code;
  }
}

function assertRequestId(value) {
  if (typeof value !== "string" || !REQUEST_ID.test(value)) {
    throw new SubagentsRpcError("invalid_request_id", "subagents RPC requestId must match ^[A-Za-z0-9._-]{1,160}$");
  }
  return value;
}

export function createSubagentsRpcClient(events, { timeoutMs = 5000, randomUUID = () => crypto.randomUUID() } = {}) {
  const pending = new Set();
  const pendingRequestIds = new Set();
  let disposed = false;

  function call(method, params = {}, options = {}) {
    if (disposed) return Promise.reject(new SubagentsRpcError("disposed", "subagents RPC client is disposed"));

    const requestId = assertRequestId(options.requestId ?? randomUUID());
    if (pendingRequestIds.has(requestId)) {
      throw new SubagentsRpcError("duplicate_request_id", `subagents RPC requestId is already pending: ${requestId}`);
    }
    const replyChannel = `${REPLY_PREFIX}${requestId}`;
    pendingRequestIds.add(requestId);

    return new Promise((resolve, reject) => {
      let settled = false;
      let timeout;
      let unsubscribe;
      const request = {
        requestId,
        reject,
        settle(callback, value) {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          unsubscribe();
          pending.delete(request);
          pendingRequestIds.delete(requestId);
          callback(value);
        },
      };
      unsubscribe = events.on(replyChannel, (reply) => {
        if (reply.version !== 1) {
          request.settle(reject, new SubagentsRpcError("protocol_error", `unexpected subagents RPC reply version: ${reply.version}`));
        } else if (reply.requestId !== requestId) {
          request.settle(reject, new SubagentsRpcError("protocol_error", `unexpected subagents RPC reply request id: ${reply.requestId}`));
        } else if (reply.success) {
          request.settle(resolve, reply.data);
        } else {
          request.settle(reject, new SubagentsRpcError(reply.error?.code ?? "execution_failed", reply.error?.message ?? "subagents RPC failed"));
        }
      });
      timeout = setTimeout(
        () => request.settle(reject, new SubagentsRpcError("timeout", `subagents RPC ${method} timed out`)),
        timeoutMs,
      );
      pending.add(request);
      events.emit(REQUEST_CHANNEL, { version: 1, requestId, method, params, source: SOURCE });
    });
  }

  return {
    ping(options) {
      return call("ping", {}, options);
    },
    status(params, options) {
      return call("status", params, options);
    },
    spawn(params = {}, options) {
      if ("action" in params) throw new SubagentsRpcError("invalid_params", "spawn does not support action");
      return call("spawn", { ...params, async: true, clarify: false }, options);
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
      for (const request of [...pending]) {
        request.settle(request.reject, new SubagentsRpcError("disposed", "subagents RPC client is disposed"));
      }
    },
  };
}
