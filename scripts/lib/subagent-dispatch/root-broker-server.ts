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

type Upstream = Record<string, (...args: any[]) => Promise<any>> & { dispose?: () => void | Promise<void> };
type Caller = { planId: string; cwd: string; originRoot: string; stateRoot: string; role: "plan-runner"; callerToken: string; ownedRunIds: Set<string> };
type Principal = { role: "plan-runner" | "executor"; callerToken: string };
type Dependencies = { writeGrant?: typeof writeBrokerGrant; randomToken?: () => string; captureProcessBirthIdentity?: typeof captureProcessBirthIdentity; events?: { on(channel: string, listener: (event: any) => void | Promise<void>): () => void }; terminalTimeoutMs?: number; readFile?: typeof nodeReadFile; artifactPollIntervalMs?: number };
type SpawnLedgerEntry = { hash: string; state: "not-started" | "spawning" | "spawned" | "cleaned" | "uncertain"; spawnKey?: string; callerRunId?: string; params?: Record<string, unknown>; promise?: Promise<any>; reply?: any; binding?: any; started?: any; pending: any[]; delivered: Set<string> };
type SupervisorRequest = { requestId: string; ownerRunId: string; executorRunId: string; data: Record<string, unknown>; context: any; expectsReply: boolean; state: "pending" | "replying" | "consumed" };
type OwnedRun = { rootSessionId: string; runId: string; role: "plan-runner" | "executor"; asyncDir: string; sessionId: string; pid: number; birthIdentity: string | null; identityState: "verified" | "unavailable" | "conflict" };
type StartedFacts = Pick<OwnedRun, "runId" | "role" | "asyncDir" | "sessionId" | "pid">;

