type OwnedWorkspaceReceipt = {
  workspaceId?: unknown;
  leaseId?: unknown;
  run?: { runId?: unknown } | null;
};

type TrustedRunBindingClient = {
  listOwned(input: { runId: string }): Promise<OwnedWorkspaceReceipt[]>;
};

// run-only 复查回退：coordinator 权威查询被无关 invalid record 阻断时，从本地
// ledger 逐记录隔离枚举中读取该 run 的绑定。回退结果仍要过 resolve 内的
// 唯一性与身份校验；回退自身抛错（same-owner/unknown invalid、v2-invalid）则
// fail-closed 向上传播，不得把「查询失败」解释为「run 没有 workspace」。
type TrustedRunBindingLedgerFallback = (runId: string) => OwnedWorkspaceReceipt[] | Promise<OwnedWorkspaceReceipt[]>;

export type TrustedRunBinding = Readonly<{
  workspaceId: string;
  leaseId: string;
  runId: string;
  ownerScope: Readonly<{ kind: "standalone-subagent"; rootSessionId: string }>;
}>;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;

function identity(value: unknown, field: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value) || value.includes("..")) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

/**
 * 将 coordinator 权威返回的 run→workspace 绑定缓存在当前 Root runtime 生命周期内。
 * 失败不缓存；并发首次解析共享同一 promise；dispose 后的晚到结果不得回填缓存。
 * 可选 readLedger 回退只在权威查询抛错时消费本地 ledger 枚举，且不放宽任何
 * 唯一性/身份校验（TrustedRunBinding 约束保持不变）。
 */
export function createTrustedRunBindingResolver(client: TrustedRunBindingClient, { rootSessionId, readLedger }: { rootSessionId: string; readLedger?: TrustedRunBindingLedgerFallback }) {
  if (!client || typeof client.listOwned !== "function") throw new TypeError("trusted run binding client is invalid");
  const rootId = identity(rootSessionId, "rootSessionId");
  const cache = new Map<string, TrustedRunBinding>();
  const inflight = new Map<string, Promise<TrustedRunBinding>>();
  let generation = 0;

  const resolve = (value: string): Promise<TrustedRunBinding> => {
    const runId = identity(value, "runId");
    const cached = cache.get(runId);
    if (cached) return Promise.resolve(cached);
    const pending = inflight.get(runId);
    if (pending) return pending;

    const currentGeneration = generation;
    const lookup = Promise.resolve(client.listOwned({ runId }))
      .catch((error: unknown) => {
        if (typeof readLedger !== "function") throw error;
        return readLedger(runId);
      })
      .then((owned) => {
      if (!Array.isArray(owned) || owned.length !== 1) throw new Error("trusted run binding is unavailable");
      const entry = owned[0];
      const workspaceId = identity(entry?.workspaceId, "workspaceId");
      const leaseId = identity(entry?.leaseId, "leaseId");
      if (entry?.run?.runId !== runId) throw new Error("trusted run binding is unavailable");
      const binding = Object.freeze({
        workspaceId,
        leaseId,
        runId,
        ownerScope: Object.freeze({ kind: "standalone-subagent" as const, rootSessionId: rootId }),
      });
      if (generation === currentGeneration) cache.set(runId, binding);
      return binding;
    }).finally(() => {
      if (inflight.get(runId) === lookup) inflight.delete(runId);
    });
    inflight.set(runId, lookup);
    return lookup;
  };

  return Object.freeze({
    resolve,
    dispose() {
      generation++;
      cache.clear();
      inflight.clear();
    },
  });
}
