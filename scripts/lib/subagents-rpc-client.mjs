const REQUEST_CHANNEL = "subagents:rpc:v1:request";
const REPLY_PREFIX = "subagents:rpc:v1:reply:";
const SOURCE = { extension: "pi-plan-capsule" };

export function createSubagentsRpcClient(events, { timeoutMs = 5000, randomUUID = () => crypto.randomUUID() } = {}) {
  const pending = new Set();
  let disposed = false;

  function call(method, params = {}) {
    if (disposed) return Promise.reject(new Error("subagents RPC client is disposed"));

    const requestId = randomUUID();
    const replyChannel = `${REPLY_PREFIX}${requestId}`;

    return new Promise((resolve, reject) => {
      let settled = false;
      let timeout;
      let unsubscribe;
      const request = {
        reject,
        settle(callback, value) {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          unsubscribe();
          pending.delete(request);
          callback(value);
        },
      };
      unsubscribe = events.on(replyChannel, (reply) => {
        if (reply.version !== 1) {
          request.settle(reject, new Error(`unexpected subagents RPC reply version: ${reply.version}`));
        } else if (reply.requestId !== requestId) {
          request.settle(reject, new Error(`unexpected subagents RPC reply request id: ${reply.requestId}`));
        } else if (reply.success) {
          request.settle(resolve, reply.data);
        } else {
          request.settle(reject, new Error(reply.error?.message ?? "subagents RPC failed"));
        }
      });
      timeout = setTimeout(() => request.settle(reject, new Error(`subagents RPC ${method} timed out`)), timeoutMs);
      pending.add(request);
      events.emit(REQUEST_CHANNEL, { version: 1, requestId, method, params, source: SOURCE });
    });
  }

  return {
    ping() {
      return call("ping");
    },
    status(params) {
      return call("status", params);
    },
    spawn(params = {}) {
      if ("action" in params) throw new Error("spawn does not support action");
      return call("spawn", { ...params, async: true, clarify: false });
    },
    interrupt(params) {
      return call("interrupt", params);
    },
    stop(params) {
      return call("stop", params);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const request of [...pending]) request.settle(request.reject ?? (() => {}), new Error("subagents RPC client is disposed"));
    },
  };
}