const FORBIDDEN_SPAWN_FIELDS = new Set(["caller", "root", "token", "parent", "depth", "path", "fanout", "callerRunId", "callerToken", "rootSessionId", "parentRunId", "parentDepth", "parentPath"]);
const MAX_BUFFER = 64 * 1024;

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
  upstream: Upstream;
  callers = new Map<string, Caller>();
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
  terminalWaiters = new Map<string, Set<(proof: any) => void>>();
  startedObservations = new Map<string, Promise<void>>();
  unsubscribeStarted: (() => void) | undefined;
  unsubscribeComplete: (() => void) | undefined;
  unsubscribeTerminal: (() => void) | undefined;
  server: ReturnType<typeof createServer> | undefined;
  closed = false;
  closePromise: Promise<void> | undefined;
  writeGrant: typeof writeBrokerGrant;
  randomToken: () => string;
  captureProcessBirthIdentity: typeof captureProcessBirthIdentity;
  events: Dependencies["events"];
  terminalTimeoutMs: number;
  readFile: typeof nodeReadFile;
  artifactPollIntervalMs: number;

  constructor({ rootSessionId, upstream, writeGrant = writeBrokerGrant, randomToken = () => randomBytes(32).toString("hex"), captureProcessBirthIdentity: captureBirthIdentity = captureProcessBirthIdentity, events, terminalTimeoutMs = 5_000, readFile = nodeReadFile, artifactPollIntervalMs = 50 }: { rootSessionId: string; upstream: Upstream } & Dependencies) {
    if (!Number.isSafeInteger(terminalTimeoutMs) || terminalTimeoutMs <= 0) throw new Error("Root subagent broker terminal timeout must be a positive safe integer");
    if (!Number.isSafeInteger(artifactPollIntervalMs) || artifactPollIntervalMs <= 0) throw new Error("Root subagent broker artifact poll interval must be a positive safe integer");
    this.rootSessionId = rootSessionId;
    this.upstream = upstream;
    this.writeGrant = writeGrant;
    this.randomToken = randomToken;
    this.captureProcessBirthIdentity = captureBirthIdentity;
    this.events = events;
    this.terminalTimeoutMs = terminalTimeoutMs;
    this.readFile = readFile;
    this.artifactPollIntervalMs = artifactPollIntervalMs;
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
      || event?.sessionId !== this.rootSessionId) return;
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
    const waiters = this.terminalWaiters.get(run.runId);
    this.terminalWaiters.delete(run.runId);
    for (const resolve of waiters ?? []) resolve(value);
    return value;
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

  async drainRun(run: OwnedRun) {
    if (this.terminalProofs.has(run.runId)) return;
    const waiter = this.waitForTerminal(run.runId); // Install before stop: it may emit synchronously.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    let cancelSleep: (() => void) | undefined;
    try {
      const artifact = this.pollTerminalArtifact(run, () => cancelled, (cancel) => { cancelSleep = cancel; });
      void artifact.catch(() => undefined);
      const terminal = Promise.race([
        waiter.promise,
        artifact,
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`missing official proof for run ${run.runId}`)), this.terminalTimeoutMs); }),
      ]);
      let stopError: unknown;
      let stopSettled = false;
      let stopPromise: Promise<any>;
      try {
        stopPromise = Promise.resolve(this.upstream.stop({ runId: run.runId, dir: run.asyncDir }));
      } catch (error) {
        stopPromise = Promise.reject(error);
      }
      void stopPromise.then(
        () => { stopSettled = true; },
        (error) => { stopSettled = true; stopError = error; },
      );
      // Preserve immediate stop failures as debt even when stop synchronously emits proof.
      await Promise.resolve();
      if (stopSettled && stopError !== undefined) throw stopError;
      const proof = await terminal;
      if (!proof) throw new Error(`missing official proof for run ${run.runId}`);
    } finally {
      cancelled = true;
      cancelSleep?.();
      if (timeout) clearTimeout(timeout);
      waiter.cancel();
    }
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
      this.principals.set(callerRunId, { role, callerToken });
      try {
        const grantPath = await this.writeGrant({ schemaVersion: "pi-root-subagent-broker-grant.v1", rootSessionId: this.rootSessionId, runId: callerRunId, callerToken, role });
        this.grantPaths.add(grantPath);
        if (this.closed) {
          this.callers.delete(callerRunId);
          this.principals.delete(callerRunId);
          throw new Error("Root subagent broker is closing");
        }
        return { callerToken };
      } catch (error) {
        this.callers.delete(callerRunId);
        this.principals.delete(callerRunId);
        throw error;
      }
    })();
    this.callerGrants.set(callerRunId, pending);
    try { return await pending; } finally { this.callerGrants.delete(callerRunId); }
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
      const response = await this.dispatch(request, socket);
      if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`, () => { if (request.method !== "subscribe") socket.end(); });
    } catch (error) {
      try { if (!socket.destroyed) socket.end(`${JSON.stringify(failure(request, "broker_failed", error instanceof Error ? error.message : String(error)))}\n`); } catch { socket.destroy(); }
    }
  }

  async dispatch(request: any, socket: Socket) {
    if (this.closed) return failure(request, "root_closing", "Root session is closing");
    if (request.rootSessionId !== this.rootSessionId) return failure(request, "root_mismatch", "Root session does not match");
    const principal = this.principals.get(request.callerRunId);
    if (!principal || principal.callerToken !== request.callerToken) return failure(request, "caller_unauthorized", "Caller is not granted");
    if (principal.role === "executor" && request.method !== "subscribe") return failure(request, "role_unauthorized", "Executor may only subscribe");
    const caller = this.callers.get(request.callerRunId);
    if (principal.role === "plan-runner" && !caller) return failure(request, "caller_unauthorized", "Caller is not granted");
    try {
      if (request.method === "subscribe") {
        const subscribers = this.subscriptions.get(request.callerRunId) ?? new Set<Socket>();
        subscribers.add(socket);
        this.subscriptions.set(request.callerRunId, subscribers);
        socket.once("close", () => subscribers.delete(socket));
        return createBrokerSuccessResponse({ ...request, data: { subscribed: true } });
      }
      if (request.method === "ping") {
        const data = await this.upstream.ping();
        return createBrokerSuccessResponse({ ...request, data: { ...data, methods: [...new Set([...(Array.isArray(data?.methods) ? data.methods : []), "spawn.lookup"])], session: { ...(data?.session ?? {}), cwd: caller.cwd }, planRuntime: { originRoot: caller.originRoot, stateRoot: caller.stateRoot } } });
      }
      if (request.method === "spawn") return await this.spawn(request, caller);
      if (request.method === "spawn.lookup") return this.lookupSpawn(request, caller);
      if (request.method === "supervisor.pending") return this.pendingSupervisor(request, caller);
      if (request.method === "supervisor.reply") return await this.replySupervisor(request, caller);
      if (["status", "steer", "interrupt", "stop"].includes(request.method)) return await this.control(request, caller);
      return failure(request, "unsupported", `Broker method ${request.method} is unsupported`);
    } catch (error) { return failure(request, "upstream_failed", error instanceof Error ? error.message : String(error)); }
  }

  lookupSpawn(request: any, caller: Caller) {
    const entry = this.spawnLedger.get(`${caller.planId}\u0000${request.params.spawnKey}`);
    if (!entry) return createBrokerSuccessResponse({ ...request, data: { state: "not-started" } });
    if (entry.state === "spawned") return createBrokerSuccessResponse({ ...request, data: { state: "spawned", binding: entry.binding } });
    return createBrokerSuccessResponse({ ...request, data: { state: entry.state } });
  }

  async spawn(request: any, caller: Caller) {
    const params = request.params;
    if (caller.role !== "plan-runner" || !["executor", "spark"].includes(params.agent)) return failure(request, "spawn_unauthorized", "Caller may only spawn executor or spark");
    for (const key of Object.keys(params)) if (FORBIDDEN_SPAWN_FIELDS.has(key)) return failure(request, "spawn_invalid", `Spawn parameter ${key} is forbidden`);
    const spawnKey = params.spawnKey;
    if (spawnKey === undefined) return await this.spawnLegacy(request, caller, normalizedSpawn(params));
    if (typeof spawnKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(spawnKey) || spawnKey === "." || spawnKey === "..") return failure(request, "spawn_invalid", "Spawn key is invalid");
    const key = `${caller.planId}\u0000${spawnKey}`;
    const hash = createHash("sha256").update(stableJson(normalizedSpawn(params)), "utf8").digest("hex");
    const existing = this.spawnLedger.get(key);
    if (existing) {
      if (existing.hash !== hash) return failure(request, "spawn_conflict", "Spawn key conflicts with existing parameters");
      if (existing.state === "spawning" && existing.promise) return replay(request, await existing.promise);
      if (existing.state === "spawned") return createBrokerSuccessResponse({ ...request, data: existing.reply });
      if (existing.state === "not-started" || existing.state === "cleaned") return await this.startSpawn(request, caller, normalizedSpawn(params), key, existing);
      return failure(request, "spawn_uncertain", "Spawn outcome is uncertain and cannot be retried");
    }
    return await this.startSpawn(request, caller, normalizedSpawn(params), key, { hash, state: "not-started", spawnKey, callerRunId: request.callerRunId, params: normalizedSpawn(params), pending: [], delivered: new Set() });
  }

  async startSpawn(request: any, caller: Caller, params: Record<string, unknown>, key: string, entry: SpawnLedgerEntry) {
    entry.state = "spawning";
    entry.params = { ...params, cwd: params.cwd ?? caller.cwd };
    delete entry.started;
    entry.pending = [];
    delete entry.reply;
    delete entry.binding;
    this.spawnLedger.set(key, entry);
    const attempt = this.spawnLegacy(request, caller, params, entry);
    entry.promise = attempt;
    void attempt.then(
      () => { if (entry.promise === attempt) entry.promise = undefined; },
      () => { if (entry.promise === attempt) entry.promise = undefined; },
    );
    return await attempt;
  }

  async spawnLegacy(request: any, caller: Caller, params: Record<string, unknown>, entry?: SpawnLedgerEntry) {
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
      this.runOwners.set(runId, request.callerRunId);
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
      entry.callerRunId = request.callerRunId;
      entry.params = params;
      entry.pending ??= [];
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
      if (entry.delivered.has(dedupe)) return;
      entry.delivered.add(dedupe);
      for (const socket of this.subscriptions.get(entry.callerRunId) ?? []) {
        try { if (!socket.destroyed) socket.write(`${JSON.stringify(push)}\n`); } catch { /* isolate subscriber failures */ }
      }
    } catch { /* malformed upstream lifecycle facts are not forwarded */ }
  }

  async control(request: any, caller: Caller) {
    const runId = request.params.runId ?? request.params.id;
    if (typeof runId !== "string" || !caller.ownedRunIds.has(runId) || this.runOwners.get(runId) !== request.callerRunId) return failure(request, "run_not_owned", "Run is not owned by caller");
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
    for (const socket of this.subscriptions.get(ownerRunId) ?? []) {
      try { if (!socket.destroyed) socket.write(`${JSON.stringify(push)}\n`); } catch { /* isolate subscriber failures */ }
    }
  }

  pendingSupervisor(request: any, _caller: Caller) {
    const pending = [...this.supervisorRequests.values()]
      .filter((entry) => entry.ownerRunId === request.callerRunId && entry.expectsReply && entry.state === "pending")
      .map((entry) => entry.data);
    return createBrokerSuccessResponse({ ...request, data: { pending } });
  }

  async replySupervisor(request: any, _caller: Caller) {
    const entry = this.supervisorRequests.get(request.params.replyTo);
    if (!entry || entry.expectsReply !== true || entry.state === "consumed") return failure(request, "supervisor_request_unknown", "Supervisor request is unknown");
    if (entry.ownerRunId !== request.callerRunId) return failure(request, "supervisor_not_owned", "Supervisor request is not owned by caller");
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
    if (this.closed && !this.server) return;
    this.closed = true;
    const startupBarrier = [
      ...this.startedObservations.values(),
      ...this.executorGrants.values(),
      ...this.callerGrants.values(),
      ...[...this.spawnLedger.values()].map((entry) => entry.promise).filter((promise): promise is Promise<any> => Boolean(promise)),
    ];
    const closing = (async () => {
      if (startupBarrier.length > 0) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const settled = Promise.allSettled(startupBarrier);
        try {
          await Promise.race([
            settled,
            new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new AggregateError([], "Root subagent broker startup barrier deadline exceeded")), this.terminalTimeoutMs); }),
          ]);
        } finally {
          if (timeout) clearTimeout(timeout);
          // Keep observing late startup settlements after a bounded close attempt.
          void settled.then(() => undefined);
        }
      }
      const drainPhase = async (role: OwnedRun["role"]) => {
        const runs = [...this.ownedRuns.values()].filter((run) => run.role === role && !this.terminalProofs.has(run.runId));
        const settled = await Promise.allSettled(runs.map((run) => this.drainRun(run)));
        const errors = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason);
        if (errors.length) throw new AggregateError(errors, `Root subagent broker ${role} drain failed`);
      };
      await drainPhase("executor");
      await drainPhase("plan-runner");

      this.unsubscribeStarted?.(); this.unsubscribeStarted = undefined;
      this.unsubscribeComplete?.(); this.unsubscribeComplete = undefined;
      this.unsubscribeTerminal?.(); this.unsubscribeTerminal = undefined;
      let teardownError: unknown;
      try {
        const transportSockets = new Set<Socket>(this.sockets);
        for (const [callerRunId, sockets] of this.subscriptions) {
          const push = { schemaVersion: "pi-root-subagent-broker-push.v1", rootSessionId: this.rootSessionId, callerRunId, type: "root.closing", data: {} };
          for (const socket of sockets) {
            transportSockets.add(socket);
            if (!socket.destroyed) socket.write(`${JSON.stringify(push)}\n`);
          }
        }
        for (const socket of transportSockets) if (!socket.destroyed && typeof (socket as any).end === "function") socket.end();
        setTimeout(() => { for (const socket of transportSockets) if (!socket.destroyed && typeof (socket as any).destroy === "function") socket.destroy(); }, 25).unref?.();
        await new Promise<void>((resolve) => this.server ? this.server.close(() => resolve()) : resolve());
        this.server = undefined;
        await rm(brokerSocketPath(this.rootSessionId), { force: true });
        await Promise.all([...this.grantPaths].map((grantPath) => rm(grantPath, { force: true })));
      } catch (error) {
        teardownError = error;
      } finally {
        try {
          await this.upstream.dispose?.();
        } finally {
          this.callers.clear();
          this.principals.clear();
          this.runOwners.clear();
          this.subscriptions.clear();
          this.sockets.clear();
          this.grantPaths.clear();
          this.executorGrants.clear();
          this.callerGrants.clear();
          this.spawnLedger.clear();
          this.supervisorRequests.clear();
          this.ownedRuns.clear();
          this.terminalProofs.clear();
          this.terminalWaiters.clear();
          this.startedObservations.clear();
        }
      }
      if (teardownError) throw teardownError;
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
