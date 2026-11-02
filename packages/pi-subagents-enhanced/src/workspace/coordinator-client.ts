import net from "node:net";
import { randomUUID } from "node:crypto";
import { parseCoordinatorReply } from "./coordinator-protocol.ts";
import { fromCoordinatorFailure } from "./coordinator-errors.ts";
import type { CoordinatorMetadata } from "./coordinator-registry.ts";export type RepositoryCoordinatorClient = {
  request: (value: any) => Promise<any>;
  ping: () => Promise<{ instanceId: string; repositoryId: string; storageRepositoryId: string; endpoint: string }>;
  close: () => Promise<void>;
  instanceId?: string;
  reserve: (input: any) => Promise<any>;
  ensureAllocated: (input: any) => Promise<any>;
  bindRun: (input: any) => Promise<any>;
  listOwned: (input?: any) => Promise<any>;
  statusOwned: (input: any) => Promise<any>;
  issueDisposition: (input: any) => Promise<any>;
  issueOwnedDisposition: (input: any) => Promise<any>;
  dispose: (input: any) => Promise<any>;
  disposeOwned: (input: any) => Promise<any>;
  release: (input: any) => Promise<any>;
  releaseOwned: (input: any) => Promise<any>;
  reconcile: (input?: any) => Promise<any>;
  audit: (input?: any) => Promise<any>;
  enqueueIntegration: (input: any) => Promise<any>;
  awaitIntegrationAdmission: (input: any) => Promise<any>;
  reportResolvingConflict: (input: any) => Promise<any>;
  publishRebasedCandidate: (input: any) => Promise<any>;
  abandonIntegration: (input: any) => Promise<any>;
  inspectIntegrationState: (input: any) => Promise<any>;
  preserveIntegrationDebt: (input: any, reason?: string) => Promise<any>;
  prepareAutoIntegration: (input: any) => Promise<any>;
  inspectAutoIntegration: (input: any) => Promise<any>;
  advanceAutoIntegration: (input: any) => Promise<any>;
  recordTerminalProof: (input: any) => Promise<any>;
  recoveryStatus: (input?: any) => Promise<any>;
  recoveryAudit: (input?: any) => Promise<any>;
  recoveryPreserve: (input: any) => Promise<any>;
  recoveryRecover: (input: any) => Promise<any>;
  recoveryRetry: (input: any) => Promise<any>;
  resumeDebt: (input: any) => Promise<any>;
  resumeDelivered: (input: any) => Promise<any>;
  activateResume: (input: any) => Promise<any>;
  recoveryDiscard: (input: any) => Promise<any>;
  recoveryRelease: (input: any) => Promise<any>;
};
export async function connectRepositoryCoordinator(identity: any, brokerRegistration: any, options: { metadata?: CoordinatorMetadata; start?: () => Promise<CoordinatorMetadata>; onClose?: () => void } = {}): Promise<RepositoryCoordinatorClient> {
  const metadata = options.metadata ?? (options.start ? await options.start() : undefined);
  if (!metadata || metadata.repositoryId !== identity.repositoryId || !metadata.endpoint || !metadata.instanceId) throw new Error("Coordinator metadata identity is unavailable");
  const endpoint = metadata.endpoint;
  let socket: net.Socket | undefined; let buffer = ""; let connected = false; const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  // Every outstanding request must fail closed when the transport dies; a
  // waiter left pending forever would stall the Root Broker proof sink.
  const failPending = (error: Error) => { for (const waiter of pending.values()) waiter.reject(error); pending.clear(); };
  const connect = () => new Promise<void>((resolve, reject) => { socket = net.createConnection(endpoint, () => { connected = true; resolve(); }); socket.setEncoding("utf8"); socket.on("data", (chunk) => { buffer += chunk; let i; while ((i = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); try { const reply = parseCoordinatorReply(JSON.parse(line)); const waiter = pending.get(reply.requestId); if (waiter) { if (reply.repositoryId !== metadata.repositoryId) waiter.reject(new Error("Coordinator reply repository identity mismatch")); else waiter.resolve(reply); pending.delete(reply.requestId); } } catch (cause) { const error = new Error("Coordinator reply is malformed", { cause }); error.code = "COORDINATOR_PROTOCOL_MALFORMED_REPLY"; failPending(error); socket?.destroy(error); } } }); socket.on("error", (error: Error) => { if (!connected) reject(error); else { const failure = new Error(`Coordinator transport failed: ${error.message}`, { cause: error }); failure.code = "COORDINATOR_TRANSPORT_FAILED"; failPending(failure); } }); socket.on("close", () => { failPending(new Error("Coordinator connection closed")); try { options.onClose?.(); } catch { /* 通知失败不影响 failPending */ } }); });
  await connect();
  const send = (value: any) => { const requestId = value.requestId || randomUUID(); return new Promise<any>((resolve, reject) => { if (!socket || socket.destroyed || !socket.writable) { reject(new Error("Coordinator connection closed")); return; } pending.set(requestId, { resolve: (reply: any) => reply.ok ? resolve(reply.result) : reject(fromCoordinatorFailure(reply.error || "Coordinator request failed", reply.errorInfo)), reject }); socket.write(`${JSON.stringify({ ...value, requestId })}\n`, (error) => { if (error) { pending.delete(requestId); reject(error); } }); }); };
  // 注册失败（服务端拒绝或传输错误）时必须销毁 socket：懒加载路径下调用方会继续运行，
  // 泄漏的已连接 socket 会永久挂起事件循环。
  let registration: any;
  try {
    registration = await send({ protocol: "repository-workspace-coordinator.v1", repositoryId: identity.repositoryId, method: "broker.register", brokerRegistry: brokerRegistration });
  } catch (cause) {
    socket.destroy();
    throw cause;
  }
  if (!registration || !/^[a-f0-9]{64}$/.test(registration.capability) || registration.instanceId !== metadata.instanceId
      || registration.endpoint !== metadata.endpoint || registration.role !== "root-broker"
      || (identity.storageRepositoryId && registration.storageRepositoryId && registration.storageRepositoryId !== identity.storageRepositoryId)) {
    socket.destroy();
    throw new Error("Coordinator registration reply identity is invalid");
  }
  const request = (value: any) => send({ ...value, protocol: "repository-workspace-coordinator.v1", repositoryId: identity.repositoryId, role: registration.role, capability: registration.capability });
  const workspace = (operation: string, input: any = {}) => request({ method: "binding.register", params: { operation, input } });
  return {
    instanceId: registration.instanceId,
    ping: async () => ({ instanceId: registration.instanceId, repositoryId: metadata.repositoryId, storageRepositoryId: identity.storageRepositoryId, endpoint: registration.endpoint }),
    request,
    reserve: (input: any) => workspace("reserve", input),
    ensureAllocated: (input: any) => workspace("ensureAllocated", input),
    bindRun: (input: any) => workspace("bindRun", input),
    listOwned: (input: any = {}) => workspace("listOwned", input),
    statusOwned: (input: any) => workspace("statusOwned", input),
    issueDisposition: (input: any) => workspace("issueDisposition", input),
    issueOwnedDisposition: (input: any) => workspace("issueDisposition", input),
    dispose: (input: any) => workspace("dispose", input),
    disposeOwned: (input: any) => workspace("dispose", input),
    release: (input: any) => workspace("release", input),
    releaseOwned: (input: any) => workspace("release", input),
    reconcile: (input: any = {}) => workspace("reconcile", input),
    audit: (input: any = {}) => request({ method: "queue.audit", params: input }),
    enqueueIntegration: (input: any) => workspace("enqueueIntegration", input),
    awaitIntegrationAdmission: (input: any) => workspace("awaitIntegrationAdmission", input),
    reportResolvingConflict: (input: any) => workspace("reportResolvingConflict", input),
    publishRebasedCandidate: (input: any) => workspace("publishRebasedCandidate", input),
    abandonIntegration: (input: any) => workspace("abandonIntegration", input),
    inspectIntegrationState: (input: any) => workspace("inspectIntegrationState", input),
    preserveIntegrationDebt: (input: any, reason?: string) => workspace("preserveIntegrationDebt", reason === undefined ? input : { ...input, reason }),
    prepareAutoIntegration: (input: any) => workspace("prepare_auto_integration", input),
    inspectAutoIntegration: (input: any) => workspace("inspect_auto_integration", input),
    advanceAutoIntegration: (input: any) => workspace("advance_auto_integration", input),
    recordTerminalProof: (input: any) => request({ method: "record_terminal_proof", params: { workspaceId: input.workspaceId, owner: input.ownerScope, proof: input.proof } }),
    recoveryStatus: (input: any = {}) => workspace("recovery.status", input),
    recoveryAudit: (input: any = {}) => workspace("recovery.audit", input),
    recoveryPreserve: (input: any) => workspace("recovery.preserve", input),
    recoveryRecover: (input: any) => workspace("recovery.recover", input),
    recoveryRetry: (input: any) => workspace("recovery.retry", input),
    resumeDebt: (input: any) => workspace("recovery.resume-debt", input),
    resumeDelivered: (input: any) => workspace("recovery.resume-delivered", input),
    activateResume: (input: any) => workspace("recovery.activate-resume", input),
    recoveryDiscard: (input: any) => workspace("recovery.discard", input),
    recoveryRelease: (input: any) => workspace("recovery.release", input),
    async close() { socket?.end(); failPending(new Error("Coordinator client closed")); },
  };
}

