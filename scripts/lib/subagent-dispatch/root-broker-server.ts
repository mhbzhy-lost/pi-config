import { randomBytes } from "node:crypto";
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
type Caller = { planId: string; cwd: string; role: "plan-runner"; callerToken: string; ownedRunIds: Set<string> };
type Principal = { role: "plan-runner" | "executor"; callerToken: string };
type Dependencies = { writeGrant?: typeof writeBrokerGrant; randomToken?: () => string };

const FORBIDDEN_SPAWN_FIELDS = new Set(["caller", "root", "token", "parent", "depth", "path", "fanout", "callerRunId", "callerToken", "rootSessionId", "parentRunId", "parentDepth", "parentPath"]);
const MAX_BUFFER = 64 * 1024;

function failure(request: any, code: string, message: string) {
  return createBrokerFailureResponse({ requestId: request?.requestId ?? "invalid-request", rootSessionId: request?.rootSessionId ?? "invalid-root", callerRunId: request?.callerRunId ?? "invalid-caller", code, message: String(message).slice(0, 1024) || "Broker request failed" });
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
  server: ReturnType<typeof createServer> | undefined;
  closed = false;
  closePromise: Promise<void> | undefined;
  writeGrant: typeof writeBrokerGrant;
  randomToken: () => string;

  constructor({ rootSessionId, upstream, writeGrant = writeBrokerGrant, randomToken = () => randomBytes(32).toString("hex") }: { rootSessionId: string; upstream: Upstream } & Dependencies) {
    this.rootSessionId = rootSessionId;
    this.upstream = upstream;
    this.writeGrant = writeGrant;
    this.randomToken = randomToken;
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
    } catch (error) {
      this.server = undefined;
      await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
      await rm(socketPath, { force: true });
      throw error;
    }
  }

  async grantCaller({ callerRunId, planId, cwd, role }: { callerRunId: string; planId: string; cwd: string; role: unknown }) {
    if (role !== "plan-runner" || typeof planId !== "string" || planId.length === 0 || typeof cwd !== "string" || cwd.length === 0 || !path.isAbsolute(cwd)) {
      throw new Error("Root subagent broker caller grant is invalid");
    }
    if (this.callers.has(callerRunId)) throw new Error("Root subagent broker caller is already granted");
    const callerToken = this.randomToken();
    const caller: Caller = { planId, cwd, role, callerToken, ownedRunIds: new Set() };
    const grantPath = await this.writeGrant({ schemaVersion: "pi-root-subagent-broker-grant.v1", rootSessionId: this.rootSessionId, runId: callerRunId, callerToken, role });
    this.callers.set(callerRunId, caller);
    this.principals.set(callerRunId, { role, callerToken });
    this.grantPaths.add(grantPath);
    return { callerToken };
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
        return createBrokerSuccessResponse({ ...request, data: { ...data, session: { ...(data?.session ?? {}), cwd: caller.cwd } } });
      }
      if (request.method === "spawn") return await this.spawn(request, caller);
      if (["status", "steer", "interrupt", "stop"].includes(request.method)) return await this.control(request, caller);
      return failure(request, "unsupported", `Broker method ${request.method} is unsupported`);
    } catch (error) { return failure(request, "upstream_failed", error instanceof Error ? error.message : String(error)); }
  }

  async spawn(request: any, caller: Caller) {
    const params = request.params;
    if (caller.role !== "plan-runner" || !["executor", "spark"].includes(params.agent)) return failure(request, "spawn_unauthorized", "Caller may only spawn executor or spark");
    for (const key of Object.keys(params)) if (FORBIDDEN_SPAWN_FIELDS.has(key)) return failure(request, "spawn_invalid", `Spawn parameter ${key} is forbidden`);
    const reply = await this.upstream.spawn({ ...params, async: true, clarify: false });
    const details = reply?.details ?? reply;
    const runId = details?.runId;
    const asyncDir = details?.asyncDir;
    if (typeof runId !== "string" || typeof asyncDir !== "string") {
      if (typeof runId === "string") await this.upstream.stop({ runId, dir: asyncDir }).catch(() => undefined);
      return failure(request, "spawn_invalid", "Upstream spawn reply is missing runId or asyncDir");
    }
    try {
      const callerToken = this.randomToken();
      const grantPath = await this.writeGrant({ schemaVersion: "pi-root-subagent-broker-grant.v1", rootSessionId: this.rootSessionId, runId, callerToken, role: "executor" });
      this.grantPaths.add(grantPath);
      this.principals.set(runId, { role: "executor", callerToken });
      caller.ownedRunIds.add(runId);
      this.runOwners.set(runId, request.callerRunId);
    } catch (error) {
      try { await this.upstream.stop({ runId, dir: asyncDir }); } catch (stopError) { return failure(request, "spawn_cleanup", stopError instanceof Error ? stopError.message : String(stopError)); }
      return failure(request, "spawn_cleanup", error instanceof Error ? error.message : String(error));
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
    this.closePromise = (async () => {
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
    })();
    return this.closePromise;
  }
}
