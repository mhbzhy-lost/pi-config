import { createHash, randomBytes } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { createServer, Socket } from "node:net";
import { rm } from "node:fs/promises";
import { closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync, constants as fsConstants } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { materializeSettlementEvidence } from "../contracts/settlement-evidence.ts";
import { captureProcessBirthIdentity } from "./process-birth-identity.ts";
import { AuthorityStore, AuthorityStoreError } from "./authority-store.ts";
import { createOwnerReceipt, HEARTBEAT_LEASE_MS, HEARTBEAT_RENEW_MS, parseRebindRequest, parseRevokeRequest, type OwnerReceiptV1 } from "./authority-contract.ts";
import { assertRunAuthorization, type RunAuthorization } from "./run-authorization.ts";
import {
  brokerSocketPath,
  createBrokerFailureResponse,
  createBrokerSuccessResponse,
  ensureBrokerSocketDirectory,
  parseBrokerRequest,
  parseProcessTerminal,
  COORDINATOR_OPERATIONS,
  setBrokerSocketPermissions,
  writeBrokerGrant,
} from "./root-broker-protocol.ts";

type Upstream = {
  ping: (...args: any[]) => Promise<any> | any;
  stop: (...args: any[]) => Promise<any> | any;
  dispose?: () => void | Promise<void>;
};
type Principal = { callerToken: string; capabilities: ReadonlySet<"root.subscribe" | "acceptance.submit"> };
/** Observable outcome of handing an accepted official terminal to the coordinator proof sink. */
export type TerminalProofDeliveryOutcome =
  | { state: "delivered"; receipt: unknown }
  | { state: "pending"; reason: string }
  | { state: "debt"; reason: string }
  | { state: "not-applicable"; reason: string };
type OwnedRun = {
  rootSessionId: string;
  runId: string;
  asyncDir: string;
  sessionId: string;
  pid: number;
  agentProfile: string;
  capabilities: ReadonlySet<"root.subscribe" | "acceptance.submit">;
  authorization: Readonly<RunAuthorization>;
  birthIdentity: string | null;
  identityState: "verified" | "unavailable" | "conflict";
};
type GoalOwnedAuthority = {
  goalId: string; taskId: string; attempt: number; runId: string; asyncDir: string;
  workspacePath: string; leaseId: string; sessionId: string; baseHead: string;
  headAtDispatch: string; executionRevision: number; contractHash: string; expectedCriteria: string[]; agentProfile: string;
};
type GoalBindingSidecar = GoalOwnedAuthority & { version: "root-broker.goal-run-binding-authority.v2"; ticketId: string };
const GOAL_BINDING_SIDECAR = "root-broker.goal-run-binding-authority.v2.json";
const goalOwnedAuthorityKeys = ["goalId", "taskId", "attempt", "runId", "asyncDir", "workspacePath", "leaseId", "sessionId", "baseHead", "headAtDispatch", "executionRevision", "contractHash", "expectedCriteria", "agentProfile"];
const goalOwnedStopRequestKeys = ["goalId", "taskId", "attempt", "runId", "asyncDir", "workspacePath", "leaseId", "sessionId", "baseHead", "headAtDispatch", "executionRevision", "contractHash", "agent"];
function exactKeys(value: any, keys: string[]) { return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function authorityFields(value: any) { return Object.fromEntries(goalOwnedAuthorityKeys.map((key) => [key, value?.[key]])); }
function validGoalOwnedAuthority(value: any): value is GoalOwnedAuthority {
  return exactKeys(value, goalOwnedAuthorityKeys)
    && typeof value.goalId === "string" && !!value.goalId && typeof value.taskId === "string" && !!value.taskId
    && Number.isSafeInteger(value.attempt) && value.attempt > 0 && typeof value.runId === "string" && !!value.runId
    && typeof value.asyncDir === "string" && path.isAbsolute(value.asyncDir) && typeof value.workspacePath === "string" && path.isAbsolute(value.workspacePath)
    && typeof value.leaseId === "string" && /^[a-f0-9]{64}$/.test(value.leaseId) && typeof value.sessionId === "string" && !!value.sessionId
    && typeof value.baseHead === "string" && /^[a-f0-9]{40}$/.test(value.baseHead) && typeof value.headAtDispatch === "string" && /^[a-f0-9]{40}$/.test(value.headAtDispatch)
    && Number.isSafeInteger(value.executionRevision) && value.executionRevision > 0 && typeof value.contractHash === "string" && /^[a-f0-9]{64}$/.test(value.contractHash)
    && Array.isArray(value.expectedCriteria) && value.expectedCriteria.length > 0 && value.expectedCriteria.length <= 32
    && value.expectedCriteria.every((id: unknown) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(id))
    && new Set(value.expectedCriteria).size === value.expectedCriteria.length
    && typeof value.agentProfile === "string" && value.agentProfile.length > 0;
}

function validGoalOwnedStopRequest(value: any) {
  if (!exactKeys(value, goalOwnedStopRequestKeys) || value.agent !== "executor") return false;
  const { agent: _agent, ...identity } = value;
  return validGoalOwnedAuthority({ ...identity, expectedCriteria: ["authority"], agentProfile: "authority" });
}

type FacadeRun = {
  runId: string;
  asyncDir: string;
  sessionId: string;
  pid: number;
  agent: string;
  kind: string;
};
type Dependencies = {
  writeGrant?: typeof writeBrokerGrant;
  randomToken?: () => string;
  captureProcessBirthIdentity?: typeof captureProcessBirthIdentity;
  killProcess?: (pid: number, signal: "SIGKILL") => void;
  events?: { on(channel: string, listener: (event: any) => void | Promise<void>): () => void };
  terminalTimeoutMs?: number;
  lstat?: typeof lstatSync;
  artifactPollIntervalMs?: number;
  lifecycleSessionId?: string;
  setSocketPermissions?: typeof setBrokerSocketPermissions;
  /**
   * Delivers only a proof accepted by the Root Broker authority boundary and
   * must report a durable outcome: a persisted receipt, a replayable pending
   * proof, or an observable proof debt. Failures are never silent.
   */
  recordTerminalProof?: (run: OwnedRun | FacadeRun, proof: any) => Promise<TerminalProofDeliveryOutcome> | TerminalProofDeliveryOutcome;
  coordinatorRequest?: (runId: string, operation: string, input: any) => Promise<unknown> | unknown;
  /**
   * Bounded wait for an owned child's in-flight integration (coordinator)
   * request during Root close. The broker must never tear down its transport
   * while a child integration request is still settling; if the request cannot
   * settle within this deadline it becomes observable integration debt instead
   * of an unbounded hang.
   */
  integrationTimeoutMs?: number;
  authorityStore?: AuthorityStore;
  clock?: () => number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  diagnosticSink?: (entry: unknown) => void;
};

const MAX_BUFFER = 64 * 1024;
// Bug #4 fix ②: parallel registrations race the same authority-index lock for
// a single-digit-millisecond critical section. Bounded retry with a short
// linear backoff lets both registrants settle inside one dispatch window.
const AUTHORITY_CONTENTION_RETRY_MAX_ATTEMPTS = 3;
const AUTHORITY_CONTENTION_RETRY_BACKOFF_MS = 25;
const execFile = promisify(execFileCallback);

class TerminalDeadlineError extends Error {
  code = "ROOT_TERMINAL_DEADLINE";
}

function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function proofId(value: any) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

/** Canonical identity of an accepted official terminal; shared with the coordinator proof outbox. */
export function rootBrokerTerminalProofId(proof: any): string {
  return proofId(proof);
}

function frozen<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as any)) frozen(child);
  return Object.freeze(value);
}

function sameAuthority(left: any, right: any) {
  return goalOwnedAuthorityKeys.every((key) => key === "expectedCriteria"
    ? JSON.stringify(left?.[key]) === JSON.stringify(right?.[key])
    : left?.[key] === right?.[key]);
}

function brokerError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

/** A sink that does not report a durable outcome is treated as proof debt. */
export function deliveryOutcome(value: any): TerminalProofDeliveryOutcome {
  if (value?.state === "delivered") return { state: "delivered", receipt: structuredClone(value.receipt ?? null) };
  if (value?.state === "pending") return { state: "pending", reason: typeof value.reason === "string" && value.reason.trim() ? value.reason : "coordinator proof sink did not persist a receipt" };
  if (value?.state === "debt") return { state: "debt", reason: typeof value.reason === "string" && value.reason.trim() ? value.reason : "coordinator proof sink could not resolve the trusted run binding" };
  if (value?.state === "not-applicable") return { state: "not-applicable", reason: typeof value.reason === "string" && value.reason.trim() ? value.reason : "run owns no managed workspace" };
  return { state: "debt", reason: "coordinator proof sink did not report a delivery outcome" };
}

function failure(request: any, code: string, message: string) {
  return createBrokerFailureResponse({
    requestId: request?.requestId ?? "invalid-request",
    rootSessionId: request?.rootSessionId ?? "invalid-root",
    callerRunId: request?.callerRunId ?? "invalid-caller",
    code,
    message: String(message).slice(0, 1024) || "Broker request failed",
  });
}

export class RootBrokerServer {
  rootSessionId: string;
  lifecycleSessionId: string;
  upstream: Upstream;
  principals = new Map<string, Principal>();
  revokedRuns = new Set<string>();
  subscriptions = new Map<string, Set<Socket>>();
  /** Recovery notifications are delivery-only; coordinator/workspace receipts remain authoritative. */
  recoveryNotifications: any[] = [];
  recoveryNotificationDebt: any[] = [];
  sockets = new Set<Socket>();
  grantPaths = new Set<string>();
  authorizationGrants = new Map<string, Promise<{ callerToken: string }>>();
  ownedRuns = new Map<string, OwnedRun>();
  goalAuthorities = new Map<string, Readonly<GoalBindingSidecar>>();
  facadeRuns = new Map<string, FacadeRun>();
  terminalProofs = new Map<string, any>();
  private executionFactListeners = new Set<(runId: string) => void>();
  private executionFactNotifications = new Set<string>();
  private executionFactDeliveries = new Set<string>();