/**
 * 断线重试表（按 client 方法名）：仅收录具备稳定幂等语义的操作。
 * - 只读查询与 reconcile/audit：重复执行无副作用；
 * - reserve/ensureAllocated/bindRun：ledger 侧请求哈希幂等；
 * - enqueueIntegration：integration-queue 稳定 requestId 幂等；
 * - awaitIntegrationAdmission：已 admitted 则早退；
 * - recordTerminalProof：proofOutbox 按 proofId 去重；
 * - prepare/advance/inspectAutoIntegration：durable 状态重放收敛（reconcile 依赖同性质）；
 * - activateResume：服务端 durable 序列显式重放收敛。
 * 其余（处置三件套、recovery 变更、queue 人工突变）服务端 settlementId 随机或
 * 状态迁移未知结局，断线后一律向上抛，由调用方读后确认，不得泛化重放。
 */
export const COORDINATOR_CLIENT_REPLAYABLE_METHODS: ReadonlySet<string> = new Set([
  "ping", "reserve", "ensureAllocated", "bindRun", "listOwned", "statusOwned", "reconcile", "audit",
  "enqueueIntegration", "awaitIntegrationAdmission", "inspectIntegrationState",
  "prepareAutoIntegration", "inspectAutoIntegration", "advanceAutoIntegration",
  "recordTerminalProof", "activateResume", "resumeDelivered", "recoveryStatus", "recoveryAudit",
]);

