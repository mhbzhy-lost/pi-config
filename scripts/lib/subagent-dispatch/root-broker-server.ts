import { createHash, randomBytes } from "node:crypto";
import { createServer, Socket } from "node:net";
import { readFile as nodeReadFile, rm } from "node:fs/promises";
import path from "node:path";

import { captureProcessBirthIdentity } from "./process-birth-identity.ts";

import {
  brokerSocketPath,
  createBrokerFailureResponse,
  createBrokerSuccessResponse,
  ensureBrokerSocketDirectory,
  parseBrokerRequest,
  parseBrokerPush,
  parseProcessTerminal,
  createSupervisorRequestPush,
  setBrokerSocketPermissions,
  writeBrokerGrant,
} from "./root-broker-protocol.ts";
import type { BrokerPush } from "./root-broker-protocol.ts";

type Upstream = Record<string, (...args: any[]) => Promise<any>> & { dispose?: () => void | Promise<void> };
type Caller = { planId: string; cwd: string; originRoot: string; stateRoot: string; role: "plan-runner"; callerToken: string; ownedRunIds: Set<string> };
type Principal = { role: "plan-runner" | "executor"; callerToken: string };
type LogicalCaller = { activeRunId: string; generation: number };
type FollowUpIntent = { wakeId: string; reason: "plan-opened" | "attention-reply" };
type Dependencies = { writeGrant?: typeof writeBrokerGrant; randomToken?: () => string; captureProcessBirthIdentity?: typeof captureProcessBirthIdentity; killProcess?: (pid: number, signal: "SIGKILL") => void; events?: { on(channel: string, listener: (event: any) => void | Promise<void>): () => void }; terminalTimeoutMs?: number; readFile?: typeof nodeReadFile; artifactPollIntervalMs?: number; recordRevivalDiagnostic?: (customType: "pi-root-broker-revival-v1", data: Record<string, unknown>) => unknown; lifecycleSessionId?: string };
type SpawnLedgerEntry = { hash: string; state: "not-started" | "spawning" | "spawned" | "cleaned" | "uncertain"; spawnKey?: string; callerRunId?: string; params?: Record<string, unknown>; promise?: Promise<any>; reply?: any; binding?: any; started?: any; pending: any[]; queued?: Set<string>; delivered: Set<string> };
type QueuedCallerPush = { push: BrokerPush; onDelivered?: () => void };
type SupervisorRequest = { requestId: string; ownerRunId: string; executorRunId: string; data: Record<string, unknown>; context: any; expectsReply: boolean; state: "pending" | "replying" | "consumed" };
type OwnedRun = { rootSessionId: string; runId: string; role: "plan-runner" | "executor"; asyncDir: string; sessionId: string; pid: number; birthIdentity: string | null; identityState: "verified" | "unavailable" | "conflict" };
type StartedFacts = Pick<OwnedRun, "runId" | "role" | "asyncDir" | "sessionId" | "pid">;

const FORBIDDEN_SPAWN_FIELDS = new Set(["caller", "root", "token", "parent", "depth", "path", "fanout", "callerRunId", "callerToken", "rootSessionId", "parentRunId", "parentDepth", "parentPath"]);
const MAX_BUFFER = 64 * 1024;

class TerminalDeadlineError extends Error {
  code = "ROOT_TERMINAL_DEADLINE";
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizedSpawn(params: Record<string, unknown>) {
  const { spawnKey: _spawnKey, ...rest } = params;
  return { ...rest, async: true, clarify: false };
}

function failure(request: any, code: string, message: string) {
  return createBrokerFailureResponse({ requestId: request?.requestId ?? "invalid-request", rootSessionId: request?.rootSessionId ?? "invalid-root", callerRunId: request?.callerRunId ?? "invalid-caller", code, message: String(message).slice(0, 1024) || "Broker request failed" });
}

function replay(request: any, response: any) {
  return response.success
    ? createBrokerSuccessResponse({ ...request, data: response.data })
    : failure(request, response.error.code, response.error.message);
}

export class RootBrokerServer {
  rootSessionId: string;
  lifecycleSessionId: string;
  upstream: Upstream;
  callers = new Map<string, Caller>();
  logicalCallers = new Map<string, LogicalCaller>();
  callerAliases = new Map<string, string>();
  callerFollowUps = new Map<string, FollowUpIntent[]>();
  callerPushQueues = new Map<string, QueuedCallerPush[]>();
  principals = new Map<string, Principal>();
  runOwners = new Map<string, string>();
  subscriptions = new Map<string, Set<Socket>>();
  sockets = new Set<Socket>();
  grantPaths = new Set<string>();
  executorGrants = new Map<string, Promise<{ callerToken: string }>>();
  callerGrants = new Map<string, Promise<{ callerToken: string }>>();
  spawnLedger = new Map<string, SpawnLedgerEntry>();
  supervisorRequests = new Map<string, SupervisorRequest>();
  ownedRuns = new Map<string, OwnedRun>();
  terminalProofs = new Map<string, any>();
  reviveResults = new Map<string, any>();
  revivePromises = new Map<string, Promise<any>>();
  forcePendingRuns = new Set<string>();
  terminalWaiters = new Map<string, Set<(proof: any) => void>>();
  startedObservations = new Map<string, Promise<void>>();
  unsubscribeStarted: (() => void) | undefined;
  unsubscribeComplete: (() => void) | undefined;
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
  readFile: typeof nodeReadFile;
  artifactPollIntervalMs: number;
  recordRevivalDiagnostic: Dependencies["recordRevivalDiagnostic"];

  constructor({ rootSessionId, lifecycleSessionId = rootSessionId, upstream, writeGrant = writeBrokerGrant, randomToken = () => randomBytes(32).toString("hex"), captureProcessBirthIdentity: captureBirthIdentity = captureProcessBirthIdentity, killProcess = process.kill, events, terminalTimeoutMs = 5_000, readFile = nodeReadFile, artifactPollIntervalMs = 50, recordRevivalDiagnostic }: { rootSessionId: string; upstream: Upstream } & Dependencies) {
    if (!Number.isSafeInteger(terminalTimeoutMs) || terminalTimeoutMs <= 0) throw new Error("Root subagent broker terminal timeout must be a positive safe integer");
    if (!Number.isSafeInteger(artifactPollIntervalMs) || artifactPollIntervalMs <= 0) throw new Error("Root subagent broker artifact poll interval must be a positive safe integer");
    this.rootSessionId = rootSessionId;
    this.lifecycleSessionId = lifecycleSessionId;
    this.upstream = upstream;
    this.writeGrant = writeGrant;
    this.randomToken = randomToken;
    this.captureProcessBirthIdentity = captureBirthIdentity;
    this.killProcess = killProcess;
    this.events = events;
    this.terminalTimeoutMs = terminalTimeoutMs;
    this.readFile = readFile;
    this.artifactPollIntervalMs = artifactPollIntervalMs;
    this.recordRevivalDiagnostic = recordRevivalDiagnostic;
  }