  subscribeExecutionFacts(listener: (runId: string) => void): () => void {
    this.executionFactListeners.add(listener);
    return () => { this.executionFactListeners.delete(listener); };
  }

  notifyExecutionFacts(runId: string): void {
    if (this.executionFactNotifications.has(runId)) return;
    this.executionFactNotifications.add(runId);
    queueMicrotask(() => {
      this.executionFactNotifications.delete(runId);
      for (const listener of this.executionFactListeners) {
        try { listener(runId); } catch { /* 失效提示不改变权威处理结果。 */ }
      }
    });
  }

  hasExecutionFactWakeup(runId: string): boolean {
    const run = this.ownedRuns.get(runId);
    return !this.closed && this.executionFactListeners.size > 0 && run?.identityState === "verified"
      && (!this.terminalProofs.has(runId) || this.executionFactDeliveries.has(runId));
  }

  terminalConflicts = new Set<string>();
  forcePendingRuns = new Set<string>();
  terminalWaiters = new Map<string, Set<(proof: any) => void>>();
  terminalProofDelivery = new Map<string, TerminalProofDeliveryOutcome>();
  terminalProofDeliveries = new Map<string, Promise<void>>();
  leaseReleasePromises = new Map<string, Promise<void>>();
  leaseReleaseDebt = new Map<string, string>();
  startedObservations = new Map<string, Promise<void>>();
  unsubscribeStarted: (() => void) | undefined;
  unsubscribeTerminal: (() => void) | undefined;
  server: ReturnType<typeof createServer> | undefined;
  closed = false;
  closePromise: Promise<void> | undefined;
  teardown = { grants: false, transport: false, upstream: false, released: false };
  cleanedGrantPaths = new Set<string>();
  transportSockets = new Set<Socket>();
  closingSockets = new Set<Socket>();
  endedSockets = new Set<Socket>();
  writeGrant: typeof writeBrokerGrant;
  randomToken: () => string;
  captureProcessBirthIdentity: typeof captureProcessBirthIdentity;
  killProcess: (pid: number, signal: "SIGKILL") => void;
  events: Dependencies["events"];
  terminalTimeoutMs: number;
  lstat: typeof lstatSync;
  artifactPollIntervalMs: number;
  setSocketPermissions: typeof setBrokerSocketPermissions;
  recordTerminalProof?: Dependencies["recordTerminalProof"];
  coordinatorRequest?: Dependencies["coordinatorRequest"];
  coordinatorChallengeNonces = new Set<string>();
  integrationTimeoutMs: number;
  authorityStore?: AuthorityStore;
  clock: () => number;
  setHeartbeatInterval: typeof setInterval;
  clearHeartbeatInterval: typeof clearInterval;
  heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  /**
   * In-flight child integration (coordinator) requests keyed by caller run. The
   * broker keeps its transport open until each owned request settles so a child
   * never observes BROKER_DISCONNECTED for work the Root asked it to perform.
   */
  integrationRequests = new Map<string, Set<{ operation: string; settled: Promise<void> }>>();
  /** Connections whose first request line has not reached the parser yet. */
  requestBoundaries = new Set<Socket>();
  /** Observable preserved/debt state when an integration request cannot settle before close. */
  integrationDebt = new Map<string, { operation: string; reason: string }>();
  requestBoundaryDebt = 0;
  diagnosticSink?: (entry: unknown) => void;

  constructor({
    rootSessionId,
    lifecycleSessionId = rootSessionId,
    upstream,
    writeGrant = writeBrokerGrant,
    randomToken = () => randomBytes(32).toString("hex"),
    captureProcessBirthIdentity: captureBirthIdentity = captureProcessBirthIdentity,
    killProcess = process.kill,
    events,
    terminalTimeoutMs = 5_000,
    lstat: stat = lstatSync,
    artifactPollIntervalMs = 50,
    setSocketPermissions: applySocketPermissions = setBrokerSocketPermissions,
    recordTerminalProof,
    coordinatorRequest,
    integrationTimeoutMs = 10_000,
    authorityStore,
    clock = Date.now,
    setInterval: setHeartbeatInterval = setInterval,
    clearInterval: clearHeartbeatInterval = clearInterval,
    diagnosticSink,
  }: { rootSessionId: string; upstream: Upstream } & Dependencies) {
    if (!Number.isSafeInteger(terminalTimeoutMs) || terminalTimeoutMs <= 0) throw new Error("Root subagent broker terminal timeout must be a positive safe integer");
    if (!Number.isSafeInteger(artifactPollIntervalMs) || artifactPollIntervalMs <= 0) throw new Error("Root subagent broker artifact poll interval must be a positive safe integer");
    if (!Number.isSafeInteger(integrationTimeoutMs) || integrationTimeoutMs <= 0) throw new Error("Root subagent broker integration timeout must be a positive safe integer");
    this.rootSessionId = rootSessionId;
    this.lifecycleSessionId = lifecycleSessionId;
    this.upstream = upstream;
    this.writeGrant = writeGrant;
    this.randomToken = randomToken;
    this.captureProcessBirthIdentity = captureBirthIdentity;
    this.killProcess = killProcess;
    this.events = events;
    this.terminalTimeoutMs = terminalTimeoutMs;
    this.lstat = stat;
    this.artifactPollIntervalMs = artifactPollIntervalMs;
    this.setSocketPermissions = applySocketPermissions;
    this.recordTerminalProof = recordTerminalProof;
    this.coordinatorRequest = coordinatorRequest;
    this.integrationTimeoutMs = integrationTimeoutMs;
    this.authorityStore = authorityStore;
    this.clock = clock;
    this.setHeartbeatInterval = setHeartbeatInterval;
    this.clearHeartbeatInterval = clearHeartbeatInterval;
    this.diagnosticSink = diagnosticSink;
    this.authorityStore?.setRootSessionId(rootSessionId);
  }