function isTransportFailure(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  return code === "COORDINATOR_TRANSPORT_FAILED" || /Coordinator connection closed/.test(String((error as Error)?.message));
}

export type LazyCoordinatorOptions = {
  /** 仓库身份（repositoryId / storageRepositoryId）。 */
  identity: any;
  /** Root Broker 注册凭据（首连与重连时随 broker.register 提交）；可为值或按需取值函数（重连时刷新）。 */
  brokerRegistration: unknown | (() => unknown | Promise<unknown>);
  /** 需要类拉起通道：确保 daemon 存在并返回 metadata（不得建业务 client）。 */
  ensure: () => Promise<CoordinatorMetadata>;
  /** 利用类只读 metadata 读取（不拉起）；缺省时 preferClient 仅使用缓存连接。 */
  readMetadata?: () => Promise<CoordinatorMetadata | undefined>;
  /** preferClient 试连超时毫秒数。 */
  preferConnectTimeoutMs?: number;
};

export type LazyCoordinator = {
  /** 需要类：无可用连接时经 ensure 拉起并建立 Host 级持久引用；可重试方法断线后重连重放一次。 */
  requireClient: () => Promise<RepositoryCoordinatorClient>;
  /** 利用类：有缓存用缓存，否则短超时试连（绝不拉起）；失败返回 undefined 供调用方降级 ledger。 */
  preferClient: () => Promise<RepositoryCoordinatorClient | undefined>;
  /** 当前是否持有引用（缓存连接存在）；轮询泵等轻量后台任务据此空转跳过。 */
  hasClient: () => boolean;
  /** Host 退出前主动释放引用（内核兜底）。 */
  dispose: () => Promise<void>;
};