  recordDiagnostic(phase: string, logicalCallerRunId?: string, wakeId?: string, extra: Record<string, unknown> = {}) {
    const logical = logicalCallerRunId ? this.logicalCallers.get(logicalCallerRunId) : undefined;
    const data: Record<string, unknown> = { schemaVersion: "pi-root-broker-revival-diagnostic.v1", rootSessionId: this.rootSessionId, phase, observedAt: Date.now() };
    if (logicalCallerRunId) data.logicalCallerRunId = logicalCallerRunId;
    if (logical) { data.activeRunId = logical.activeRunId; data.generation = logical.generation; }
    if (wakeId) data.wakeId = wakeId;
    Object.assign(data, extra);
    try {
      const result = this.recordRevivalDiagnostic?.("pi-root-broker-revival-v1", data);
      if (result && typeof (result as Promise<unknown>).then === "function") void Promise.resolve(result).catch(() => undefined);
    } catch { /* diagnostics must not affect broker behavior */ }
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
      await setBrokerSocketPermissions(socketPath);
      this.unsubscribeStarted = this.events?.on("subagent:async-started", (event) => this.observeStarted(event));
      this.unsubscribeComplete = this.events?.on("subagent:async-complete", (event) => this.lifecycle(event, "execution.completed"));
      this.unsubscribeTerminal = this.events?.on("subagent:process-terminal", (event) => { this.observeTerminal(event); this.lifecycle(event, "execution.completed"); });
    } catch (error) {
      this.server = undefined;
      await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
      await rm(socketPath, { force: true });
      throw error;
    }
  }

  startedFacts(event: any): StartedFacts | undefined {
    const runId = event?.runId ?? event?.id;
    if (typeof runId !== "string" || runId.length === 0
      || (event?.runId !== undefined && event?.id !== undefined && event.runId !== event.id)
      || !["plan-runner", "executor", "spark"].includes(event?.agent)
      || !Number.isSafeInteger(event?.pid) || event.pid <= 0
      || typeof event?.asyncDir !== "string" || !path.isAbsolute(event.asyncDir)
      || event?.sessionId !== this.lifecycleSessionId) return;
    return { runId, role: event.agent === "spark" ? "executor" : event.agent, asyncDir: event.asyncDir, sessionId: event.sessionId, pid: event.pid };
  }

  observeStarted(event: any): Promise<void> {
    const facts = this.startedFacts(event);
    if (!facts) return Promise.resolve();
    const existing = this.ownedRuns.get(facts.runId);
    if (existing) {
      if (existing.role !== facts.role || existing.sessionId !== facts.sessionId || existing.pid !== facts.pid || existing.asyncDir !== facts.asyncDir) {
        this.ownedRuns.set(facts.runId, { ...existing, identityState: "conflict" });
      }
      return this.startedObservations.get(facts.runId) ?? Promise.resolve();
    }
    const initial: OwnedRun = { rootSessionId: this.rootSessionId, ...facts, birthIdentity: null, identityState: "unavailable" };
    this.ownedRuns.set(facts.runId, initial);
    const observation = (async () => {
      let birthIdentity: string | null = null;
      let identityState: OwnedRun["identityState"] = "verified";
      try { birthIdentity = await this.captureProcessBirthIdentity(facts.pid); } catch { identityState = "unavailable"; }
      const current = this.ownedRuns.get(facts.runId) ?? initial;
      this.ownedRuns.set(facts.runId, { ...current, birthIdentity, identityState: current.identityState === "conflict" ? "conflict" : identityState });
      if (facts.role === "executor") await this.ensureExecutorOwner(facts.runId);
      this.lifecycle(event, "execution.started");
    })();
    this.startedObservations.set(facts.runId, observation);
    void observation.finally(() => {
      if (this.startedObservations.get(facts.runId) === observation) this.startedObservations.delete(facts.runId);
    }).catch(() => undefined);
    return observation.catch(() => undefined);
  }

