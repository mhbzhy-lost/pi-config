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
  parseProcessTerminal,
  setBrokerSocketPermissions,
  writeBrokerGrant,
} from "./root-broker-protocol.ts";

type Upstream = {
  ping: (...args: any[]) => Promise<any> | any;
  stop: (...args: any[]) => Promise<any> | any;
  dispose?: () => void | Promise<void>;
};
type Principal = { role: "executor"; callerToken: string };
type OwnedRun = {
  rootSessionId: string;
  runId: string;
  role: "executor";
  asyncDir: string;
  sessionId: string;
  pid: number;
  birthIdentity: string | null;
  identityState: "verified" | "unavailable" | "conflict";
};
type StartedFacts = Pick<OwnedRun, "runId" | "role" | "asyncDir" | "sessionId" | "pid">;
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
  readFile?: typeof nodeReadFile;
  artifactPollIntervalMs?: number;
  lifecycleSessionId?: string;
  setSocketPermissions?: typeof setBrokerSocketPermissions;
};

const MAX_BUFFER = 64 * 1024;

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

function frozen<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as any)) frozen(child);
  return Object.freeze(value);
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
  subscriptions = new Map<string, Set<Socket>>();
  sockets = new Set<Socket>();
  grantPaths = new Set<string>();
  executorGrants = new Map<string, Promise<{ callerToken: string }>>();
  ownedRuns = new Map<string, OwnedRun>();
  facadeRuns = new Map<string, FacadeRun>();
  terminalProofs = new Map<string, any>();
  terminalConflicts = new Set<string>();
  forcePendingRuns = new Set<string>();
  terminalWaiters = new Map<string, Set<(proof: any) => void>>();
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
  readFile: typeof nodeReadFile;
  artifactPollIntervalMs: number;
  setSocketPermissions: typeof setBrokerSocketPermissions;

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
    readFile = nodeReadFile,
    artifactPollIntervalMs = 50,
    setSocketPermissions: applySocketPermissions = setBrokerSocketPermissions,
  }: { rootSessionId: string; upstream: Upstream } & Dependencies) {
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
    this.setSocketPermissions = applySocketPermissions;
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

  startedFacts(event: any): StartedFacts | undefined {
    const runId = event?.runId ?? event?.id;
    if (typeof runId !== "string" || runId.length === 0
      || (event?.runId !== undefined && event?.id !== undefined && event.runId !== event.id)
      || !["executor", "spark"].includes(event?.agent)
      || !Number.isSafeInteger(event?.pid) || event.pid <= 0
      || typeof event?.asyncDir !== "string" || !path.isAbsolute(event.asyncDir)
      || event?.sessionId !== this.lifecycleSessionId) return;
    return { runId, role: "executor", asyncDir: event.asyncDir, sessionId: event.sessionId, pid: event.pid };
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
    const existing = this.facadeRuns.get(incoming.runId);
    if (existing && (existing.asyncDir !== incoming.asyncDir || existing.sessionId !== incoming.sessionId || existing.pid !== incoming.pid || existing.agent !== incoming.agent || existing.kind !== incoming.kind)) {
      throw new Error("Facade run identity conflicts");
    }
    this.facadeRuns.set(incoming.runId, existing ?? incoming);
  }

  observeStarted(event: any): Promise<void> {
    const facts = this.startedFacts(event);
    if (!facts) return Promise.resolve();
    const existing = this.ownedRuns.get(facts.runId);
    if (existing) {
      if (existing.sessionId !== facts.sessionId || existing.pid !== facts.pid || existing.asyncDir !== facts.asyncDir) {
        this.ownedRuns.set(facts.runId, { ...existing, identityState: "conflict" });
      }
      return this.startedObservations.get(facts.runId) ?? Promise.resolve();
    }
    this.registerFacadeRun({ ...facts, agent: event.agent, kind: "coding" });
    const initial: OwnedRun = { rootSessionId: this.rootSessionId, ...facts, birthIdentity: null, identityState: "unavailable" };
    this.ownedRuns.set(facts.runId, initial);
    const observation = (async () => {
      let birthIdentity: string | null = null;
      let identityState: OwnedRun["identityState"] = "unavailable";
      try {
        const observedBirthIdentity = await this.captureProcessBirthIdentity(facts.pid);
        if (typeof observedBirthIdentity === "string" && observedBirthIdentity.trim().length > 0) {
          birthIdentity = observedBirthIdentity;
          identityState = "verified";
        }
      } catch { /* missing birth identity remains unavailable */ }
      const current = this.ownedRuns.get(facts.runId) ?? initial;
      this.ownedRuns.set(facts.runId, { ...current, birthIdentity, identityState: current.identityState === "conflict" ? "conflict" : identityState });
      await this.ensureExecutorOwner(facts.runId);
    })();
    this.startedObservations.set(facts.runId, observation);
    void observation.finally(() => {
      if (this.startedObservations.get(facts.runId) === observation) this.startedObservations.delete(facts.runId);
    }).catch(() => undefined);
    return observation.catch(() => undefined);
  }

  acceptTerminalProof(run: FacadeRun, value: any) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid official terminal: proof must be an object");
    if (typeof value.runId !== "string" || value.runId !== run.runId) {
      throw new Error(`official terminal runId mismatch: expected ${run.runId}, actual ${String(value.runId)}`);
    }
    for (const key of ["sessionId", "pid", "asyncDir", "agent"]) {
      if (value[key] !== undefined && value[key] !== run[key as keyof FacadeRun]) throw new Error(`official terminal ${key} mismatch`);
    }
    const { runId: _runId, sessionId: _sessionId, pid: _pid, asyncDir: _asyncDir, agent: _agent, ...terminal } = value;
    try { parseProcessTerminal(terminal); } catch (error) { throw new Error(`invalid official terminal: ${error instanceof Error ? error.message : String(error)}`); }
    if (terminal.state !== "observed") throw new Error(`official terminal is non-observed (${String(terminal.state)})`);
    const accepted = frozen(structuredClone({ runId: run.runId, ...terminal }));
    const existing = this.terminalProofs.get(run.runId);
    if (existing) {
      if (proofId(existing) !== proofId(accepted)) this.terminalConflicts.add(run.runId);
      return existing;
    }
    this.terminalProofs.set(run.runId, accepted);
    const waiters = this.terminalWaiters.get(run.runId);
    this.terminalWaiters.delete(run.runId);
    for (const resolve of waiters ?? []) resolve(accepted);
    return accepted;
  }

  observeTerminal(event: any) {
    const run = typeof event?.runId === "string" ? this.facadeRuns.get(event.runId) : undefined;
    if (!run) return;
    try { this.acceptTerminalProof(run, event); } catch { /* strict official proof is the only authority */ }
  }

  inspectFacadeTerminalProof(runId: string) {
    const run = this.facadeRuns.get(runId);
    if (!run) return null;
    const proof = this.terminalProofs.get(runId) ?? null;
    return frozen({ runId, state: proof ? "observed" : "pending", proofHash: proof ? proofId(proof) : null, proof, conflict: this.terminalConflicts.has(runId) });
  }

  inspectExecutorProof(runId: string) {
    const run = this.ownedRuns.get(runId);
    if (!run) return null;
    const proof = this.terminalProofs.get(runId);
    const runner = proof?.instances?.find((instance: any) => instance.kind === "runner" && instance.processInstanceId === proof.runnerProcessInstanceId);
    const successful = Boolean(runner && proof.instances.every((instance: any) => instance.exitCode === 0 && instance.signal === null));
    return frozen({
      schemaVersion: "root-broker.executor-proof.v1",
      ownership: {
        rootSessionId: run.rootSessionId,
        runId: run.runId,
        role: run.role,
        asyncDir: run.asyncDir,
        sessionId: run.sessionId,
        identityState: run.identityState,
      },
      terminal: proof ? {
        proofId: proofId(proof),
        observedAt: proof.observedAt,
        outcome: successful ? "succeeded" : "failed",
      } : null,
      terminalConflict: this.terminalConflicts.has(runId),
    });
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
          return this.acceptTerminalProof(run, { runId: run.runId, ...proof });
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

  async ensureExecutorOwner(runId: string) {
    if (this.closed) throw new Error("Root subagent broker is closing");
    const existing = this.executorGrants.get(runId);
    if (existing) return existing;
    const pending = (async () => {
      const principal = this.principals.get(runId);
      if (principal) return { callerToken: principal.callerToken };
      const callerToken = this.randomToken();
      this.principals.set(runId, { role: "executor", callerToken });
      try {
        const grantPath = await this.writeGrant({ schemaVersion: "pi-root-subagent-broker-grant.v1", rootSessionId: this.rootSessionId, runId, callerToken, role: "executor" });
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
    this.executorGrants.set(runId, pending);
    void pending.finally(() => {
      if (this.executorGrants.get(runId) === pending) this.executorGrants.delete(runId);
    }).catch(() => undefined);
    return await pending;
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
      void this.respond(socket, buffer.slice(0, lineEnd));
    });
    socket.on("error", () => {});
  }

  async respond(socket: Socket, line: string) {
    let request: any;
    try { request = parseBrokerRequest(JSON.parse(line)); } catch { socket.destroy(); return; }
    try {
      const response = await this.dispatch(request, socket, { deferSubscription: request.method === "subscribe" });
      if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`, (error) => {
        if (error) return socket.destroy();
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
    socket.once("close", () => {
      subscribers.delete(socket);
      if (subscribers.size === 0) this.subscriptions.delete(callerRunId);
    });
  }

  activateSubscription(request: any, socket: Socket) {
    if (this.closed || socket.destroyed) return;
    const principal = this.principals.get(request.callerRunId);
    if (!principal || principal.callerToken !== request.callerToken) return;
    this.registerSubscription(request.callerRunId, socket);
    if (this.closed || socket.destroyed || this.principals.get(request.callerRunId)?.callerToken !== request.callerToken) return;
    try {
      socket.write(`${JSON.stringify({ schemaVersion: "pi-root-subagent-broker-push.v1", rootSessionId: this.rootSessionId, callerRunId: request.callerRunId, type: "subscription.ready", data: {} })}\n`);
    } catch { /* socket failure leaves the subscription unready */ }
  }

  async dispatch(request: any, socket: Socket, { deferSubscription = false }: { deferSubscription?: boolean } = {}) {
    if (this.closed) return failure(request, "root_closing", "Root session is closing");
    if (request.rootSessionId !== this.rootSessionId) return failure(request, "root_mismatch", "Root session does not match");
    const principal = this.principals.get(request.callerRunId);
    if (!principal || principal.callerToken !== request.callerToken) return failure(request, "caller_unauthorized", "Caller is not granted");
    try {
      if (request.method === "subscribe") {
        if (!deferSubscription) this.registerSubscription(request.callerRunId, socket);
        return createBrokerSuccessResponse({ ...request, data: { subscribed: true } });
      }
      if (request.method === "ping") return createBrokerSuccessResponse({ ...request, data: await this.upstream.ping() });
      return failure(request, "unsupported", `Broker method ${request.method} is unsupported`);
    } catch (error) {
      return failure(request, "upstream_failed", error instanceof Error ? error.message : String(error));
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
    this.announceClosing();
    const closing = (async () => {
      let startupTimeout: ReturnType<typeof setTimeout> | undefined;
      const startupDeadline = new Promise<never>((_, reject) => {
        startupTimeout = setTimeout(() => reject(new AggregateError([], "Root subagent broker startup barrier deadline exceeded")), this.terminalTimeoutMs);
      });
      try {
        for (;;) {
          const barrier = [...this.startedObservations.values(), ...this.executorGrants.values()];
          if (barrier.length === 0) break;
          await Promise.race([Promise.allSettled(barrier), startupDeadline]);
          await Promise.resolve();
        }
      } finally {
        if (startupTimeout) clearTimeout(startupTimeout);
      }

      const runs = [...this.ownedRuns.values()].filter((run) => this.forcePendingRuns.has(run.runId) || !this.terminalProofs.has(run.runId));
      const settled = await Promise.allSettled(runs.map((run) => this.drainRun(run)));
      const errors = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason);
      if (errors.length) throw new AggregateError(errors, "Root subagent broker executor drain failed");

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
      this.principals.clear();
      this.subscriptions.clear();
      this.sockets.clear();
      this.grantPaths.clear();
      this.executorGrants.clear();
      this.ownedRuns.clear();
      this.terminalProofs.clear();
      this.terminalConflicts.clear();
      this.forcePendingRuns.clear();
      this.terminalWaiters.clear();
      this.startedObservations.clear();
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