  async start() {
    if (this.server) throw new Error("Root subagent broker is already started");
    const socketPath = brokerSocketPath(this.rootSessionId);
    let server: ReturnType<typeof createServer> | undefined;
    try {
      await ensureBrokerSocketDirectory(this.rootSessionId);
      await rm(socketPath, { force: true });
      server = createServer((socket) => this.handleSocket(socket));
      this.server = server;
      await new Promise<void>((resolve, reject) => {
        const fail = (error: Error) => { server?.off("error", fail); reject(error); };
        server!.once("error", fail);
        server!.listen(socketPath, () => { server?.off("error", fail); resolve(); });
      });
      await this.setSocketPermissions(socketPath);
      this.unsubscribeStarted = this.events?.on("subagent:async-started", (event) => this.observeStarted(event));
      this.unsubscribeTerminal = this.events?.on("subagent:process-terminal", (event) => this.observeTerminal(event));
      // Returning the Promise keeps injected deterministic timers awaitable;
      // native setInterval intentionally ignores callback return values.
      this.heartbeatTimer = this.setHeartbeatInterval(() => this.renewHeartbeats(), HEARTBEAT_RENEW_MS);
    } catch (error) {
      try { this.unsubscribeTerminal?.(); } catch { /* preserve the startup failure */ }
      this.unsubscribeTerminal = undefined;
      try { this.unsubscribeStarted?.(); } catch { /* preserve the startup failure */ }
      this.unsubscribeStarted = undefined;
      const destroyLateSocket = (socket: Socket) => socket.destroy();
      server?.on("connection", destroyLateSocket);
      for (const socket of this.sockets) socket.destroy();
      try { await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve()); } catch { /* preserve the startup failure */ }
      server?.off("connection", destroyLateSocket);
      this.sockets.clear();
      this.server = undefined;
      try { await rm(socketPath, { force: true }); } catch { /* preserve the startup failure */ }
      throw error;
    }
  }

  // Kept as a non-authorizing ABI stub until the legacy event facade is removed.
  startedFacts(_event: any): undefined { return undefined; }

  facadeMatchesBinding(facade: FacadeRun, binding: RunAuthorization["binding"]) {
    // `kind` is a facade classification, not an authority or process identity.
    return facade.runId === binding.runId && facade.asyncDir === binding.asyncDir
      && facade.sessionId === binding.sessionId && facade.pid === binding.pid
      && facade.agent === binding.agentProfile;
  }

  promoteFacadeRun(authorization: Readonly<RunAuthorization>) {
    const binding = authorization.binding;
    const facade = this.facadeRuns.get(binding.runId);
    if (!facade) return;
    if (!this.facadeMatchesBinding(facade, binding)) throw new Error("Facade run identity conflicts");
    // A terminal observed before Host authority remains facade-only evidence; it
    // must never become settlement evidence through promotion.
    this.facadeRuns.delete(binding.runId);
    this.terminalProofs.delete(binding.runId);
    this.terminalConflicts.delete(binding.runId);
  }

  registerFacadeRun(value: any): void {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || typeof value.runId !== "string" || value.runId.length === 0
      || typeof value.asyncDir !== "string" || !path.isAbsolute(value.asyncDir)
      || typeof value.sessionId !== "string" || value.sessionId !== this.lifecycleSessionId
      || !Number.isSafeInteger(value.pid) || value.pid <= 0
      || typeof value.agent !== "string" || value.agent.length === 0
      || typeof value.kind !== "string" || value.kind.length === 0) {
      throw new Error("Facade run identity is invalid");
    }
    const incoming: FacadeRun = { runId: value.runId, asyncDir: value.asyncDir, sessionId: value.sessionId, pid: value.pid, agent: value.agent, kind: value.kind };
    const owned = this.ownedRuns.get(incoming.runId);
    if (owned) {
      if (!this.facadeMatchesBinding(incoming, owned.authorization.binding)) throw new Error("Facade run identity conflicts");
      return; // owned is the sole record; facade observations cannot duplicate it.
    }
    const existing = this.facadeRuns.get(incoming.runId);
    if (existing && (existing.asyncDir !== incoming.asyncDir || existing.sessionId !== incoming.sessionId || existing.pid !== incoming.pid || existing.agent !== incoming.agent)) {
      throw new Error("Facade run identity conflicts");
    }
    // `kind` is a non-authoritative observation. A workflow may first be
    // observed through the generic upstream event classifier and later be
    // registered by Host authorization as generic; never fence valid identity
    // on that label alone.
    this.facadeRuns.set(incoming.runId, existing ?? incoming);
  }

  async registerAuthorizedRun(authorization: Readonly<RunAuthorization>): Promise<void> {
    if (this.closed) throw new Error("Root subagent broker is closing");
    assertRunAuthorization(authorization);
    const binding = authorization.binding;
    if (this.revokedRuns.has(binding.runId)) throw new Error("Run authorization has been revoked");
    if (binding.sessionId !== this.lifecycleSessionId) {
      throw new Error("Run authorization session does not match Root broker");
    }
    const existing = this.ownedRuns.get(binding.runId);
    if (existing && (existing.asyncDir !== binding.asyncDir || existing.sessionId !== binding.sessionId || existing.pid !== binding.pid || existing.agentProfile !== binding.agentProfile
      || JSON.stringify([...existing.capabilities].sort()) !== JSON.stringify([...authorization.capabilities].sort())
      || JSON.stringify(existing.authorization.goal) !== JSON.stringify(authorization.goal))) {
      throw new Error("Run authorization binding conflicts");
    }
    if (existing) return;
    if (authorization.capabilities.length === 0) {
      this.registerFacadeRun({ runId: binding.runId, asyncDir: binding.asyncDir, sessionId: binding.sessionId, pid: binding.pid, agent: binding.agentProfile, kind: authorization.kind });
      // A generic run is a terminal-proof facade, not a broker principal, but
      // its owner identity is still needed by the control plane. Persist that
      // identity without promoting the run into the capability-bearing owned
      // set below.
      if (this.authorityStore) {
        const birthIdentity = await this.captureProcessBirthIdentity(binding.pid).catch(() => undefined);
        if (typeof birthIdentity === "string" && birthIdentity.trim().length > 0) {
          const receipt = createOwnerReceipt({
            receiptId: `owner-${createHash("sha256").update(`${this.rootSessionId}:${binding.runId}:1`).digest("hex").slice(0, 48)}`,
            rootSessionId: this.rootSessionId,
            runId: binding.runId,
            ownerGeneration: 1,
            processBirth: birthIdentity,
            revision: 1,
            authorizationReference: `sha256:${createHash("sha256").update(JSON.stringify(authorization)).digest("hex")}`,
          });
          await this.createAuthorityLeaseWithRetry(receipt, { leaseId: `lease-${createHash("sha256").update(`${this.rootSessionId}:${binding.runId}:1`).digest("hex").slice(0, 48)}`, now: this.clock(), windowMs: HEARTBEAT_LEASE_MS });
        }
      }
      return;
    }
    this.promoteFacadeRun(authorization);
    const initial: OwnedRun = {
      rootSessionId: this.rootSessionId,
      runId: binding.runId,
      asyncDir: binding.asyncDir,
      sessionId: binding.sessionId,
      pid: binding.pid,
      agentProfile: binding.agentProfile,
      capabilities: new Set(authorization.capabilities),
      authorization,
      birthIdentity: null,
      identityState: "unavailable",
    };
    this.ownedRuns.set(binding.runId, initial);
    const observation = (async () => {
      let birthIdentity: string | null = null;
      let identityState: OwnedRun["identityState"] = "unavailable";
      try {
        const observedBirthIdentity = await this.captureProcessBirthIdentity(binding.pid);
        if (typeof observedBirthIdentity === "string" && observedBirthIdentity.trim().length > 0) {
          birthIdentity = observedBirthIdentity;
          identityState = "verified";
        }
      } catch { /* unavailable identity cannot become verified */ }
      const current = this.ownedRuns.get(binding.runId) ?? initial;
      this.ownedRuns.set(binding.runId, { ...current, birthIdentity, identityState: current.identityState === "conflict" ? "conflict" : identityState });
      // Legacy construction remains valid without durable authority storage,
      // but authority receipts are never synthesized from this in-memory run.
      if (identityState === "verified" && this.authorityStore) {
        const receipt = createOwnerReceipt({
          receiptId: `owner-${createHash("sha256").update(`${this.rootSessionId}:${binding.runId}:1`).digest("hex").slice(0, 48)}`,
          rootSessionId: this.rootSessionId,
          runId: binding.runId,
          ownerGeneration: 1,
          processBirth: birthIdentity!,
          revision: 1,
          authorizationReference: `sha256:${createHash("sha256").update(JSON.stringify(authorization)).digest("hex")}`,
        });
        await this.createAuthorityLeaseWithRetry(receipt, { leaseId: `lease-${createHash("sha256").update(`${this.rootSessionId}:${binding.runId}:1`).digest("hex").slice(0, 48)}`, now: this.clock(), windowMs: HEARTBEAT_LEASE_MS });
      }
      // A successful authorization reply follows the durable owner receipt.
      await this.ensureAuthorizedPrincipal(binding.runId);
    })();
    this.startedObservations.set(binding.runId, observation);
    try {
      await observation;
    } catch (error) {
      const current = this.ownedRuns.get(binding.runId);
      if (current?.authorization === authorization && !this.principals.has(binding.runId)) this.ownedRuns.delete(binding.runId);
      throw error;
    } finally {
      if (this.startedObservations.get(binding.runId) === observation) this.startedObservations.delete(binding.runId);
    }
  }

  /**
   * Bug #4 fix ②: authority-index lock contention is a transient same-window
   * race between parallel registrations, not an authority or storage fault.
   * Retry only the distinctive contention code, bounded by a short linear
   * backoff; deterministic authority failures and genuine storage faults fail
   * fast on the first attempt.
   */
  private async createAuthorityLeaseWithRetry(receipt: OwnerReceiptV1, input: { leaseId: string; now: number; windowMs: number }): Promise<unknown> {
    const store = this.requireAuthorityStore();
    for (let attempt = 1; ; attempt++) {
      try {
        return await store.createWithLease(receipt, input);
      } catch (error) {
        if (!(error instanceof AuthorityStoreError) || error.code !== "authority_lock_contention" || attempt >= AUTHORITY_CONTENTION_RETRY_MAX_ATTEMPTS) throw error;
        await new Promise((resolve) => setTimeout(resolve, AUTHORITY_CONTENTION_RETRY_BACKOFF_MS * attempt));
      }
    }
  }
  private requireAuthorityStore(): AuthorityStore {
    if (!this.authorityStore) throw brokerError("authority_store_unavailable", "Root Broker authority storage is unavailable");
    return this.authorityStore;
  }

  async readOwnerReceipt(runId: string): Promise<OwnerReceiptV1> {
    try {
      const current = await this.requireAuthorityStore().read(runId);
      if (current.revoked || current.supersededTo) throw brokerError("unknown_run", "Owner is no longer current");
      return current.receipt;
    } catch (error) { throw this.authorityError(error); }
  }

  async rebindRun(value: unknown): Promise<OwnerReceiptV1> {
    const request = parseRebindRequest(value);
    const store = this.requireAuthorityStore();
    try {
      const source = await store.read(request.sourceRunId);
      const resumed = await store.read(request.resumedRunId);
      if (source.revoked) throw brokerError("unknown_run", "Source owner is revoked");
      if (source.receipt.ownerGeneration !== request.expectedGeneration || source.receipt.revision !== request.expectedRevision) throw brokerError("stale_generation", "Source authority is stale");
      if (source.receipt.processBirth !== request.expectedProcessBirth) throw brokerError("process_birth_mismatch", "Expected source process birth does not match");
      if (resumed.receipt.revision !== request.expectedResumedRevision) throw brokerError("cas_conflict", "Resumed authority revision conflicts");
      const sourceRun = this.ownedRuns.get(request.sourceRunId), resumedRun = this.ownedRuns.get(request.resumedRunId);
      if (!sourceRun || sourceRun.identityState !== "verified" || !resumedRun || resumedRun.identityState !== "verified") throw brokerError("unknown_run", "Both runs require verified process birth");
      if (sourceRun.sessionId !== this.lifecycleSessionId || resumedRun.sessionId !== this.lifecycleSessionId) throw brokerError("process_birth_mismatch", "Lifecycle session does not match");
      const requestDigest = `sha256:${createHash("sha256").update(JSON.stringify(request)).digest("hex")}`;
      return await store.associate(request.sourceRunId, request.resumedRunId, requestDigest, request.expectedRevision, request.expectedResumedRevision);
    } catch (error) { throw this.authorityError(error); }
  }

  async revokeOwner(value: unknown): Promise<void> {
    const request = parseRevokeRequest(value);
    const store = this.requireAuthorityStore();
    try {
      const current = await store.read(request.runId);
      if (current.revoked) return;
      if (current.receipt.ownerGeneration !== request.ownerGeneration) throw brokerError("stale_generation", "Owner generation is stale");
      if (current.receipt.revision !== request.expectedRevision) throw brokerError("cas_conflict", "Owner revision conflicts");
      if (current.receipt.processBirth !== request.processBirth) throw brokerError("process_birth_mismatch", "Process birth does not match");
      await store.revoke(request.runId, current.revision);
    } catch (error) { throw this.authorityError(error); }
  }

  private authorityError(error: unknown): Error {
    if (error instanceof AuthorityStoreError) return brokerError(error.code, error.message);
    return error instanceof Error ? error : brokerError("authority_store_unavailable", "Root Broker authority storage is unavailable");
  }

  /** Pure Host control-plane renewal: no upstream, event, message, or turn call. */
  async renewHeartbeats() {
    if (this.closed || !this.authorityStore) return;
    for (const run of this.ownedRuns.values()) {
      if (run.identityState !== "verified" || !run.birthIdentity) continue;
      try {
        const lease = await this.authorityStore.readLease(run.runId);
        const renewed = await this.authorityStore.renewLease({ runId: run.runId, leaseId: lease.leaseId, ownerGeneration: lease.ownerGeneration, processBirth: run.birthIdentity, expectedRevision: lease.revision, expectedRenewalSequence: lease.renewalSequence, now: this.clock(), windowMs: HEARTBEAT_LEASE_MS });
        this.publishLeaseUpdate(run.runId, renewed);
      } catch { /* A fenced, terminal, or unavailable lease is never revived. */ }
    }
  }
  publishLeaseUpdate(callerRunId: string, lease: any) {
    for (const socket of this.subscriptions.get(callerRunId) ?? []) if (!socket.destroyed) {
      try { socket.write(`${JSON.stringify({ schemaVersion: "pi-root-subagent-broker-push.v1", rootSessionId: this.rootSessionId, callerRunId, type: "lease.updated", data: { leaseId: lease.leaseId, runId: lease.runId, ownerGeneration: lease.ownerGeneration, lastRenewedAt: lease.lastRenewedAt, expiresAt: lease.expiresAt, renewalSequence: lease.renewalSequence } })}\n`); } catch {}
    }
  }

  persistGoalBindingAuthority(value: GoalBindingSidecar): void {
    if (!exactKeys(value, [...goalOwnedAuthorityKeys, "version", "ticketId"]) || !validGoalOwnedAuthority(authorityFields(value)) || value.version !== "root-broker.goal-run-binding-authority.v2" || !/^[a-f0-9]{64}$/.test(value.ticketId)) throw new Error("Goal binding sidecar is invalid");
    if (value.sessionId !== this.lifecycleSessionId) throw new Error("Goal binding sidecar session is invalid");
    const registered = frozen(structuredClone(value));
    const existing = this.goalAuthorities.get(value.runId);
    if (existing && !sameAuthority(existing, registered)) throw new Error("Goal binding sidecar conflicts");
    const directory = value.asyncDir;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directoryStat = lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("Goal binding sidecar directory is unsafe");
    const file = path.join(directory, GOAL_BINDING_SIDECAR);
    const bytes = Buffer.from(JSON.stringify(value));
    try {
      const fd = openSync(file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      const dirFd = openSync(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) throw new Error("Goal binding sidecar is unsafe");
      if (!readFileSync(file).equals(bytes)) throw new Error("Goal binding sidecar conflicts");
    }
    this.goalAuthorities.set(value.runId, existing ?? registered);
  }

  // live 与恢复读取复用同一安全文件边界；读取本身不授予 run 权限。
  private readOfficialTerminalArtifact(asyncDir: string) {
    const file = path.join(asyncDir, "process-terminal.json");
    const safeStat = (stat: ReturnType<typeof lstatSync>) => {
      const mode = Number(stat.mode) & 0o777;
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (mode !== 0o600 && mode !== 0o644)
        || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("official terminal artifact is unsafe");
    };
    const before = this.lstat(file); safeStat(before);
    const fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let bytes: Buffer; let opened: ReturnType<typeof fstatSync>;
    try { opened = fstatSync(fd); safeStat(opened); bytes = readFileSync(fd); } finally { closeSync(fd); }
    const after = this.lstat(file); safeStat(after);
    if (before.dev !== opened.dev || before.ino !== opened.ino || after.dev !== opened.dev || after.ino !== opened.ino || opened.size !== bytes.length) throw new Error("official terminal artifact changed while reading");
    return JSON.parse(bytes.toString("utf8"));
  }

  /** 仅重建终局事实；调用方提供经 coordinator 验证的持久化 workspace/proof 绑定。 */
  async inspectPersistedTerminalProof(record: any, persisted: any) {
    const run = record?.run;
    if (this.closed || record?.owner?.kind !== "standalone-subagent" || record.owner.rootSessionId !== this.rootSessionId
        || !run?.runId || typeof run.asyncDir !== "string" || !path.isAbsolute(run.asyncDir)
        || persisted?.state !== "observed" || persisted.conflict !== false
        || persisted.rootSessionId !== this.rootSessionId || persisted.runId !== run.runId || persisted.asyncDir !== run.asyncDir) {
      throw new Error("PLAN_PERSISTED_PROOF_BINDING_INVALID");
    }
    const owner = await this.readOwnerReceipt(run.runId);
    if (owner.rootSessionId !== this.rootSessionId || owner.runId !== run.runId) throw new Error("PLAN_PERSISTED_OWNER_INVALID");
    const value = this.readOfficialTerminalArtifact(run.asyncDir);
    const { runId, ...terminal } = value;
    parseProcessTerminal(terminal);
    if (this.closed || runId !== run.runId || terminal.state !== "observed"
        || terminal.runnerProcessInstanceId !== persisted.processInstance || proofId(value) !== persisted.proofId) {
      throw new Error("PLAN_PERSISTED_PROOF_MISMATCH");
    }
    return frozen({ proofId: persisted.proofId,
      outcome: terminal.instances.every((instance: any) => instance.exitCode === 0 && instance.signal === null) ? "succeeded" as const : "failed" as const });
  }

  readAndAcceptOfficialTerminalArtifact(run: OwnedRun) {
    const value = this.readOfficialTerminalArtifact(run.asyncDir);
    if (value?.state === 'pending') {
      const { runId, ...terminal } = value;
      if (runId !== run.runId) throw new Error('official terminal runId mismatch');
      parseProcessTerminal(terminal);
      return undefined;
    }
    return this.acceptTerminalProof(run, value);
  }

  recoverGoalRunBinding(ticket: any) {
    // Only a live Host registration can recover an unbound projection attempt.
    // Session history, status artifacts, and facade records are never authority.
    if (!ticket || ticket.version !== "goal-run-binding-ticket.v2") return null;
    const matches = [...this.ownedRuns.values()].filter((run) => {
      const goal = run.authorization.goal;
      return run.identityState === "verified" && !!goal
        && run.sessionId === this.lifecycleSessionId
        && run.agentProfile === ticket.agentProfile
        && goal.ticketId === ticket.ticketId && goal.goalId === ticket.goalId
        && goal.taskId === ticket.taskId && goal.attempt === ticket.attempt
        && goal.contractHash === ticket.contractHash && goal.workspaceId === ticket.workspaceId
        && goal.executionRevision === ticket.executionRevision
        && JSON.stringify(goal.expectedCriteria) === JSON.stringify(ticket.expectedCriteria);
    });
    if (matches.length !== 1) return null;
    const run = matches[0];
    return frozen({ runId: run.runId, asyncDir: run.asyncDir, sessionId: run.sessionId, agentProfile: run.agentProfile });
  }

  async recoverExactTerminalProof(binding: GoalOwnedAuthority) {
    // Recovery cannot manufacture ownership from status or a caller-provided binding.
    // A broker without its Host authorization record therefore fails closed.
    const run = this.ownedRuns.get(binding.runId);
    if (!run || !run.authorization.goal || run.identityState !== "verified" || run.asyncDir !== binding.asyncDir || run.sessionId !== binding.sessionId) {
      return frozen({ state: "attention", code: "OWNED_STOP_RECOVERY_UNAVAILABLE" });
    }
    try { this.readAndAcceptOfficialTerminalArtifact(run); }
    catch { return frozen({ state: "attention", code: "OWNED_STOP_RECOVERY_UNAVAILABLE" }); }
    const proof = this.terminalProofs.get(run.runId);
    return proof && !this.terminalConflicts.has(run.runId)
      ? frozen({ state: "observed", proof: structuredClone(proof) })
      : frozen({ state: "attention", code: "OWNED_STOP_RECOVERY_UNAVAILABLE" });
  }

  async stopGoalOwnedRun(value: any) {
    if (!validGoalOwnedStopRequest(value)) throw new Error("Goal owned stop identity mismatch");
    const run = this.ownedRuns.get(value.runId);
    const authority = this.goalAuthorities.get(value.runId);
    if (!run || !authority) return frozen({ state: "attention", code: "OWNED_STOP_IDENTITY_UNKNOWN" });
    const authorizationGoal = run.authorization.goal;
    const identityMatches = goalOwnedStopRequestKeys.filter((key) => key !== "agent").every((key) => value[key] === authority[key]);
    const authorizationMatches = !!authorizationGoal
      && run.runId === authority.runId && run.asyncDir === authority.asyncDir && run.sessionId === authority.sessionId
      && run.agentProfile === authority.agentProfile && authority.sessionId === this.lifecycleSessionId
      && authorizationGoal.ticketId === authority.ticketId && authorizationGoal.goalId === authority.goalId
      && authorizationGoal.taskId === authority.taskId && authorizationGoal.attempt === authority.attempt
      && authorizationGoal.contractHash === authority.contractHash && authorizationGoal.executionRevision === authority.executionRevision
      && JSON.stringify(authorizationGoal.expectedCriteria) === JSON.stringify(authority.expectedCriteria);
    if (!identityMatches || !authorizationMatches || run.identityState !== "verified" || this.terminalConflicts.has(run.runId)) return frozen({ state: "attention", code: "OWNED_STOP_IDENTITY_UNKNOWN" });
    try {
      if (!this.terminalProofs.has(run.runId)) {
        await Promise.resolve(this.upstream.stop({ runId: run.runId, dir: run.asyncDir }));
        await this.observeOfficialProof(run, "missing official proof for owned run");
      }
      const proof = this.terminalProofs.get(run.runId);
      if (!proof || this.terminalConflicts.has(run.runId)) return frozen({ state: "attention", code: "OWNED_STOP_PROOF_MISSING" });
      return frozen({ state: "observed", proof: structuredClone(proof) });
    } catch (error) {
      return frozen({ state: "attention", code: error instanceof TerminalDeadlineError ? "OWNED_STOP_TIMEOUT" : "OWNED_STOP_UNAVAILABLE" });
    }
  }

  observeStarted(event: any): Promise<void> {
    const runId = event?.runId ?? event?.id;
    if (typeof runId !== "string" || (event?.runId !== undefined && event?.id !== undefined && event.runId !== event.id)) return Promise.resolve();
    const run = this.ownedRuns.get(runId);
    if (!run) {
      try { this.registerFacadeRun({ runId, asyncDir: event.asyncDir, sessionId: event.sessionId, pid: event.pid, agent: event.agent, kind: "executor" }); } catch { /* untrusted or malformed starts are ignored */ }
      return Promise.resolve();
    }
    if (event.sessionId !== run.sessionId || event.pid !== run.pid || event.asyncDir !== run.asyncDir || event.agent !== run.agentProfile) {
      this.ownedRuns.set(runId, { ...run, identityState: "conflict" });
    }
    return this.startedObservations.get(runId) ?? Promise.resolve();
  }

  acceptTerminalProof(run: OwnedRun | FacadeRun, value: any) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid official terminal: proof must be an object");
    if (typeof value.runId !== "string" || value.runId !== run.runId) {
      throw new Error(`official terminal runId mismatch: expected ${run.runId}, actual ${String(value.runId)}`);
    }
    const identity = { sessionId: run.sessionId, pid: run.pid, asyncDir: run.asyncDir, agent: "agent" in run ? run.agent : run.agentProfile };
    for (const key of ["sessionId", "pid", "asyncDir", "agent"] as const) {
      if (value[key] !== undefined && value[key] !== identity[key]) throw new Error(`official terminal ${key} mismatch`);
    }
    const { runId: _runId, sessionId: _sessionId, pid: _pid, asyncDir: _asyncDir, agent: _agent, ...terminal } = value;
    try { parseProcessTerminal(terminal); } catch (error) { throw new Error(`invalid official terminal: ${error instanceof Error ? error.message : String(error)}`); }
    if (terminal.state !== "observed") throw new Error(`official terminal is non-observed (${String(terminal.state)})`);
    const accepted = frozen(structuredClone({ runId: run.runId, ...terminal }));
    const existing = this.terminalProofs.get(run.runId);
    if (existing) {
      if (proofId(existing) !== proofId(accepted)) {
        this.terminalConflicts.add(run.runId);
        this.notifyExecutionFacts(run.runId);
      }
      return existing;
    }
    this.terminalProofs.set(run.runId, accepted);
    // A capability is single-lifecycle: once the official terminal is
    // accepted, no late or replayed child request may use its grant. Facade
    // observations have no capability and must remain non-authorizing.
    if ("authorization" in run) {
      this.revokedRuns.add(run.runId);
      this.principals.delete(run.runId);
      this.trackTerminalLeaseRelease(run);
    }
    const waiters = this.terminalWaiters.get(run.runId);
    this.terminalWaiters.delete(run.runId);
    for (const resolve of waiters ?? []) resolve(accepted);
    // Delivery is tracked, not fire-and-forget: an accepted official terminal
    // must reach the coordinator proof sink, and a failure must stay
    // observable as pending or as proof debt instead of being swallowed.
    if (this.recordTerminalProof) this.trackTerminalProofDelivery(run, accepted);
    this.notifyExecutionFacts(run.runId);
    return accepted;
  }

  trackTerminalProofDelivery(run: OwnedRun | FacadeRun, proof: any) {
    this.terminalProofDelivery.set(run.runId, frozen({ state: "pending", reason: "coordinator proof sink delivery is in flight" }));
    this.executionFactDeliveries.add(run.runId);
    const attempt = (async () => {
      // A conflicting official terminal cannot be delivered as an outcome.
      if (this.terminalConflicts.has(run.runId)) {
        this.terminalProofDelivery.set(run.runId, frozen({ state: "debt", reason: "official terminal proof conflicts with an earlier accepted proof" }));
        return;
      }
      try {
        this.terminalProofDelivery.set(run.runId, frozen(deliveryOutcome(await this.recordTerminalProof!(run, proof))));
      } catch (error) {
        const reason = error instanceof Error && error.message ? error.message : String(error);
        this.terminalProofDelivery.set(run.runId, frozen({ state: "debt", reason }));
      }
    })();
    this.terminalProofDeliveries.set(run.runId, attempt.catch(() => undefined).finally(() => {
      this.executionFactDeliveries.delete(run.runId);
      this.notifyExecutionFacts(run.runId);
    }));
  }

  trackTerminalLeaseRelease(run: OwnedRun) {
    if (!this.authorityStore || this.leaseReleasePromises.has(run.runId)) return;
    const release = (async () => {
      try {
        const lease = await this.authorityStore!.readLease(run.runId);
        await this.authorityStore!.releaseLease({ runId: run.runId, leaseId: lease.leaseId, ownerGeneration: lease.ownerGeneration, processBirth: run.birthIdentity ?? lease.processBirth, expectedRevision: lease.revision });
      } catch (error) {
        this.leaseReleaseDebt.set(run.runId, error instanceof Error ? error.message : String(error));
      } finally {
        this.notifyExecutionFacts(run.runId);
      }
    })();
    this.leaseReleasePromises.set(run.runId, release);
  }

  /** Read-only observability; it never infers a terminal that was not accepted. */
  inspectTerminalProofDelivery(runId: string) {
    const delivery = this.terminalProofDelivery.get(runId);
    if (delivery) return frozen({ runId, ...delivery });
    return frozen({ runId, state: this.terminalProofs.has(runId) ? "pending" : "none", reason: null });
  }

  async awaitTerminalProofDeliveries() {
    await Promise.allSettled([...this.terminalProofDeliveries.values(), ...this.leaseReleasePromises.values()]);
  }

  observeTerminal(event: any) {
    const run = typeof event?.runId === "string" ? this.ownedRuns.get(event.runId) ?? this.facadeRuns.get(event.runId) : undefined;
    if (!run) return;
    try { this.acceptTerminalProof(run, event); } catch { /* strict official proof is the only authority */ }
  }

  inspectFacadeTerminalProof(runId: string) {
    const run = this.facadeRuns.get(runId);
    if (!run) return null;
    const proof = this.terminalProofs.get(runId) ?? null;
    return frozen({ runId, state: proof ? "observed" : "pending", proofHash: proof ? proofId(proof) : null, proof, conflict: this.terminalConflicts.has(runId) });
  }

  executorProofSnapshot(run: OwnedRun) {
    const authorized = run.identityState === "verified" && !!run.authorization.goal;
    // Terminal 观察是进程事实，不以 Goal 授权为前提：standalone managed
    // worktree child 的 proof/release 链同样需要已接受的 terminal proof。
    // authorization.state 独立报告 Goal 验证，不固化为 proof 可见性门禁。
    const proof = !this.terminalConflicts.has(run.runId) ? this.terminalProofs.get(run.runId) ?? null : null;
    const runner = proof?.instances?.find((instance: any) => instance.kind === "runner" && instance.processInstanceId === proof.runnerProcessInstanceId);
    const successful = Boolean(runner && proof.instances.every((instance: any) => instance.exitCode === 0 && instance.signal === null));
    return frozen({
      schemaVersion: "root-broker.execution-proof.v2",
      binding: { rootSessionId: run.rootSessionId, runId: run.runId, asyncDir: run.asyncDir, sessionId: run.sessionId, pid: run.pid, agentProfile: run.agentProfile },
      authorization: { state: authorized ? "verified" : "unavailable" },
      capabilities: [...run.capabilities].sort(),
      terminal: proof ? { proofId: proofId(proof), observedAt: proof.observedAt, outcome: successful ? "succeeded" : "failed", proof } : null,
      terminalConflict: this.terminalConflicts.has(run.runId),
    });
  }

  inspectExecutionProof(runId: string) {
    const run = this.ownedRuns.get(runId);
    return run ? this.executorProofSnapshot(run) : null;
  }

  async inspectExecutionProofForSettlement(runId: string) {
    const run = this.ownedRuns.get(runId);
    if (!run) return null; // facade registration is never settlement authority.
    if (run.identityState === "verified" && run.authorization.goal && !this.terminalProofs.has(runId) && !this.terminalConflicts.has(runId)) {
      try { this.readAndAcceptOfficialTerminalArtifact(run); } catch { /* unsafe/malformed/foreign/pending sidecars fail closed */ }
    }
    return this.executorProofSnapshot(run);
  }

  // Compatibility alias retained while the Goal settlement extension imports it.
  async inspectExecutorProofAsync(runId: string) {
    return this.inspectExecutionProofForSettlement(runId);
  }

  async pollTerminalArtifact(run: OwnedRun, cancelled: () => boolean, setCancelSleep: (cancel: () => void) => void) {
    while (!cancelled()) {
      try {
        const proof = this.readAndAcceptOfficialTerminalArtifact(run);
        if (cancelled()) return undefined;
        if (proof) return proof;
      } catch (error: any) {
        if (error?.code !== "ENOENT") {
          if (error instanceof Error && /official terminal/.test(error.message)) throw error;
          throw new Error(`invalid official terminal: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.artifactPollIntervalMs);
        setCancelSleep(() => { clearTimeout(timer); resolve(); });
      });
    }
    return undefined;
  }

  waitForTerminal(runId: string): { promise: Promise<any>; cancel: () => void } {
    const proof = this.terminalProofs.get(runId);
    if (proof) return { promise: Promise.resolve(proof), cancel: () => {} };
    let resolveWaiter!: (proof: any) => void;
    const promise = new Promise<any>((resolve) => {
      resolveWaiter = resolve;
      const waiters = this.terminalWaiters.get(runId) ?? new Set();
      waiters.add(resolveWaiter);
      this.terminalWaiters.set(runId, waiters);
    });
    return {
      promise,
      cancel: () => {
        const waiters = this.terminalWaiters.get(runId);
        if (!waiters) return;
        waiters.delete(resolveWaiter);
        if (waiters.size === 0) this.terminalWaiters.delete(runId);
      },
    };
  }

  async observeOfficialProof(run: OwnedRun, deadlineMessage: string) {
    const waiter = this.waitForTerminal(run.runId);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    let cancelSleep: (() => void) | undefined;
    try {
      if (this.terminalProofs.has(run.runId)) return;
      const deadline = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new TerminalDeadlineError(deadlineMessage)), this.terminalTimeoutMs); });
      const artifact = this.pollTerminalArtifact(run, () => cancelled, (cancel) => { cancelSleep = cancel; });
      void artifact.catch(() => undefined);
      const proof = await Promise.race([waiter.promise, artifact, deadline]);
      if (!proof) throw new TerminalDeadlineError(deadlineMessage);
    } finally {
      cancelled = true;
      cancelSleep?.();
      if (timeout) clearTimeout(timeout);
      waiter.cancel();
    }
  }

  async verifyForcedDeath(run: OwnedRun) {
    let identity: string;
    try {
      identity = await this.captureProcessBirthIdentity(run.pid);
    } catch (error: any) {
      if (error?.code === "PROCESS_BIRTH_IDENTITY_UNAVAILABLE") {
        this.forcePendingRuns.delete(run.runId);
        return;
      }
      throw new Error(`force death verification unavailable for run ${run.runId}: ${String(error?.message ?? error).slice(0, 512)}`);
    }
    if (identity === run.birthIdentity) throw new Error(`forced run ${run.runId} is still alive with birth identity`);
    throw new Error(`forced run ${run.runId} birth identity reused or mismatch`);
  }

  async forceCleanup(run: OwnedRun, deadlineError: Error) {
    if (run.identityState !== "verified" || !run.birthIdentity || !Number.isSafeInteger(run.pid) || run.pid <= 0) {
      throw new Error(`force cleanup identity unavailable for run ${run.runId}: ${deadlineError.message}`);
    }
    let recaptured: string;
    try {
      recaptured = await this.captureProcessBirthIdentity(run.pid);
    } catch (error: any) {
      if (error?.code === "PROCESS_BIRTH_IDENTITY_UNAVAILABLE") throw new Error(`force cleanup recapture identity unavailable for run ${run.runId}: ${deadlineError.message}`);
      throw new Error(`force cleanup recapture failed for run ${run.runId}: ${String(error?.message ?? error).slice(0, 512)}`);
    }
    if (recaptured !== run.birthIdentity) throw new Error(`force cleanup stale birth identity mismatch for run ${run.runId}`);
    if (this.terminalProofs.has(run.runId)) return;

    const waiter = this.waitForTerminal(run.runId);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    let cancelSleep: (() => void) | undefined;
    let shouldVerifyDeath = false;
    try {
      const deadline = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new TerminalDeadlineError(`force missing official proof for run ${run.runId}`)), this.terminalTimeoutMs); });
      if (this.terminalProofs.has(run.runId)) return;
      try { this.killProcess(-run.pid, "SIGKILL"); } catch (error: any) {
        throw new Error(`force cleanup signal failed for run ${run.runId}: ${String(error?.message ?? error).slice(0, 512)}; ${deadlineError.message}`);
      }
      this.forcePendingRuns.add(run.runId);
      if (!this.terminalProofs.has(run.runId)) {
        const artifact = this.pollTerminalArtifact(run, () => cancelled, (cancel) => { cancelSleep = cancel; });
        void artifact.catch(() => undefined);
        await Promise.race([waiter.promise, artifact, deadline]);
      }
      if (!this.terminalProofs.has(run.runId)) throw new TerminalDeadlineError(`force missing official proof for run ${run.runId}`);
      shouldVerifyDeath = true;
    } finally {
      cancelled = true;
      cancelSleep?.();
      if (timeout) clearTimeout(timeout);
      waiter.cancel();
    }
    if (shouldVerifyDeath) await this.verifyForcedDeath(run);
  }

  async drainRun(run: OwnedRun) {
    if (this.forcePendingRuns.has(run.runId)) {
      if (!this.terminalProofs.has(run.runId)) await this.observeOfficialProof(run, `force missing official proof for run ${run.runId}`);
      return this.verifyForcedDeath(run);
    }
    if (this.terminalProofs.has(run.runId)) return;
    const waiter = this.waitForTerminal(run.runId);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    let cancelSleep: (() => void) | undefined;
    let deadlineError: TerminalDeadlineError | undefined;
    try {
      let stopFailed = false;
      let stopError: Error | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new TerminalDeadlineError(`missing official proof for run ${run.runId}${stopFailed ? ` after stop failure: ${stopError?.message}` : ""}`)), this.terminalTimeoutMs);
      });
      let stopPromise: Promise<any>;
      try { stopPromise = Promise.resolve(this.upstream.stop({ runId: run.runId, dir: run.asyncDir })); } catch (error) { stopPromise = Promise.reject(error); }
      void stopPromise.catch((error) => { stopFailed = true; stopError = error instanceof Error ? error : new Error(String(error)); });
      if (this.terminalProofs.has(run.runId)) return;
      const artifact = this.pollTerminalArtifact(run, () => cancelled, (cancel) => { cancelSleep = cancel; });
      void artifact.catch(() => undefined);
      const proof = await Promise.race([waiter.promise, artifact, deadline]);
      if (!proof) throw new TerminalDeadlineError(`missing official proof for run ${run.runId}`);
    } catch (error) {
      if (error instanceof TerminalDeadlineError) deadlineError = error;
      else throw error;
    } finally {
      cancelled = true;
      cancelSleep?.();
      if (timeout) clearTimeout(timeout);
      waiter.cancel();
    }
    if (deadlineError) await this.forceCleanup(run, deadlineError);
  }

  async ensureAuthorizedPrincipal(runId: string) {
    if (this.closed) throw new Error("Root subagent broker is closing");
    const existing = this.authorizationGrants.get(runId);
    if (existing) return existing;
    const pending = (async () => {
      const principal = this.principals.get(runId);
      if (principal) return { callerToken: principal.callerToken };
      const callerToken = this.randomToken();
      const run = this.ownedRuns.get(runId);
      if (!run || run.capabilities.size === 0) throw new Error("Run authorization has no broker capabilities");
      this.principals.set(runId, { callerToken, capabilities: run.capabilities });
      try {
        const grantPath = await this.writeGrant({ schemaVersion: "pi-root-subagent-broker-grant.v2", rootSessionId: this.rootSessionId, runId, callerToken, capabilities: [...run.capabilities].sort() });
        this.grantPaths.add(grantPath);
        if (this.closed) {
          this.principals.delete(runId);
          throw new Error("Root subagent broker is closing");
        }
        return { callerToken };
      } catch (error) {
        this.principals.delete(runId);
        throw error;
      }
    })();
    this.authorizationGrants.set(runId, pending);
    void pending.finally(() => {
      if (this.authorizationGrants.get(runId) === pending) this.authorizationGrants.delete(runId);
    }).catch(() => undefined);
    return await pending;
  }

  async submitAcceptanceEvidence(request: any) {
    const run = this.ownedRuns.get(request.callerRunId);
    if (!run || !run.capabilities.has("acceptance.submit") || !run.authorization.goal || run.identityState !== "verified") {
      throw brokerError("ACCEPTANCE_UNAUTHORIZED", "Acceptance evidence requires a verified authorized Goal run");
    }
    const sidecarPath = path.join(run.asyncDir, GOAL_BINDING_SIDECAR);
    let authority: GoalBindingSidecar;
    try {
      const before = lstatSync(sidecarPath);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600) {
        throw brokerError("ACCEPTANCE_AUTHORITY_INVALID", "Goal acceptance authority is unsafe");
      }
      const fd = openSync(sidecarPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      let bytes: Buffer;
      let opened;
      try { opened = fstatSync(fd); bytes = readFileSync(fd); } finally { closeSync(fd); }
      const after = lstatSync(sidecarPath);
      if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1 || (after.mode & 0o777) !== 0o600
        || before.dev !== opened.dev || before.ino !== opened.ino || after.dev !== opened.dev || after.ino !== opened.ino
        || opened.size !== bytes.length) throw brokerError("ACCEPTANCE_AUTHORITY_INVALID", "Goal acceptance authority changed while reading");
      authority = JSON.parse(bytes.toString("utf8"));
    } catch (error: any) {
      if (error?.code === "ENOENT") throw brokerError("CONTEXT_NOT_READY", "Goal acceptance authority is not ready");
      if (error?.code) throw error;
      throw brokerError("ACCEPTANCE_AUTHORITY_INVALID", "Goal acceptance authority is invalid");
    }
    if (!exactKeys(authority, [...goalOwnedAuthorityKeys, "version", "ticketId"])
      || !validGoalOwnedAuthority(authorityFields(authority))
      || authority.version !== "root-broker.goal-run-binding-authority.v2"
      || !/^[a-f0-9]{64}$/.test(authority.ticketId)
      || authority.runId !== run.runId || authority.asyncDir !== run.asyncDir || authority.agentProfile !== run.agentProfile
      || authority.sessionId !== run.sessionId || authority.sessionId !== this.lifecycleSessionId
      || authority.ticketId !== run.authorization.goal.ticketId
      || authority.goalId !== run.authorization.goal.goalId
      || authority.taskId !== run.authorization.goal.taskId
      || authority.attempt !== run.authorization.goal.attempt
      || authority.contractHash !== run.authorization.goal.contractHash
      || authority.executionRevision !== run.authorization.goal.executionRevision
      || JSON.stringify(authority.expectedCriteria) !== JSON.stringify(run.authorization.goal.expectedCriteria)) {
      throw brokerError("ACCEPTANCE_AUTHORITY_INVALID", "Goal acceptance authority does not match the executor run");
    }
    let head: string;
    try {
      const result = await execFile("git", ["rev-parse", "HEAD"], { cwd: authority.workspacePath, encoding: "utf8" });
      head = result.stdout.trim();
      if (!/^[a-f0-9]{40}$/.test(head)) throw new Error("invalid Git HEAD");
    } catch {
      throw brokerError("ACCEPTANCE_WORKSPACE_INVALID", "Executor workspace HEAD is unavailable");
    }
    const { outcome, ...payload } = request.params;
    const evidenceDirectory = path.join(authority.asyncDir, "acceptance-evidence");
    mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
    const evidenceDirectoryStat = lstatSync(evidenceDirectory);
    if (!evidenceDirectoryStat.isDirectory() || evidenceDirectoryStat.isSymbolicLink()) {
      throw brokerError("ACCEPTANCE_AUTHORITY_INVALID", "Goal acceptance evidence directory is unsafe");
    }
    return await materializeSettlementEvidence({
      identity: {
        goalId: authority.goalId,
        taskId: authority.taskId,
        runId: authority.runId,
        attempt: authority.attempt,
        contractHash: authority.contractHash,
        head,
      },
      ...payload,
    }, {
      directory: evidenceDirectory,
      expectedIdentity: {
        goalId: authority.goalId,
        taskId: authority.taskId,
        runId: authority.runId,
        attempt: authority.attempt,
        contractHash: authority.contractHash,
        head,
      },
      expectedCriteria: authority.expectedCriteria,
      outcome,
    });
  }

  handleSocket(socket: Socket) {
    this.sockets.add(socket);
    this.requestBoundaries.add(socket);
    socket.once("close", () => {
      this.sockets.delete(socket);
      this.requestBoundaries.delete(socket);
    });
    let buffer = "";
    let handled = false;
    socket.on("data", (chunk) => {
      if (handled) return;
      buffer += chunk.toString();
      if (buffer.length > MAX_BUFFER) return socket.destroy();
      const lineEnd = buffer.indexOf("\n");
      if (lineEnd < 0) return;
      handled = true;
      // The request boundary is now owned by respond(). Close must not tear
      // down this socket in the interval between receiving bytes and parsing
      // the first complete frame.
      this.requestBoundaries.delete(socket);
      void this.respond(socket, buffer.slice(0, lineEnd));
    });
    socket.on("error", () => {});
  }

  async respond(socket: Socket, line: string) {
    let request: any;
    try { request = parseBrokerRequest(JSON.parse(line)); } catch { socket.destroy(); return; }
    // A child integration request is tracked from receipt until its response is
    // delivered, so Root close never tears down the transport mid-request.
    const integration = request.method === "coordinator.request"
      ? this.beginIntegrationRequest(request.callerRunId, request.params.operation)
      : undefined;
    const finishIntegration = () => integration?.end();
    try {
      const response = await this.dispatch(request, socket, { deferSubscription: request.method === "subscribe" });
      if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`, (error) => {
        finishIntegration();
        if (error) return socket.destroy();
        if (request.method === "subscribe") {
          if (response.success) this.activateSubscription(request, socket);
          else socket.end();
        } else socket.end();
      });
      else finishIntegration();
    } catch (error) {
      finishIntegration();
      try { if (!socket.destroyed) socket.end(`${JSON.stringify(failure(request, "broker_failed", error instanceof Error ? error.message : String(error)))}\n`); } catch { socket.destroy(); }
    }
  }

  /**
   * Registers an in-flight child integration request. `end` resolves the settle
   * promise only once the response has been delivered, so Root close waits for
   * the child to actually receive the result rather than racing the write.
   */
  beginIntegrationRequest(callerRunId: string, operation: string) {
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    const entry = { operation, settled };
    const set = this.integrationRequests.get(callerRunId) ?? new Set<{ operation: string; settled: Promise<void> }>();
    this.integrationRequests.set(callerRunId, set);
    set.add(entry);
    let ended = false;
    return {
      settled,
      end: () => {
        if (ended) return;
        ended = true;
        resolveSettled();
        set.delete(entry);
        if (set.size === 0) this.integrationRequests.delete(callerRunId);
      },
    };
  }

  /**
   * Bounded wait for every owned child integration request to settle. A request
   * that cannot settle within `integrationTimeoutMs` becomes observable debt
   * instead of an unbounded hang; the broker then proceeds to drain.
   */
  async awaitIntegrationRequests() {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"deadline">((resolve) => { timeout = setTimeout(() => resolve("deadline"), this.integrationTimeoutMs); });
    try {
      for (;;) {
        const entries = [...this.integrationRequests.values()].flatMap((set) => [...set]);
        const boundaries = [...this.requestBoundaries];
        if (entries.length === 0 && boundaries.length === 0) return;
        // Do not spin a promise per microtask while a partial socket frame is
        // waiting for its newline. The socket close/data handlers change the
        // set; a short bounded timer observes that state without allocating an
        // unbounded chain of async-hook records.
        const boundariesSettled = boundaries.length === 0
          ? Promise.resolve("settled" as const)
          : new Promise<"settled">((resolve) => {
            const timer = setInterval(() => {
              if (this.requestBoundaries.size === 0) { clearInterval(timer); resolve("settled"); }
            }, 5);
            timer.unref();
          });
        // Await the accepted integration frames once, then independently
        // await parser boundaries. Rebuilding allSettled in a loop can create
        // an unbounded async-hook graph when a client remains connected.
        const integrationsSettled = entries.length === 0
          ? Promise.resolve("settled" as const)
          : Promise.allSettled(entries.map((entry) => entry.settled)).then(() => "settled" as const);
        const outcome = await Promise.race([
          Promise.all([integrationsSettled, boundariesSettled]).then(() => "settled" as const),
          deadline,
        ]);
        if (outcome === "deadline") {
          for (const [runId, set] of this.integrationRequests) {
            for (const entry of set) {
              this.integrationDebt.set(runId, frozen({ operation: entry.operation, reason: "child integration request did not settle before the Root close deadline" }));
            }
          }
          if (this.requestBoundaries.size > 0) this.requestBoundaryDebt += this.requestBoundaries.size;
          return;
        }
      }
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  /** Read-only observability of in-flight integration requests and close debt. */
  inspectIntegrationRequests(runId: string) {
    const entries = this.integrationRequests.get(runId);
    const inflight = entries ? [...entries].map((entry) => entry.operation).sort() : [];
    const debt = this.integrationDebt.get(runId) ?? null;
    return frozen({ runId, inflight, debt, pendingRequestBoundary: this.requestBoundaries.size, requestBoundaryDebt: this.requestBoundaryDebt });
  }

  publishRecoveryEvent(event: any) {
    const safe = frozen({ schemaVersion: "recovery-event.v1", rootSessionId: this.rootSessionId,
      recoveryIntentId: event?.recoveryIntentId, queueItemId: event?.queueItemId, workspaceId: event?.workspaceId,
      ownerScope: event?.ownerScope, runId: event?.runId, attempt: event?.attempt, reason: event?.reason, requiredAction: event?.requiredAction,
      generation: event?.generation, handoff: event?.handoff, delivery: { state: "delivered" } });
    this.recoveryNotifications.push(safe);
    const callerRunId = typeof event?.runId === "string" ? event.runId : undefined;
    if (callerRunId) this.notifyExecutionFacts(callerRunId);
    const sockets = callerRunId ? this.subscriptions.get(callerRunId) : undefined;
    if (!sockets || sockets.size === 0) {
      this.recoveryNotificationDebt.push({ ...safe, delivery: { state: "debt", reason: "root-not-subscribed" } });
      return { state: "debt", reason: "root-not-subscribed" };
    }
    for (const socket of sockets) { if (!socket.destroyed) { try { socket.write(`${JSON.stringify({ schemaVersion: "pi-root-subagent-broker-push.v1", rootSessionId: this.rootSessionId, callerRunId, type: "recovery.event", data: safe })}\n`); } catch {} } }
    return { state: "delivered" };
  }

  replayRecoveryNotifications(callerRunId: string) {
    const pending = this.recoveryNotificationDebt.filter((event) => event.runId === callerRunId);
    for (const event of pending) this.publishRecoveryEvent({ ...event, runId: callerRunId });
    this.recoveryNotificationDebt = this.recoveryNotificationDebt.filter((event) => event.runId !== callerRunId);
    return pending.length;
  }

  registerSubscription(callerRunId: string, socket: Socket) {
    const subscribers = this.subscriptions.get(callerRunId) ?? new Set<Socket>();
    subscribers.add(socket);
    this.subscriptions.set(callerRunId, subscribers);
    socket.once("close", () => {
      subscribers.delete(socket);
      if (subscribers.size === 0) this.subscriptions.delete(callerRunId);
    });
  }

  activateSubscription(request: any, socket: Socket) {
    if (this.closed || socket.destroyed) return;
    const principal = this.revokedRuns.has(request.callerRunId) ? undefined : this.principals.get(request.callerRunId);
    if (!principal || principal.callerToken !== request.callerToken) return;
    this.registerSubscription(request.callerRunId, socket);
    this.replayRecoveryNotifications(request.callerRunId);
    if (this.closed || socket.destroyed || this.principals.get(request.callerRunId)?.callerToken !== request.callerToken) return;
    try {
      socket.write(`${JSON.stringify({ schemaVersion: "pi-root-subagent-broker-push.v1", rootSessionId: this.rootSessionId, callerRunId: request.callerRunId, type: "subscription.ready", data: {} })}\n`);
      if (this.authorityStore) void this.authorityStore.readLease(request.callerRunId).then((lease) => this.publishLeaseUpdate(request.callerRunId, lease)).catch((error) => {
        try { this.diagnosticSink?.({ version: 1, phase: "root-broker-lease-read-failed", error, cause: error?.cause, callerRunId: request.callerRunId }); } catch (diagnosticError) { console.error("[root-broker] diagnostic sink failed", { error, diagnosticError }); }
      });
    } catch (error) {
      try { this.diagnosticSink?.({ version: 1, phase: "root-broker-subscription-ready-write-failed", error, cause: error?.cause, callerRunId: request.callerRunId }); } catch (diagnosticError) { console.error("[root-broker] diagnostic sink failed", { error, diagnosticError }); }
    }
  }

  async dispatch(request: any, socket: Socket, { deferSubscription = false }: { deferSubscription?: boolean } = {}) {
    if (this.closed) return failure(request, "root_closing", "Root session is closing");
    if (request.rootSessionId !== this.rootSessionId) return failure(request, "root_mismatch", "Root session does not match");
    if (request.method === "coordinator.register") {
      if (this.coordinatorChallengeNonces.has(request.params.nonce)) return failure(request, "nonce_replay", "Coordinator challenge nonce was already consumed");
      this.coordinatorChallengeNonces.add(request.params.nonce);
      let processIdentity: string;
      try { processIdentity = await this.captureProcessBirthIdentity(process.pid); }
      catch { return failure(request, "process_identity_unavailable", "Root Broker process identity is unavailable"); }
      if (!/^[a-f0-9]{64}$/.test(processIdentity)) return failure(request, "process_identity_unavailable", "Root Broker process identity is unavailable");
      return createBrokerSuccessResponse({ ...request, data: {
        nonce: request.params.nonce,
        rootSessionId: this.rootSessionId,
        brokerPid: process.pid,
        brokerProcessIdentity: processIdentity,
        repositoryId: request.params.repositoryId,
        coordinatorInstanceId: request.params.coordinatorInstanceId,
      } });
    }
    const principal = this.revokedRuns.has(request.callerRunId) ? undefined : this.principals.get(request.callerRunId);
    if (!principal || principal.callerToken !== request.callerToken) return failure(request, "caller_unauthorized", "Caller is not granted");
    try {
      if (request.method === "subscribe") {
        if (!principal.capabilities.has("root.subscribe")) return failure(request, "capability_denied", "Caller lacks root.subscribe capability");
        if (!deferSubscription) this.registerSubscription(request.callerRunId, socket);
        return createBrokerSuccessResponse({ ...request, data: { subscribed: true } });
      }
      if (request.method === "ping") return createBrokerSuccessResponse({ ...request, data: await this.upstream.ping() });
      if (request.method === "owner.read") {
        if (request.callerRunId !== request.params.runId) return failure(request, "caller_unauthorized", "Caller does not own this run");
        return createBrokerSuccessResponse({ ...request, data: await this.readOwnerReceipt(request.params.runId) });
      }
      if (request.method === "owner.rebind") {
        if (request.callerRunId !== request.params.sourceRunId) return failure(request, "caller_unauthorized", "Caller does not own the source run");
        return createBrokerSuccessResponse({ ...request, data: await this.rebindRun(request.params) });
      }
      if (request.method === "owner.revoke") {
        if (request.callerRunId !== request.params.runId) return failure(request, "caller_unauthorized", "Caller does not own this run");
        await this.revokeOwner(request.params);
        return createBrokerSuccessResponse({ ...request, data: { revoked: true } });
      }
      if (request.method === "acceptance.submit") {
        if (!principal.capabilities.has("acceptance.submit")) return failure(request, "capability_denied", "Caller lacks acceptance.submit capability");
        return createBrokerSuccessResponse({ ...request, data: await this.submitAcceptanceEvidence(request) });
      }
      if (request.method === "coordinator.request") {
        if (!this.coordinatorRequest) {
          if (request.params.operation === "inspect_integration_state" || request.params.operation === "preserve_integration_debt") {
            this.integrationDebt.set(request.callerRunId, frozen({ operation: request.params.operation, reason: "repository coordinator is unavailable during integration completion settlement" }));
          }
          return failure(request, "coordinator_unavailable", "Repository coordinator is unavailable");
        }
        if (!COORDINATOR_OPERATIONS.includes(request.params.operation)) return failure(request, "unsupported_coordinator_operation", "Coordinator operation is unsupported");
        try {
          return createBrokerSuccessResponse({ ...request, data: await this.coordinatorRequest(request.callerRunId, request.params.operation, request.params.input) });
        } finally {
          this.notifyExecutionFacts(request.callerRunId);
        }
      }
      return failure(request, "unsupported", `Broker method ${request.method} is unsupported`);
    } catch (error) {
      return failure(request, typeof (error as any)?.code === "string" ? (error as any).code : "upstream_failed", error instanceof Error ? error.message : String(error));
    }
  }

  announceClosing() {
    for (const [callerRunId, sockets] of this.subscriptions) {
      const push = { schemaVersion: "pi-root-subagent-broker-push.v1", rootSessionId: this.rootSessionId, callerRunId, type: "root.closing", data: {} };
      for (const socket of sockets) {
        if (this.closingSockets.has(socket)) continue;
        this.closingSockets.add(socket);
        if (!socket.destroyed) socket.write(`${JSON.stringify(push)}\n`);
      }
    }
  }

  async closeRootSession() {
    if (this.closePromise) return this.closePromise;
    if (this.teardown.released) return;
    this.closed = true;
    const closing = (async () => {
      let startupTimeout: ReturnType<typeof setTimeout> | undefined;
      const startupDeadline = new Promise<never>((_, reject) => {
        startupTimeout = setTimeout(() => reject(new AggregateError([], "Root subagent broker startup barrier deadline exceeded")), this.terminalTimeoutMs);
      });
      try {
        for (;;) {
          const barrier = [...this.startedObservations.values(), ...this.authorizationGrants.values()];
          if (barrier.length === 0) break;
          await Promise.race([Promise.allSettled(barrier), startupDeadline]);
          await Promise.resolve();
        }
      } finally {
        if (startupTimeout) clearTimeout(startupTimeout);
      }

      // An owned child's in-flight integration request must settle (or become
      // observable debt) before the broker drains runs and tears down its
      // transport; otherwise the child observes BROKER_DISCONNECTED for work the
      // Root asked it to perform.
      await this.awaitIntegrationRequests();

      const runs = [...this.ownedRuns.values()].filter((run) => this.forcePendingRuns.has(run.runId) || !this.terminalProofs.has(run.runId));
      const settled = await Promise.allSettled(runs.map((run) => this.drainRun(run)));
      const errors = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason);
      if (errors.length) throw new AggregateError(errors, "Root subagent broker executor drain failed");

      // An accepted official terminal must reach the durable proof sink before
      // the broker transport disappears; otherwise the proof is lost.
      await this.awaitTerminalProofDeliveries();

      if (!this.teardown.grants) {
        for (const grantPath of this.grantPaths) {
          if (this.cleanedGrantPaths.has(grantPath)) continue;
          try { await rm(grantPath, { force: true }); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
          this.cleanedGrantPaths.add(grantPath);
        }
        this.teardown.grants = true;
      }

      if (!this.teardown.transport) {
        this.announceClosing();
        for (const socket of this.sockets) this.transportSockets.add(socket);
        for (const sockets of this.subscriptions.values()) for (const socket of sockets) this.transportSockets.add(socket);
        for (const socket of this.transportSockets) {
          if (this.endedSockets.has(socket)) continue;
          this.endedSockets.add(socket);
          if (!socket.destroyed) socket.end();
        }
        const destroyTimer = setTimeout(() => {
          for (const socket of this.transportSockets) if (!socket.destroyed) socket.destroy();
        }, 25);
        try {
          await new Promise<void>((resolve, reject) => {
            const server = this.server;
            if (!server) return resolve();
            let done = false;
            const finish = (callback: (value?: any) => void, value?: any) => {
              if (done) return;
              done = true;
              server.off("error", fail);
              callback(value);
            };
            const fail = (error: Error) => finish(reject, error);
            server.once("error", fail);
            try { server.close(() => finish(resolve)); } catch (error) { finish(reject, error); }
          });
        } finally {
          clearTimeout(destroyTimer);
        }
        await rm(brokerSocketPath(this.rootSessionId), { force: true });
        this.teardown.transport = true;
      }

      if (!this.teardown.upstream) {
        await this.upstream.dispose?.();
        this.teardown.upstream = true;
      }
      this.unsubscribeStarted?.();
      this.unsubscribeStarted = undefined;
      this.unsubscribeTerminal?.();
      this.unsubscribeTerminal = undefined;
      if (this.heartbeatTimer) this.clearHeartbeatInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
      this.principals.clear();
      this.revokedRuns.clear();
      this.subscriptions.clear();
      this.sockets.clear();
      this.grantPaths.clear();
      this.authorizationGrants.clear();
      this.ownedRuns.clear();
      this.goalAuthorities.clear();
      this.terminalProofs.clear();
      this.terminalConflicts.clear();
      this.forcePendingRuns.clear();
      this.terminalWaiters.clear();
      this.terminalProofDelivery.clear();
      this.terminalProofDeliveries.clear();
      this.leaseReleasePromises.clear();
      this.leaseReleaseDebt.clear();
      this.startedObservations.clear();
      this.integrationRequests.clear();
      this.requestBoundaries.clear();
      this.requestBoundaryDebt = 0;
      this.transportSockets.clear();
      this.closingSockets.clear();
      this.endedSockets.clear();
      this.cleanedGrantPaths.clear();
      this.server = undefined;
      this.teardown.released = true;
    })();
    this.closePromise = closing;
    try {
      await closing;
    } catch (error) {
      if (this.closePromise === closing) this.closePromise = undefined;
      throw error;
    }
    return closing;
  }
}
