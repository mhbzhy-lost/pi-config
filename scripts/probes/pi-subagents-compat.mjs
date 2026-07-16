export const REQUIRED_METHODS = ["ping", "status", "spawn", "interrupt", "stop"];

export function createSubagentsRpcClient(events, { randomUUID = () => crypto.randomUUID(), timeoutMs = 5000 } = {}) {
  return {
    call(method, params = {}) {
      const requestId = randomUUID();
      const replyChannel = `subagents:rpc:v1:reply:${requestId}`;

      return new Promise((resolve, reject) => {
        let settled = false;
        const settle = (callback, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          unsubscribe();
          callback(value);
        };
        const unsubscribe = events.on(replyChannel, (reply) => {
          if (reply.version !== 1) {
            settle(reject, new Error(`unexpected subagents RPC reply version: ${reply.version}`));
          } else if (reply.requestId !== requestId) {
            settle(reject, new Error(`unexpected subagents RPC reply request id: ${reply.requestId}`));
          } else if (reply.success) {
            settle(resolve, reply.data);
          } else {
            settle(reject, new Error(reply.error?.message ?? "subagents RPC failed"));
          }
        });
        const timeout = setTimeout(
          () => settle(reject, new Error(`subagents RPC ${method} timed out`)),
          timeoutMs,
        );

        events.emit("subagents:rpc:v1:request", { version: 1, requestId, method, params });
      });
    },
  };
}

export function evaluateCompatibility(report) {
  const failures = [];

  if (report.piVersion !== "0.80.6") failures.push(`unexpected Pi version: ${report.piVersion}`);
  for (const method of REQUIRED_METHODS) {
    if (!report.rpcMethods.includes(method)) failures.push(`missing RPC method: ${method}`);
  }
  if (!report.planExtensionLoaded) failures.push("Plan child did not load plan-capsule extension");
  if (!report.planChildNestedSpawn) failures.push("Plan child cannot spawn an authorized nested worker");
  if (!report.nestedResultHasDetails) failures.push("nested subagent result lacks structured lifecycle details");
  if (report.workerCanSpawn) failures.push("ordinary worker can recursively spawn subagents");
  if (!report.stopReachedTerminalState) failures.push("stop did not reach a terminal artifact state");

  return { ok: failures.length === 0, failures };
}