/**
 * Host 级懒加载 coordinator 引用持有者：引用 = 持久连接（内核担保释放）。
 * child 不直连：其 coordinator 请求经 Root Broker 由所属 Host 的连接承载。
 */
export function createLazyCoordinator(options: LazyCoordinatorOptions): LazyCoordinator {
  let cached: RepositoryCoordinatorClient | undefined;
  let connecting: Promise<RepositoryCoordinatorClient> | undefined;
  let preferFlight: Promise<RepositoryCoordinatorClient | undefined> | undefined;

  const wrapReplay = (client: RepositoryCoordinatorClient): RepositoryCoordinatorClient => new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function" || typeof property !== "string" || !COORDINATOR_CLIENT_REPLAYABLE_METHODS.has(property)) return value;
      return async (...args: unknown[]) => {
        try {
          return await (value as (...fnArgs: unknown[]) => unknown).apply(target, args);
        } catch (error) {
          if (!isTransportFailure(error)) throw error;
          // 断线：丢弃失效引用，重拉/重连后对幂等方法重放一次。
          cached = undefined;
          const fresh = await requireClient();
          const replay = (fresh as unknown as Record<string, (...fnArgs: unknown[]) => unknown>)[property];
          if (typeof replay !== "function") throw error;
          return await replay.apply(fresh, args);
        }
      };
    },
  });

  async function connect(metadata: CoordinatorMetadata, cancelled?: { cancelled: boolean }): Promise<RepositoryCoordinatorClient> {
    const brokerRegistration = typeof options.brokerRegistration === "function"
      ? await (options.brokerRegistration as () => unknown | Promise<unknown>)()
      : options.brokerRegistration;
    const client = await connectRepositoryCoordinator(options.identity, brokerRegistration, {
      metadata,
      // 传输断开（daemon 崩溃/归零自退）时原子失效缓存引用，后续 requireClient 重建。
      onClose: () => { if (cached === client) cached = undefined; },
    });
    if (cancelled?.cancelled) {
      // 竞速落败：不得写入缓存形成隐式引用，销毁 socket 后向上报超时。
      await client.close().catch(() => undefined);
      throw Object.assign(new Error("Coordinator prefer connect timed out"), { code: "COORDINATOR_PREFER_TIMEOUT" });
    }
    cached = client;
    return wrapReplay(client);
  }

  async function requireClient(): Promise<RepositoryCoordinatorClient> {
    if (cached) return wrapReplay(cached);
    connecting ??= (async () => {
      try {
        const metadata = await options.ensure();
        return await connect(metadata);
      } finally { connecting = undefined; }
    })();
    return await connecting;
  }

  async function preferClient(): Promise<RepositoryCoordinatorClient | undefined> {
    if (cached) return wrapReplay(cached);
    const metadata = await options.readMetadata?.().catch(() => undefined);
    if (!metadata) return undefined;
    // 单 flight：并发 prefer 共享同一试连；超时置取消标志，落败连接自行销毁不回填缓存。
    preferFlight ??= (async () => {
      const cancelled = { cancelled: false };
      try {
        return await Promise.race([
          connect(metadata, cancelled),
          new Promise<undefined>((resolve) => { setTimeout(() => { cancelled.cancelled = true; resolve(undefined); }, options.preferConnectTimeoutMs ?? 500).unref?.(); }),
        ]);
      } catch {
        return undefined;
      } finally { preferFlight = undefined; }
    })();
    return await preferFlight;
  }

  return {
    requireClient,
    preferClient,
    hasClient: () => cached !== undefined,
    async dispose() { const client = cached; cached = undefined; await client?.close().catch(() => undefined); },
  };
}
