import net from "node:net";
import { randomUUID } from "node:crypto";
import { parseCoordinatorReply } from "./coordinator-protocol.ts";
import type { CoordinatorMetadata } from "./coordinator-registry.ts";
export type RepositoryCoordinatorClient = {
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
  activateResume: (input: any) => Promise<any>;
  recoveryDiscard: (input: any) => Promise<any>;
  recoveryRelease: (input: any) => Promise<any>;
};
export async function connectRepositoryCoordinator(identity: any, brokerRegistration: any, options: { metadata?: CoordinatorMetadata; start?: () => Promise<CoordinatorMetadata> } = {}): Promise<RepositoryCoordinatorClient> {
  const metadata = options.metadata ?? (options.start ? await options.start() : undefined);
  if (!metadata || metadata.repositoryId !== identity.repositoryId || !metadata.endpoint || !metadata.instanceId) throw new Error("Coordinator metadata identity is unavailable");
  const endpoint = metadata.endpoint;
  let socket: net.Socket | undefined; let buffer = ""; let connected = false; const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  // Every outstanding request must fail closed when the transport dies; a
  // waiter left pending forever would stall the Root Broker proof sink.
  const failPending = (error: Error) => { for (const waiter of pending.values()) waiter.reject(error); pending.clear(); };
  const connect = () => new Promise<void>((resolve, reject) => { socket = net.createConnection(endpoint, () => { connected = true; resolve(); }); socket.setEncoding("utf8"); socket.on("data", (chunk) => { buffer += chunk; let i; while ((i = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); try { const reply = parseCoordinatorReply(JSON.parse(line)); const waiter = pending.get(reply.requestId); if (waiter) { if (reply.repositoryId !== metadata.repositoryId) waiter.reject(new Error("Coordinator reply repository identity mismatch")); else waiter.resolve(reply); pending.delete(reply.requestId); } } catch { /* malformed replies are ignored */ } } }); socket.on("error", (error: Error) => { if (!connected) reject(error); else failPending(new Error(`Coordinator transport failed: ${error.message}`)); }); socket.on("close", () => failPending(new Error("Coordinator connection closed"))); });
  await connect();
  const send = (value: any) => { const requestId = value.requestId || randomUUID(); return new Promise<any>((resolve, reject) => { if (!socket || socket.destroyed || !socket.writable) { reject(new Error("Coordinator connection closed")); return; } pending.set(requestId, { resolve: (reply: any) => reply.ok ? resolve(reply.result) : reject(new Error(reply.error || "Coordinator request failed")), reject }); socket.write(`${JSON.stringify({ ...value, requestId })}\n`, (error) => { if (error) { pending.delete(requestId); reject(error); } }); }); };
  const registration = await send({ protocol: "repository-workspace-coordinator.v1", repositoryId: identity.repositoryId, method: "broker.register", brokerRegistry: brokerRegistration });
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
    activateResume: (input: any) => workspace("recovery.activate-resume", input),
    recoveryDiscard: (input: any) => workspace("recovery.discard", input),
    recoveryRelease: (input: any) => workspace("recovery.release", input),
    async close() { socket?.end(); failPending(new Error("Coordinator client closed")); },
  };
}
