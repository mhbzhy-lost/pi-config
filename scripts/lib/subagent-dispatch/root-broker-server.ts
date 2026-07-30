import { createHash, randomBytes } from "node:crypto";
import { createServer, Socket } from "node:net";
import { rm } from "node:fs/promises";
import path from "node:path";

import {
  brokerSocketPath,
  createBrokerFailureResponse,
  createBrokerSuccessResponse,
  ensureBrokerSocketDirectory,
  parseBrokerRequest,
  setBrokerSocketPermissions,
  writeBrokerGrant,
} from "./root-broker-protocol.ts";

type Upstream = Record<string, (...args: any[]) => Promise<any>> & { dispose?: () => void | Promise<void> };
type Caller = { planId: string; cwd: string; originRoot: string; stateRoot: string; role: "plan-runner"; callerToken: string; ownedRunIds: Set<string> };
type Principal = { role: "plan-runner" | "executor"; callerToken: string };
type Dependencies = { writeGrant?: typeof writeBrokerGrant; randomToken?: () => string; events?: { on(channel: string, listener: (event: any) => void): () => void } };
type SpawnLedgerEntry = { hash: string; state: "not-started" | "spawning" | "spawned" | "cleaned" | "uncertain"; promise?: Promise<any>; reply?: any; binding?: any };

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
  unsubscribeStarted: (() => void) | undefined;
  server: ReturnType<typeof createServer> | undefined;
  closed = false;
  closePromise: Promise<void> | undefined;
  writeGrant: typeof writeBrokerGrant;
  randomToken: () => string;
  events: Dependencies["events"];

  constructor({ rootSessionId, upstream, writeGrant = writeBrokerGrant, randomToken = () => randomBytes(32).toString("hex"), events }: { rootSessionId: string; upstream: Upstream } & Dependencies) {
    this.rootSessionId = rootSessionId;
    this.upstream = upstream;
    this.writeGrant = writeGrant;
    this.randomToken = randomToken;
    this.events = events;
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
      this.unsubscribeStarted = this.events?.on("subagent:async-started", (event) => {
        const runId = event?.runId ?? event?.id;
        if (typeof runId === "string" && ["executor", "spark"].includes(event?.agent)) {
          void this.ensureExecutorOwner(runId).catch(() => undefined);
        }
      });
    } catch (error) {
      this.server = undefined;
      await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
      await rm(socketPath, { force: true });
      throw error;
    }
  }

  async ensureExecutorOwner(runId: string) {
    if (this.closed) throw new Error("Root subagent broker is closing");
    const existing = this.executorGrants.get(runId);
    if (existing) return existing;
    const pending = (async () => {
      if (this.principals.has(runId)) throw new Error("Root subagent broker principal is already granted");
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
    try { return await pending; } catch (error) { this.executorGrants.delete(runId); throw error; }
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
        return createBrokerSuccessResponse({ ...request, data: { ...data, session: { ...(data?.session ?? {}), cwd: caller.cwd }, planRuntime: { originRoot: caller.originRoot, stateRoot: caller.stateRoot } } });
      }
      if (request.method === "spawn") return await this.spawn(request, caller);
      if (request.method === "spawn.lookup") return this.lookupSpawn(request, caller);
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
    return await this.startSpawn(request, caller, normalizedSpawn(params), key, { hash, state: "not-started" });
  }

  async startSpawn(request: any, caller: Caller, params: Record<string, unknown>, key: string, entry: SpawnLedgerEntry) {
    entry.state = "spawning";
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
    }
    return createBrokerSuccessResponse({ ...request, data: reply });
  }

  async control(request: any, caller: Caller) {
    const runId = request.params.runId ?? request.params.id;
    if (typeof runId !== "string" || !caller.ownedRunIds.has(runId) || this.runOwners.get(runId) !== request.callerRunId) return failure(request, "run_not_owned", "Run is not owned by caller");
    return createBrokerSuccessResponse({ ...request, data: await this.upstream[request.method](request.params) });
  }

  async closeRootSession() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.unsubscribeStarted?.();
    this.unsubscribeStarted = undefined;
    this.closePromise = (async () => {
      try {
        await Promise.allSettled([...this.executorGrants.values(), ...this.callerGrants.values()]);
        for (const [callerRunId, sockets] of this.subscriptions) {
          const push = { schemaVersion: "pi-root-subagent-broker-push.v1", rootSessionId: this.rootSessionId, callerRunId, type: "root.closing", data: {} };
          for (const socket of sockets) if (!socket.destroyed) socket.write(`${JSON.stringify(push)}\n`);
        }
        for (const socket of this.sockets) if (!socket.destroyed) socket.end();
        setTimeout(() => { for (const socket of this.sockets) if (!socket.destroyed) socket.destroy(); }, 25).unref?.();
        await new Promise<void>((resolve) => this.server ? this.server.close(() => resolve()) : resolve());
        try {
          await rm(brokerSocketPath(this.rootSessionId), { force: true });
          await Promise.all([...this.grantPaths].map((grantPath) => rm(grantPath, { force: true })));
        } finally {
          await this.upstream.dispose?.();
        }
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
      }
    })();
    return this.closePromise;
  }
}
