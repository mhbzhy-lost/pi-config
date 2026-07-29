import { randomBytes } from "node:crypto";
import { createServer, Socket } from "node:net";
import { rm } from "node:fs/promises";

import {
  brokerGrantPath,
  brokerSocketPath,
  createBrokerFailureResponse,
  createBrokerSuccessResponse,
  ensureBrokerSocketDirectory,
  parseBrokerRequest,
  setBrokerSocketPermissions,
  writeBrokerGrant,
} from "./root-broker-protocol.ts";

type Upstream = Record<string, (...args: any[]) => Promise<any>>;
type Caller = { planId: string; cwd: string; role: "plan-runner"; callerToken: string; ownedRunIds: Set<string> };

const FORBIDDEN_SPAWN_FIELDS = new Set(["caller", "root", "token", "parent", "depth", "path", "fanout", "callerRunId", "callerToken", "rootSessionId", "parentRunId", "parentDepth", "parentPath"]);

function failure(request: any, code: string, message: string) {
  return createBrokerFailureResponse({ requestId: request?.requestId ?? "invalid-request", rootSessionId: request?.rootSessionId ?? "invalid-root", callerRunId: request?.callerRunId ?? "invalid-caller", code, message });
}

export class RootBrokerServer {
  rootSessionId: string;
  upstream: Upstream;
  callers = new Map<string, Caller>();
  runOwners = new Map<string, string>();
  subscriptions = new Map<string, Set<Socket>>();
  grantPaths = new Set<string>();
  server: ReturnType<typeof createServer> | undefined;
  closed = false;

  constructor({ rootSessionId, upstream }: { rootSessionId: string; upstream: Upstream }) {
    this.rootSessionId = rootSessionId;
    this.upstream = upstream;
  }

  async start() {
    if (this.server) throw new Error("Root subagent broker is already started");
    await ensureBrokerSocketDirectory(this.rootSessionId);
    const socketPath = brokerSocketPath(this.rootSessionId);
    await rm(socketPath, { force: true });
    this.server = createServer((socket) => this.handleSocket(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(socketPath, resolve);
    });
    await setBrokerSocketPermissions(socketPath);
  }

  async grantCaller({ callerRunId, planId, cwd, role }: { callerRunId: string; planId: string; cwd: string; role: "plan-runner" }) {
    if (this.callers.has(callerRunId)) throw new Error("Root subagent broker caller is already granted");
    const callerToken = randomBytes(32).toString("hex");
    const caller: Caller = { planId, cwd, role, callerToken, ownedRunIds: new Set() };
    const grantPath = await writeBrokerGrant({ schemaVersion: "pi-root-subagent-broker-grant.v1", rootSessionId: this.rootSessionId, runId: callerRunId, callerToken, role });
    this.callers.set(callerRunId, caller);
    this.grantPaths.add(grantPath);
    return { callerToken };
  }

  handleSocket(socket: Socket) {
    let buffer = "";
    socket.on("data", async (chunk) => {
      buffer += chunk.toString();
      const lineEnd = buffer.indexOf("\n");
      if (lineEnd < 0) return;
      const line = buffer.slice(0, lineEnd);
      buffer = "";
      let request: any;
      try { request = parseBrokerRequest(JSON.parse(line)); } catch { socket.destroy(); return; }
      const response = await this.dispatch(request, socket);
      socket.write(`${JSON.stringify(response)}\n`);
      if (request.method !== "subscribe") socket.end();
    });
  }

  async dispatch(request: any, socket: Socket) {
    if (this.closed) return failure(request, "root_closing", "Root session is closing");
    if (request.rootSessionId !== this.rootSessionId) return failure(request, "root_mismatch", "Root session does not match");
    const caller = this.callers.get(request.callerRunId);
    if (!caller || caller.callerToken !== request.callerToken) return failure(request, "caller_unauthorized", "Caller is not granted");
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
    } catch (error) {
      return failure(request, "upstream_failed", error instanceof Error ? error.message : String(error));
    }
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
      if (typeof runId === "string") await this.upstream.stop({ runId, dir: asyncDir });
      return failure(request, "spawn_invalid", "Upstream spawn reply is missing runId or asyncDir");
    }
    try {
      const executorToken = randomBytes(32).toString("hex");
      const grantPath = await writeBrokerGrant({ schemaVersion: "pi-root-subagent-broker-grant.v1", rootSessionId: this.rootSessionId, runId, callerToken: executorToken, role: "executor" });
      this.grantPaths.add(grantPath);
      caller.ownedRunIds.add(runId);
      this.runOwners.set(runId, request.callerRunId);
    } catch (error) {
      await this.upstream.stop({ runId, dir: asyncDir });
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
    if (this.closed) return;
    this.closed = true;
    for (const [callerRunId, sockets] of this.subscriptions) {
      const push = { schemaVersion: "pi-root-subagent-broker-push.v1", rootSessionId: this.rootSessionId, callerRunId, type: "root.closing", data: {} };
      for (const socket of sockets) { socket.write(`${JSON.stringify(push)}\n`); socket.end(); }
    }
    await new Promise<void>((resolve) => this.server ? this.server.close(() => resolve()) : resolve());
    await rm(brokerSocketPath(this.rootSessionId), { force: true });
    await Promise.all([...this.grantPaths].map((grantPath) => rm(grantPath, { force: true })));
  }
}