  acceptTerminalProof(run: OwnedRun, value: any) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid official terminal: proof must be an object");
    const actual = value.runId;
    if (typeof actual !== "string" || actual.length === 0 || actual !== run.runId) {
      throw new Error(`official terminal runId mismatch: expected ${run.runId}, actual ${String(actual)}`);
    }
    const { runId: _runId, ...terminal } = value;
    try { parseProcessTerminal(terminal); } catch (error) { throw new Error(`invalid official terminal: ${error instanceof Error ? error.message : String(error)}`); }
    if (terminal.state !== "observed") throw new Error(`official terminal is non-observed (${String(terminal.state)})`);
    this.terminalProofs.set(run.runId, value);
    this.recordDiagnostic("proof.accepted", this.callerAliases.get(run.runId) ?? run.runId);
    const waiters = this.terminalWaiters.get(run.runId);
    this.terminalWaiters.delete(run.runId);
    for (const resolve of waiters ?? []) resolve(value);
    void this.reviveCallerAfterProof(this.callerAliases.get(run.runId) ?? run.runId).catch(() => undefined);
    return value;
  }

  async grantRevivedCaller(logicalRunId: string, actualRunId: string) {
    const logical = this.logicalCallers.get(logicalRunId);
    if (this.closed || !logical || logical.activeRunId === actualRunId || this.principals.has(actualRunId) || this.callerAliases.has(actualRunId)) throw new Error("Root subagent broker revived caller is invalid");
    const previousActualRunId = logical.activeRunId;
    const generation = logical.generation;
    const callerToken = this.randomToken();
    const pending = (async () => {
      const grantPath = await this.writeGrant({ schemaVersion: "pi-root-subagent-broker-grant.v1", rootSessionId: this.rootSessionId, runId: actualRunId, callerToken, role: "plan-runner" });
      this.grantPaths.add(grantPath);
      if (this.closed || this.logicalCallers.get(logicalRunId)?.activeRunId !== logical.activeRunId || this.logicalCallers.get(logicalRunId)?.generation !== generation || this.principals.has(actualRunId) || this.callerAliases.has(actualRunId)) throw new Error("Root subagent broker revived caller grant changed while pending");
      this.principals.set(actualRunId, { role: "plan-runner", callerToken });
      this.callerAliases.set(actualRunId, logicalRunId);
      this.logicalCallers.set(logicalRunId, { activeRunId: actualRunId, generation: generation + 1 });
      const previousSubscriptions = this.subscriptions.get(previousActualRunId);
      this.subscriptions.delete(previousActualRunId);
      for (const socket of previousSubscriptions ?? []) {
        try { if (!socket.destroyed) socket.destroy(); } catch { /* isolate subscriber failures */ }
      }
      return { callerToken };
    })();
    this.callerGrants.set(actualRunId, pending);
    void pending.finally(() => {
      if (this.callerGrants.get(actualRunId) === pending) this.callerGrants.delete(actualRunId);
    }).catch(() => undefined);
    return await pending;
  }

  async performCallerRevive(logicalRunId: string) {
    if (this.closed) return;
    const logical = this.logicalCallers.get(logicalRunId);
    const actualRunId = logical?.activeRunId;
    const run = actualRunId ? this.ownedRuns.get(actualRunId) : undefined;
    if (!logical || !actualRunId || !run || run.role !== "plan-runner" || !this.terminalProofs.has(actualRunId)) return;
    const caller = this.callers.get(logicalRunId);
    const followUps = this.callerFollowUps.get(logicalRunId);
    const queue = this.callerPushQueues.get(logicalRunId);
    if (!caller || caller.role !== "plan-runner" || (!followUps?.length && !queue?.length)) return;
    const wakeIds = (followUps ?? []).map((followUp) => followUp.wakeId);
    const wakeId = wakeIds[0] ?? "queued-push";
    this.recordDiagnostic("revival.started", logicalRunId, wakeId);
    const preparePlanRunnerRecovery = this.upstream.preparePlanRunnerRecovery;
    if (typeof preparePlanRunnerRecovery === "function") {
      try {
        await preparePlanRunnerRecovery({ role: run.role, runId: actualRunId, asyncDir: run.asyncDir });
      } catch (error) {
        this.recordDiagnostic("revival.failed", logicalRunId, wakeId, { reason: "recovery-prepare-failed", errorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 512) });
        throw error;
      }
    }
    this.recordDiagnostic("resume.invoked", logicalRunId, wakeId);
    let result: any;
    try {
      result = await this.upstream.resume({ id: actualRunId, message: "A durable Root broker wake is pending." });
    } catch (error) {
      this.recordDiagnostic("revival.failed", logicalRunId, wakeId, { reason: "resume-failed", errorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 512) });
      throw error;
    }
    if (!result || typeof result !== "object" || Array.isArray(result) || result instanceof Error || !result.details || typeof result.details !== "object" || Array.isArray(result.details)) throw new Error("Root subagent broker resume result is invalid");
    const revivedRunId = result.details.asyncId;
    const revivedAsyncDir = result.details.asyncDir;
    if (typeof revivedRunId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(revivedRunId) || revivedRunId === "." || revivedRunId === ".." || typeof revivedAsyncDir !== "string" || revivedAsyncDir.length === 0 || !path.isAbsolute(revivedAsyncDir) || revivedRunId === actualRunId || this.principals.has(revivedRunId) || this.callerAliases.has(revivedRunId)) throw new Error("Root subagent broker resume result is invalid");
    this.recordDiagnostic("resume.succeeded", logicalRunId, wakeId, { revivedRunId });
    await this.grantRevivedCaller(logicalRunId, revivedRunId);
    this.recordDiagnostic("grant.issued", logicalRunId, wakeId, { revivedRunId });
    this.reviveResults.set(logicalRunId, result);
    const currentFollowUps = this.callerFollowUps.get(logicalRunId);
    if (currentFollowUps) this.callerFollowUps.set(logicalRunId, currentFollowUps.filter((followUp) => !wakeIds.includes(followUp.wakeId)));
    this.recordDiagnostic("revival.succeeded", logicalRunId, wakeId, { revivedRunId });
  }

  reviveCallerAfterProof(logicalRunId: string) {
    const existing = this.revivePromises.get(logicalRunId);
    if (existing) return existing;
    const logical = this.logicalCallers.get(logicalRunId);
    const run = logical ? this.ownedRuns.get(logical.activeRunId) : undefined;
    const caller = this.callers.get(logicalRunId);
    const followUps = this.callerFollowUps.get(logicalRunId);
    const queue = this.callerPushQueues.get(logicalRunId);
    if (this.closed || !logical || !run || run.role !== "plan-runner" || !this.terminalProofs.has(logical.activeRunId) || !caller || caller.role !== "plan-runner" || (!followUps?.length && !queue?.length)) {
      const reason = this.closed ? "broker-closed" : !logical ? "caller-missing" : !run ? "run-missing" : run.role !== "plan-runner" ? "caller-not-plan-runner" : !this.terminalProofs.has(logical.activeRunId) ? "proof-missing" : !caller || caller.role !== "plan-runner" ? "caller-missing" : "wake-missing";
      this.recordDiagnostic("revival.blocked", logicalRunId, undefined, { reason });
      return Promise.resolve();
    }
    const operation = this.performCallerRevive(logicalRunId);
    this.revivePromises.set(logicalRunId, operation);
    const cleanup = () => {
      if (this.revivePromises.get(logicalRunId) === operation) this.revivePromises.delete(logicalRunId);
    };
    void operation.then(cleanup, cleanup);
    return operation;
  }

  observeTerminal(event: any) {
    const runId = event?.runId;
    const owned = typeof runId === "string" ? this.ownedRuns.get(runId) : undefined;
    if (!owned) return;
    try { this.acceptTerminalProof(owned, event); } catch { /* only strict observed events are authority */ }
  }

  async pollTerminalArtifact(run: OwnedRun, cancelled: () => boolean, setCancelSleep: (cancel: () => void) => void) {
    const readJson = async (file: string) => JSON.parse(await this.readFile(file, "utf8"));
    while (!cancelled()) {
      try {
        const sidecar = await readJson(path.join(run.asyncDir, "process-terminal.json"));
        if (cancelled()) return undefined;
        return this.acceptTerminalProof(run, sidecar);
      } catch (error: any) {
        if (error?.code !== "ENOENT") {
          if (error instanceof Error && /official terminal/.test(error.message)) throw error;
          throw new Error(`invalid official terminal: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      try {
        const status = await readJson(path.join(run.asyncDir, "status.json"));
        if (!status || typeof status !== "object" || Array.isArray(status)) throw new Error("invalid official terminal: status must be an object");
        if (Object.hasOwn(status, "runId") && status.runId !== run.runId) throw new Error(`official terminal runId mismatch: expected ${run.runId}, actual ${String(status.runId)}`);
        if (Object.hasOwn(status, "processTerminal")) {
          const proof = status.processTerminal;
          if (!proof || typeof proof !== "object" || Array.isArray(proof)) throw new Error("invalid official terminal: proof must be an object");
          if (cancelled()) return undefined;
          return this.acceptTerminalProof(run, proof);
        }
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
    let resolveWaiter: (proof: any) => void;
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
      const reason = run.identityState === "conflict" ? "conflict" : "identity unavailable";
      throw new Error(`force cleanup ${reason} for run ${run.runId}: ${deadlineError.message}`);
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

    const waiter = this.waitForTerminal(run.runId); // Install before SIGKILL: it may emit synchronously.
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
      if (this.terminalProofs.has(run.runId)) return this.verifyForcedDeath(run);
      await this.observeOfficialProof(run, `force missing official proof for run ${run.runId}`);
      return this.verifyForcedDeath(run);
    }
    if (this.terminalProofs.has(run.runId)) return;
    const waiter = this.waitForTerminal(run.runId); // Install before stop: it may emit synchronously.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    let cancelSleep: (() => void) | undefined;
    let stopFailed = false;
    let stopError: Error | undefined;
    let deadlineError: TerminalDeadlineError | undefined;
    try {
      let stopSettled = false;
      const deadline = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          const suffix = stopFailed ? ` after stop failure: ${stopError?.message ?? "unknown stop failure"}` : "";
          reject(new TerminalDeadlineError(`missing official proof for run ${run.runId}${suffix}`));
        }, this.terminalTimeoutMs);
      });
      let stopPromise: Promise<any>;
      try { stopPromise = Promise.resolve(this.upstream.stop({ runId: run.runId, dir: run.asyncDir })); } catch (error) { stopPromise = Promise.reject(error); }
      void stopPromise.then(
        () => { stopSettled = true; },
        (error) => { stopSettled = true; stopFailed = true; stopError = error instanceof Error ? error : new Error(String(error).slice(0, 1024) || "unknown stop failure"); },
      );
      await Promise.resolve();
      if (stopSettled && stopFailed) throw stopError;
      if (this.terminalProofs.has(run.runId)) return;
      const artifact = this.pollTerminalArtifact(run, () => cancelled, (cancel) => { cancelSleep = cancel; });
      void artifact.catch(() => undefined);
      const proof = await Promise.race([waiter.promise, artifact, deadline]);
      if (!proof) throw new TerminalDeadlineError(`missing official proof for run ${run.runId}`);
    } catch (error) {
      if (error instanceof TerminalDeadlineError && error.code === "ROOT_TERMINAL_DEADLINE") deadlineError = error;
      else throw error;
    } finally {
      cancelled = true;
      cancelSleep?.();
      if (timeout) clearTimeout(timeout);
      waiter.cancel();
    }
    if (deadlineError) await this.forceCleanup(run, deadlineError);
  }

  async ensureExecutorOwner(runId: string) {
    if (this.closed) throw new Error("Root subagent broker is closing");
    const existing = this.executorGrants.get(runId);
    if (existing) return existing;
    const pending = (async () => {
      const principal = this.principals.get(runId);
      if (principal) {
        if (principal.role !== "executor") throw new Error("Root subagent broker principal is already granted");
        return { callerToken: principal.callerToken };
      }
      const callerToken = this.randomToken();
      this.principals.set(runId, { role: "executor", callerToken });
      try {
        const grantPath = await this.writeGrant({ schemaVersion: "pi-root-subagent-broker-grant.v1", rootSessionId: this.rootSessionId, runId, callerToken, role: "executor" });
        this.grantPaths.add(grantPath);
        return { callerToken };
      } catch (error) {
        this.principals.delete(runId);
        throw error;
      }
    })();
    this.executorGrants.set(runId, pending);
    void pending.finally(() => {
      if (this.executorGrants.get(runId) === pending) this.executorGrants.delete(runId);
    }).catch(() => undefined);
    return await pending;
  }

  async grantCaller({ callerRunId, planId, cwd, originRoot, stateRoot, role }: { callerRunId: string; planId: string; cwd: string; originRoot: string; stateRoot: string; role: unknown }) {
    if (this.closed) throw new Error("Root subagent broker is closing");
    if (role !== "plan-runner" || typeof planId !== "string" || planId.length === 0
      || [cwd, originRoot, stateRoot].some((value) => typeof value !== "string" || value.length === 0 || !path.isAbsolute(value))) {
      throw new Error("Root subagent broker caller grant is invalid");
    }
    if (this.callers.has(callerRunId) || this.principals.has(callerRunId)) throw new Error("Root subagent broker caller is already granted");
    const callerToken = this.randomToken();
    const caller: Caller = { planId, cwd, originRoot, stateRoot, role, callerToken, ownedRunIds: new Set() };
    const pending = (async () => {
      this.callers.set(callerRunId, caller);
      this.logicalCallers.set(callerRunId, { activeRunId: callerRunId, generation: 0 });
      this.callerAliases.set(callerRunId, callerRunId);
      this.callerFollowUps.set(callerRunId, []);
      this.callerPushQueues.set(callerRunId, []);
      this.principals.set(callerRunId, { role, callerToken });
      try {
        const grantPath = await this.writeGrant({ schemaVersion: "pi-root-subagent-broker-grant.v1", rootSessionId: this.rootSessionId, runId: callerRunId, callerToken, role });
        this.grantPaths.add(grantPath);
        if (this.closed) {
          this.callers.delete(callerRunId);
          this.logicalCallers.delete(callerRunId);
          this.callerAliases.delete(callerRunId);
          this.callerFollowUps.delete(callerRunId);
          this.callerPushQueues.delete(callerRunId);
          this.principals.delete(callerRunId);
          throw new Error("Root subagent broker is closing");
        }
        return { callerToken };
      } catch (error) {
        this.callers.delete(callerRunId);
        this.logicalCallers.delete(callerRunId);
        this.callerAliases.delete(callerRunId);
        this.callerFollowUps.delete(callerRunId);
        this.callerPushQueues.delete(callerRunId);
        this.principals.delete(callerRunId);
        throw error;
      }
    })();
    this.callerGrants.set(callerRunId, pending);
    try { return await pending; } finally { if (this.callerGrants.get(callerRunId) === pending) this.callerGrants.delete(callerRunId); }
  }

  enqueueCallerFollowUp(logicalCallerRunId: string, intent: FollowUpIntent) {
    const followUps = this.callerFollowUps.get(logicalCallerRunId);
    if (!followUps) throw new Error("Root subagent broker caller is not granted");
    if (!followUps.some((followUp) => followUp.wakeId === intent.wakeId)) followUps.push(intent);
    this.recordDiagnostic("followup.accepted", logicalCallerRunId, intent.wakeId);
    void this.reviveCallerAfterProof(logicalCallerRunId).catch(() => undefined);
    return { accepted: true, wakeId: intent.wakeId };
  }

  async wakeCaller(logicalCallerRunId: string, intent: unknown) {
    if (this.closed) throw new Error("Root subagent broker is closing");
    const logical = this.logicalCallers.get(logicalCallerRunId);
    const caller = this.callers.get(logicalCallerRunId);
    if (!logical || !caller || caller.role !== "plan-runner" || typeof logicalCallerRunId !== "string" || logicalCallerRunId.length === 0) throw new Error("Root subagent broker caller is not granted");
    if (!intent || typeof intent !== "object" || Array.isArray(intent)
      || JSON.stringify(Object.keys(intent).sort()) !== JSON.stringify(["reason", "wakeId"])) throw new Error("Root subagent broker wake is invalid");
    const { wakeId, reason } = intent as Record<string, unknown>;
    const requestId = typeof wakeId === "string" ? wakeId.slice("attention-reply-".length) : "";
    if (reason !== "attention-reply" || typeof wakeId !== "string" || wakeId !== `attention-reply-${requestId}`
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(requestId) || requestId === "." || requestId === "..") throw new Error("Root subagent broker wake is invalid");
    return this.enqueueCallerFollowUp(logicalCallerRunId, { wakeId, reason });
  }

  handleSocket(socket: Socket) {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    let buffer = "";
    let handled = false;
    socket.on("data", (chunk) => {
      if (handled) return;
      buffer += chunk.toString();
      if (buffer.length > MAX_BUFFER) return socket.destroy();
      const lineEnd = buffer.indexOf("\n");
      if (lineEnd < 0) return;
      handled = true;
      const line = buffer.slice(0, lineEnd);
      void this.respond(socket, line);
    });
    socket.on("error", () => {});
  }

  async respond(socket: Socket, line: string) {
    let request: any;
    try { request = parseBrokerRequest(JSON.parse(line)); } catch { socket.destroy(); return; }
    try {
      const response = await this.dispatch(request, socket, { deferSubscription: request.method === "subscribe" });
      if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`, (error) => {
        if (error) {
          try { socket.destroy(); } catch { /* isolate socket destruction failures */ }
          return;
        }
        if (request.method === "subscribe") {
          if (response.success) this.activateSubscription(request, socket);
          else socket.end();
        } else socket.end();
      });
    } catch (error) {
      try { if (!socket.destroyed) socket.end(`${JSON.stringify(failure(request, "broker_failed", error instanceof Error ? error.message : String(error)))}\n`); } catch { socket.destroy(); }
    }
  }

  registerSubscription(callerRunId: string, socket: Socket) {
    const subscribers = this.subscriptions.get(callerRunId) ?? new Set<Socket>();
    subscribers.add(socket);
    this.subscriptions.set(callerRunId, subscribers);
    socket.once("close", () => subscribers.delete(socket));
  }

  activateSubscription(request: any, socket: Socket) {
    if (this.closed || socket.destroyed) return;
    const principal = this.principals.get(request.callerRunId);
    if (!principal || principal.callerToken !== request.callerToken) return;
    let logicalCallerRunId: string | undefined;
    if (principal.role === "plan-runner") {
      logicalCallerRunId = this.callerAliases.get(request.callerRunId);
      if (!logicalCallerRunId || this.logicalCallers.get(logicalCallerRunId)?.activeRunId !== request.callerRunId) return;
    }
    this.registerSubscription(request.callerRunId, socket);
    if (logicalCallerRunId) this.flushCallerPushQueue(logicalCallerRunId, request.callerRunId, socket);
    if (this.closed || socket.destroyed || this.principals.get(request.callerRunId)?.callerToken !== request.callerToken) return;
    if (logicalCallerRunId && (this.callerAliases.get(request.callerRunId) !== logicalCallerRunId || this.logicalCallers.get(logicalCallerRunId)?.activeRunId !== request.callerRunId || (this.callerPushQueues.get(logicalCallerRunId)?.length ?? 0) !== 0)) return;
    try {
      socket.write(`${JSON.stringify({ schemaVersion: "pi-root-subagent-broker-push.v1", rootSessionId: this.rootSessionId, callerRunId: request.callerRunId, type: "subscription.ready", data: {} })}\n`);
    } catch { /* socket failure leaves the subscription unready */ }
  }

  async dispatch(request: any, socket: Socket, { deferSubscription = false }: { deferSubscription?: boolean } = {}) {
    if (this.closed) return failure(request, "root_closing", "Root session is closing");
    if (request.rootSessionId !== this.rootSessionId) return failure(request, "root_mismatch", "Root session does not match");
    const principal = this.principals.get(request.callerRunId);
    if (!principal || principal.callerToken !== request.callerToken) return failure(request, "caller_unauthorized", "Caller is not granted");
    let logicalCallerRunId = request.callerRunId;
    if (principal.role === "plan-runner") {
      const resolvedLogicalCallerRunId = this.callerAliases.get(request.callerRunId);
      const logicalCaller = resolvedLogicalCallerRunId ? this.logicalCallers.get(resolvedLogicalCallerRunId) : undefined;
      if (!resolvedLogicalCallerRunId || !logicalCaller) return failure(request, "caller_unauthorized", "Caller is not granted");
      if (logicalCaller.activeRunId !== request.callerRunId) return failure(request, "caller_stale", "Caller generation is stale");
      logicalCallerRunId = resolvedLogicalCallerRunId;
    }
    if (principal.role === "executor" && request.method !== "subscribe") return failure(request, "role_unauthorized", "Executor may only subscribe");
    const caller = this.callers.get(logicalCallerRunId);
    if (principal.role === "plan-runner" && !caller) return failure(request, "caller_unauthorized", "Caller is not granted");
    try {
      if (request.method === "subscribe") {
        if (!deferSubscription) this.registerSubscription(request.callerRunId, socket);
        return createBrokerSuccessResponse({ ...request, data: { subscribed: true } });
      }
      if (request.method === "ping") {
        const data = await this.upstream.ping();
        return createBrokerSuccessResponse({ ...request, data: { ...data, methods: [...new Set([...(Array.isArray(data?.methods) ? data.methods : []), "spawn.lookup"])], session: { ...(data?.session ?? {}), cwd: caller.cwd }, planRuntime: { originRoot: caller.originRoot, stateRoot: caller.stateRoot } } });
      }
      if (request.method === "spawn") return await this.spawn(request, caller, logicalCallerRunId);
      if (request.method === "caller.followup") return this.registerCallerFollowUp(request, logicalCallerRunId);
      if (request.method === "spawn.lookup") return this.lookupSpawn(request, caller);
      if (request.method === "supervisor.pending") return this.pendingSupervisor(request, caller, logicalCallerRunId);
      if (request.method === "supervisor.reply") return await this.replySupervisor(request, caller, logicalCallerRunId);
      if (["status", "steer", "interrupt", "stop"].includes(request.method)) return await this.control(request, caller, logicalCallerRunId);
      return failure(request, "unsupported", `Broker method ${request.method} is unsupported`);
    } catch (error) { return failure(request, "upstream_failed", error instanceof Error ? error.message : String(error)); }
  }

  lookupSpawn(request: any, caller: Caller) {
    const entry = this.spawnLedger.get(`${caller.planId}\u0000${request.params.spawnKey}`);
    if (!entry) return createBrokerSuccessResponse({ ...request, data: { state: "not-started" } });
    if (entry.state === "spawned") {
      const proof = this.terminalProofs.get(entry.binding?.runId);
      const data: any = { state: "spawned", binding: entry.binding };
      if (proof?.runId === entry.binding?.runId) {
        const { runId: _runId, ...processTerminal } = proof;
        data.processTerminal = processTerminal;
      }
      return createBrokerSuccessResponse({ ...request, data });
    }
    return createBrokerSuccessResponse({ ...request, data: { state: entry.state } });
  }

  registerCallerFollowUp(request: any, logicalCallerRunId: string) {
    const intent: FollowUpIntent = { ...request.params };
    try {
      return createBrokerSuccessResponse({ ...request, data: this.enqueueCallerFollowUp(logicalCallerRunId, intent) });
    } catch {
      return failure(request, "caller_unauthorized", "Caller is not granted");
    }
  }

  async spawn(request: any, caller: Caller, logicalCallerRunId: string) {
    const params = request.params;
    if (caller.role !== "plan-runner" || !["executor", "spark"].includes(params.agent)) return failure(request, "spawn_unauthorized", "Caller may only spawn executor or spark");
    for (const key of Object.keys(params)) if (FORBIDDEN_SPAWN_FIELDS.has(key)) return failure(request, "spawn_invalid", `Spawn parameter ${key} is forbidden`);
    const spawnKey = params.spawnKey;
    if (spawnKey === undefined) return await this.spawnLegacy(request, caller, logicalCallerRunId, normalizedSpawn(params));
    if (typeof spawnKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(spawnKey) || spawnKey === "." || spawnKey === "..") return failure(request, "spawn_invalid", "Spawn key is invalid");
    const key = `${caller.planId}\u0000${spawnKey}`;
    const hash = createHash("sha256").update(stableJson(normalizedSpawn(params)), "utf8").digest("hex");
    const existing = this.spawnLedger.get(key);
    if (existing) {
      if (existing.hash !== hash) return failure(request, "spawn_conflict", "Spawn key conflicts with existing parameters");
      if (existing.state === "spawning" && existing.promise) return replay(request, await existing.promise);
      if (existing.state === "spawned") return createBrokerSuccessResponse({ ...request, data: existing.reply });
      if (existing.state === "not-started" || existing.state === "cleaned") return await this.startSpawn(request, caller, logicalCallerRunId, normalizedSpawn(params), key, existing);
      return failure(request, "spawn_uncertain", "Spawn outcome is uncertain and cannot be retried");
    }
    return await this.startSpawn(request, caller, logicalCallerRunId, normalizedSpawn(params), key, { hash, state: "not-started", spawnKey, callerRunId: logicalCallerRunId, params: normalizedSpawn(params), pending: [], delivered: new Set() });
  }

  async startSpawn(request: any, caller: Caller, logicalCallerRunId: string, params: Record<string, unknown>, key: string, entry: SpawnLedgerEntry) {
    entry.state = "spawning";
    entry.callerRunId = logicalCallerRunId;
    entry.params = { ...params, cwd: params.cwd ?? caller.cwd };
    delete entry.started;
    entry.pending = [];
    delete entry.reply;
    delete entry.binding;
    this.spawnLedger.set(key, entry);
    const attempt = this.spawnLegacy(request, caller, logicalCallerRunId, params, entry);
    entry.promise = attempt;
    void attempt.then(
      () => { if (entry.promise === attempt) entry.promise = undefined; },
      () => { if (entry.promise === attempt) entry.promise = undefined; },
    );
    return await attempt;
  }

  async spawnLegacy(request: any, caller: Caller, logicalCallerRunId: string, params: Record<string, unknown>, entry?: SpawnLedgerEntry) {
    let reply;
    try {
      reply = await this.upstream.spawn(params);
    } catch (error) {
      if (entry) entry.state = (error as any)?.detail?.spawnDisposition === "not-started" ? "not-started" : "uncertain";
      return failure(request, "upstream_failed", error instanceof Error ? error.message : String(error));
    }
    const details = reply?.details ?? reply;
    const runId = details?.runId;
    const asyncDir = details?.asyncDir;
    if (typeof runId !== "string" || typeof asyncDir !== "string") {
      if (typeof runId === "string") await this.upstream.stop({ runId, dir: asyncDir }).catch(() => undefined);
      if (entry) entry.state = "uncertain";
      return failure(request, "spawn_invalid", "Upstream spawn reply is missing runId or asyncDir");
    }
    try {
      await this.ensureExecutorOwner(runId);
      caller.ownedRunIds.add(runId);
      this.runOwners.set(runId, logicalCallerRunId);
    } catch (error) {
      const grantMessage = error instanceof Error ? error.message : String(error);
      try {
        await this.upstream.stop({ runId, dir: asyncDir });
        if (entry) {
          entry.state = "cleaned";
          delete entry.reply;
          delete entry.binding;
        }
      } catch (stopError) {
        if (entry) entry.state = "uncertain";
        const stopMessage = stopError instanceof Error ? stopError.message : String(stopError);
        return failure(request, "spawn_cleanup", `Executor grant failed: ${grantMessage}; executor stop failed: ${stopMessage}`);
      }
      return failure(request, "spawn_cleanup", grantMessage);
    }
    if (entry) {
      entry.state = "spawned";
      entry.reply = reply;
      entry.binding = details;
      entry.callerRunId = logicalCallerRunId;
      entry.params = params;
      entry.pending ??= [];
      entry.queued ??= new Set();
      entry.delivered ??= new Set();
      for (const pending of entry.pending.splice(0)) this.lifecycle(pending.event, pending.type, entry);
    }
    return createBrokerSuccessResponse({ ...request, data: reply });
  }

  lifecycle(event: any, type: "execution.started" | "execution.completed", known?: SpawnLedgerEntry) {
    const runId = event?.runId ?? event?.id;
    let entry = known;
    if (!entry && typeof runId === "string") entry = [...this.spawnLedger.values()].find((candidate) => candidate.binding?.runId === runId);
    if (!entry && type === "execution.started") {
      const candidates = [...this.spawnLedger.values()].filter((candidate) => candidate.state === "spawning" && candidate.params?.agent === event?.agent && candidate.params?.cwd === event?.cwd);
      if (candidates.length === 1) { candidates[0].pending.push({ event, type }); candidates[0].started = event; }
      return;
    }
    if (!entry && type === "execution.completed") {
      const candidates = [...this.spawnLedger.values()].filter((candidate) => candidate.state === "spawning" && candidate.started && (candidate.started.runId ?? candidate.started.id) === runId);
      if (candidates.length === 1) candidates[0].pending.push({ event, type });
      return;
    }
    if (!entry || !entry.binding || !entry.callerRunId || typeof runId !== "string") return;
    if (type === "execution.started") entry.started = event;
    const started = entry.started;
    const data: any = type === "execution.started"
      ? { dispatchId: entry.spawnKey, runId, asyncDir: event?.asyncDir, cwd: event?.cwd, sessionId: event?.sessionId, state: "running" }
      : { dispatchId: entry.spawnKey, runId, asyncDir: event?.asyncDir ?? started?.asyncDir ?? entry.binding.asyncDir, cwd: event?.cwd ?? started?.cwd ?? entry.params?.cwd, sessionId: event?.sessionId ?? started?.sessionId, state: event?.state ?? "complete" };
    if (event?.version === 1) {
      data.state = event.state ?? "unknown";
      const { runId: _runId, ...proof } = event;
      data.processTerminal = proof;
    }
    try {
      const push = parseBrokerPush({ schemaVersion: "pi-root-subagent-broker-push.v1", rootSessionId: this.rootSessionId, callerRunId: entry.callerRunId, type, data });
      const dedupe = `${type}\u0000${JSON.stringify(data)}`;
      entry.queued ??= new Set();
      if (entry.delivered.has(dedupe) || entry.queued.has(dedupe)) return;
      if (!this.deliverOrQueuePush(entry.callerRunId, push, () => {
        entry.queued?.delete(dedupe);
        entry.delivered.add(dedupe);
      })) entry.queued.add(dedupe);
    } catch { /* malformed upstream lifecycle facts are not forwarded */ }
  }

  outboundPush(push: BrokerPush, actualCallerRunId: string) {
    return parseBrokerPush({ ...push, callerRunId: actualCallerRunId });
  }

  private queueCallerPush(logicalCallerRunId: string, queued: QueuedCallerPush) {
    const queue = this.callerPushQueues.get(logicalCallerRunId);
    if (!queue) return false;
    queue.push(queued);
    void this.reviveCallerAfterProof(logicalCallerRunId).catch(() => undefined);
    return false;
  }

  flushCallerPushQueue(logicalCallerRunId: string, actualCallerRunId: string, socket: Socket) {
    const queue = this.callerPushQueues.get(logicalCallerRunId);
    if (!queue) return false;
    let flushed = false;
    while (queue.length > 0) {
      if (this.closed || socket.destroyed || this.logicalCallers.get(logicalCallerRunId)?.activeRunId !== actualCallerRunId) return flushed;
      const queued = queue[0];
      let outbound: BrokerPush;
      try { outbound = this.outboundPush(queued.push, actualCallerRunId); } catch { return flushed; }
      try { socket.write(`${JSON.stringify(outbound)}\n`); } catch { return flushed; }
      queue.shift();
      flushed = true;
      try { queued.onDelivered?.(); } catch { /* delivery observers must not interrupt FIFO */ }
    }
    return flushed;
  }

  deliverOrQueuePush(logicalCallerRunId: string, push: BrokerPush, onDelivered?: () => void) {
    const queue = this.callerPushQueues.get(logicalCallerRunId);
    const actualCallerRunId = this.logicalCallers.get(logicalCallerRunId)?.activeRunId;
    const sockets = actualCallerRunId
      ? [...(this.subscriptions.get(actualCallerRunId) ?? [])].filter((socket) => !socket.destroyed)
      : [];
    if (!queue || !actualCallerRunId || sockets.length === 0) {
      return this.queueCallerPush(logicalCallerRunId, { push, onDelivered });
    }
    for (const socket of sockets) {
      if (queue.length === 0) break;
      this.flushCallerPushQueue(logicalCallerRunId, actualCallerRunId, socket);
    }
    if (queue.length > 0) {
      return this.queueCallerPush(logicalCallerRunId, { push, onDelivered });
    }
    let outbound: BrokerPush;
    try { outbound = this.outboundPush(push, actualCallerRunId); } catch {
      return this.queueCallerPush(logicalCallerRunId, { push, onDelivered });
    }
    let delivered = false;
    for (const socket of sockets) {
      try { socket.write(`${JSON.stringify(outbound)}\n`); delivered = true; } catch { /* isolate subscriber failures */ }
    }
    if (!delivered) {
      return this.queueCallerPush(logicalCallerRunId, { push, onDelivered });
    }
    try { onDelivered?.(); } catch { /* delivery observers must not interrupt push routing */ }
    return true;
  }

  resolveActiveCaller(logicalRunId: string) {
    if (this.closed) throw new Error("Root subagent broker is closing");
    const logical = this.logicalCallers.get(logicalRunId);
    const caller = this.callers.get(logicalRunId);
    const activeRunId = logical?.activeRunId;
    const principal = activeRunId ? this.principals.get(activeRunId) : undefined;
    if (!logical || !caller || caller.role !== "plan-runner" || !activeRunId || this.callerAliases.get(activeRunId) !== logicalRunId || principal?.role !== "plan-runner") {
      throw new Error("Root subagent broker caller is invalid");
    }
    return activeRunId;
  }

  async statusCaller(logicalRunId: string) {
    return await this.upstream.status({ runId: this.resolveActiveCaller(logicalRunId) });
  }

  async interruptCaller(logicalRunId: string) {
    return await this.upstream.interrupt({ runId: this.resolveActiveCaller(logicalRunId) });
  }

  async stopCaller(logicalRunId: string) {
    return await this.upstream.stop({ runId: this.resolveActiveCaller(logicalRunId) });
  }

  async control(request: any, caller: Caller, logicalCallerRunId: string) {
    const runId = request.params.runId ?? request.params.id;
    if (typeof runId !== "string" || !caller.ownedRunIds.has(runId) || this.runOwners.get(runId) !== logicalCallerRunId) return failure(request, "run_not_owned", "Run is not owned by caller");
    return createBrokerSuccessResponse({ ...request, data: await this.upstream[request.method](request.params) });
  }

  async routeSupervisorRequest(message: any, context?: any) {
    if (this.closed || message?.customType !== "subagent_supervisor_request") return;
    const details = message.details;
    const { parent: _parent, depth: _depth, path: _path, ...upstreamDetails } = details ?? {};
    const executorRunId = upstreamDetails.runId;
    const ownerRunId = typeof executorRunId === "string" ? this.runOwners.get(executorRunId) : undefined;
    let push;
    try {
      push = createSupervisorRequestPush({ rootSessionId: this.rootSessionId, callerRunId: ownerRunId ?? "owner", upstreamDetails: { ...upstreamDetails, content: message.content } });
    } catch { return { code: "supervisor_request_invalid" }; }
    const existing = this.supervisorRequests.get(push.data.requestId as string);
    if (existing) {
      if (stableJson({ ownerRunId: existing.ownerRunId, data: existing.data }) !== stableJson({ ownerRunId, data: push.data })) return { code: "supervisor_request_conflict" };
      return;
    }
    if (!ownerRunId || !this.callers.has(ownerRunId)) return;
    const entry: SupervisorRequest = { requestId: push.data.requestId as string, ownerRunId, executorRunId: push.data.executorRunId as string, data: push.data, context, expectsReply: push.data.expectsReply === true, state: "pending" };
    this.supervisorRequests.set(entry.requestId, entry);
    this.deliverOrQueuePush(ownerRunId, push);
  }

  pendingSupervisor(request: any, _caller: Caller, logicalCallerRunId: string) {
    const pending = [...this.supervisorRequests.values()]
      .filter((entry) => entry.ownerRunId === logicalCallerRunId && entry.expectsReply && entry.state === "pending")
      .map((entry) => entry.data);
    return createBrokerSuccessResponse({ ...request, data: { pending } });
  }

  async replySupervisor(request: any, _caller: Caller, logicalCallerRunId: string) {
    const entry = this.supervisorRequests.get(request.params.replyTo);
    if (!entry || entry.expectsReply !== true || entry.state === "consumed") return failure(request, "supervisor_request_unknown", "Supervisor request is unknown");
    if (entry.ownerRunId !== logicalCallerRunId) return failure(request, "supervisor_not_owned", "Supervisor request is not owned by caller");
    if (entry.state === "replying") return failure(request, "supervisor_request_unknown", "Supervisor request is unavailable");
    entry.state = "replying";
    try {
      const data = await this.upstream.executeSupervisor({ action: "reply", replyTo: request.params.replyTo, message: request.params.message }, entry.context);
      entry.state = "consumed";
      return createBrokerSuccessResponse({ ...request, data });
    } catch (error) {
      entry.state = "pending";
      return failure(request, "upstream_failed", error instanceof Error ? error.message : String(error));
    }
  }

  async closeRootSession() {
    if (this.closePromise) return this.closePromise;
    if (this.teardown.released) return;
    this.closed = true;
    this.recordDiagnostic("close.started");
    const closing = (async () => {
      let startupTimeout: ReturnType<typeof setTimeout> | undefined;
      const startupDeadline = new Promise<never>((_, reject) => {
        startupTimeout = setTimeout(() => reject(new AggregateError([], "Root subagent broker startup barrier deadline exceeded")), this.terminalTimeoutMs);
      });
      const collectStartupBarrier = () => [...this.startedObservations.values(), ...this.executorGrants.values(), ...this.callerGrants.values(), ...this.revivePromises.values(), ...[...this.spawnLedger.values()].map((entry) => entry.promise).filter((promise): promise is Promise<any> => Boolean(promise))];
      let observedStartupWork = false;
      try {
        for (;;) {
          const startupBarrier = collectStartupBarrier();
          if (startupBarrier.length === 0) {
            if (!observedStartupWork) break;
            await Promise.resolve();
            if (collectStartupBarrier().length === 0) break;
            continue;
          }
          observedStartupWork = true;
          const settled = Promise.allSettled(startupBarrier);
          void settled.then(() => undefined);
          await Promise.race([settled, startupDeadline]);
        }
      } finally { if (startupTimeout) clearTimeout(startupTimeout); }
      const drainPhase = async (role: OwnedRun["role"]) => {
        const runs = [...this.ownedRuns.values()].filter((run) => run.role === role && (this.forcePendingRuns.has(run.runId) || !this.terminalProofs.has(run.runId)));
        const settled = await Promise.allSettled(runs.map((run) => this.drainRun(run)));
        const errors = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason);
        if (errors.length) throw new AggregateError(errors, `Root subagent broker ${role} drain failed`);
      };
      await drainPhase("executor");
      await drainPhase("plan-runner");
      if (!this.teardown.grants) {
        for (const grantPath of [...this.grantPaths]) {
          if (this.cleanedGrantPaths.has(grantPath)) continue;
          try { await rm(grantPath, { force: true }); }
          catch (error: any) { if (error?.code !== "ENOENT") throw error; }
          this.cleanedGrantPaths.add(grantPath);
        }
        this.teardown.grants = true;
      }
      if (!this.teardown.transport) {
        for (const socket of this.sockets) this.transportSockets.add(socket);
        for (const sockets of this.subscriptions.values()) {
          for (const socket of sockets) this.transportSockets.add(socket);
        }
        for (const [callerRunId, sockets] of this.subscriptions) {
          const push = { schemaVersion: "pi-root-subagent-broker-push.v1", rootSessionId: this.rootSessionId, callerRunId, type: "root.closing", data: {} };
          for (const socket of sockets) {
            if (this.closingSockets.has(socket)) continue;
            this.closingSockets.add(socket);
            if (!socket.destroyed) socket.write(`${JSON.stringify(push)}\n`);
          }
        }
        for (const socket of this.transportSockets) {
          if (this.endedSockets.has(socket)) continue;
          this.endedSockets.add(socket);
          if (!socket.destroyed && typeof (socket as any).end === "function") socket.end();
        }
        const destroyTimer = setTimeout(() => {
          for (const socket of this.transportSockets) if (!socket.destroyed && typeof (socket as any).destroy === "function") socket.destroy();
        }, 25);
        try {
          await new Promise<void>((resolve, reject) => {
            const server = this.server;
            if (!server) return resolve();
            let settled = false;
            const finish = (callback: (value?: any) => void, value?: any) => {
              if (settled) return;
              settled = true;
              server.off("error", fail);
              callback(value);
            };
            const fail = (error: Error) => finish(reject, error);
            server.once("error", fail);
            try { server.close(() => finish(resolve)); } catch (error) { finish(reject, error); }
          });
        } finally { clearTimeout(destroyTimer); }
        await rm(brokerSocketPath(this.rootSessionId), { force: true });
        this.teardown.transport = true;
      }
      if (!this.teardown.upstream) {
        await this.upstream.dispose?.();
        this.teardown.upstream = true;
      }
      this.unsubscribeStarted?.(); this.unsubscribeStarted = undefined;
      this.unsubscribeComplete?.(); this.unsubscribeComplete = undefined;
      this.unsubscribeTerminal?.(); this.unsubscribeTerminal = undefined;
      this.callers.clear(); this.logicalCallers.clear(); this.callerAliases.clear(); this.callerFollowUps.clear(); this.callerPushQueues.clear(); this.principals.clear(); this.runOwners.clear(); this.subscriptions.clear(); this.sockets.clear();
      this.grantPaths.clear(); this.executorGrants.clear(); this.callerGrants.clear(); this.spawnLedger.clear(); this.supervisorRequests.clear();
      this.ownedRuns.clear(); this.terminalProofs.clear(); this.reviveResults.clear(); this.revivePromises.clear(); this.forcePendingRuns.clear(); this.terminalWaiters.clear(); this.startedObservations.clear();
      this.transportSockets.clear(); this.closingSockets.clear(); this.endedSockets.clear(); this.cleanedGrantPaths.clear(); this.server = undefined;
      this.teardown.released = true;
      this.recordDiagnostic("close.completed");
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
