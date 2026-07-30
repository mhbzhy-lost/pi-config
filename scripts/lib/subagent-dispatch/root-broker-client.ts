import { randomUUID } from "node:crypto";
import { connect, Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";

import {
  BROKER_FRAME_LIMIT_BYTES,
  brokerSocketPath,
  parseBrokerPush,
  parseBrokerResponse,
  readBrokerGrant,
  type BrokerPush,
} from "./root-broker-protocol.ts";

type ClientOptions = {
  rootSessionId: string;
  callerRunId: string;
  timeoutMs?: number;
  randomUUID?: () => string;
};

type Subscription = { dispose(): void; closed: Promise<void> };

function clientError(message: string, code?: string) {
  const error = new Error(message);
  if (code) (error as Error & { code?: string }).code = code;
  return error;
}

function safeRequestId(createId: () => string) {
  const id = createId();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(id)) throw clientError("Broker request id is invalid", "REQUEST_ID_INVALID");
  return id;
}

export function createBrokerFrameDecoder() {
  let buffer = "";
  const decoder = new StringDecoder("utf8");
  return {
    push(chunk: Buffer | string) {
      buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
      const lines: string[] = [];
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(`${line}\n`, "utf8") > BROKER_FRAME_LIMIT_BYTES) throw clientError("Root broker subscription is too large", "BROKER_RESPONSE_TOO_LARGE");
        lines.push(line);
      }
      if (Buffer.byteLength(buffer, "utf8") > BROKER_FRAME_LIMIT_BYTES) throw clientError("Root broker subscription is too large", "BROKER_RESPONSE_TOO_LARGE");
      return lines;
    },
  };
}

export function createRootBrokerClient({ rootSessionId, callerRunId, timeoutMs = 10_000, randomUUID: createId = randomUUID }: ClientOptions) {
  let disposed = false;
  const sockets = new Set<Socket>();
  const pending = new Set<(error: Error) => void>();
  const subscriptions = new Set<{ dispose(): void }>();

  const assertLive = () => {
    if (disposed) throw clientError("Root broker client is disposed", "CLIENT_DISPOSED");
  };

  const grant = async () => {
    try {
      return await readBrokerGrant(rootSessionId, callerRunId);
    } catch (error: any) {
      if (error?.code === "ENOENT") throw clientError("Root broker grant is not ready", "GRANT_NOT_READY");
      throw clientError(`Root broker grant is unavailable: ${error instanceof Error ? error.message : String(error)}`, "GRANT_INVALID");
    }
  };

  const envelope = async (method: string, params: Record<string, unknown>, requestId?: string) => {
    const current = await grant();
    assertLive();
    return {
      schemaVersion: "pi-root-subagent-broker-request.v1",
      requestId: requestId === undefined ? safeRequestId(createId) : safeRequestId(() => requestId),
      rootSessionId,
      callerRunId,
      callerToken: current.callerToken,
      method,
      params,
    };
  };

  const request = async (method: string, params: Record<string, unknown> = {}, options: { requestId?: string } = {}) => {
    assertLive();
    const value = await envelope(method, params, options.requestId);
    return await new Promise<unknown>((resolve, reject) => {
      const socket = connect(brokerSocketPath(rootSessionId));
      sockets.add(socket);
      let buffer = "";
      let settled = false;
      const finish = (error?: Error, data?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sockets.delete(socket);
        pending.delete(rejectPending);
        socket.destroy();
        if (error) reject(error); else resolve(data);
      };
      const rejectPending = (error: Error) => finish(error);
      pending.add(rejectPending);
      const timer = setTimeout(() => finish(clientError("Root broker request timed out", "BROKER_TIMEOUT")), timeoutMs);
      socket.once("error", (error) => finish(clientError(`Root broker disconnected: ${error.message}`, "BROKER_DISCONNECTED")));
      socket.once("close", () => { if (!settled) finish(clientError("Root broker disconnected before response", "BROKER_DISCONNECTED")); });
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (Buffer.byteLength(buffer, "utf8") > BROKER_FRAME_LIMIT_BYTES) return finish(clientError("Root broker response is too large", "BROKER_RESPONSE_TOO_LARGE"));
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        let response;
        try { response = parseBrokerResponse(JSON.parse(buffer.slice(0, newline)), value); } catch (error) { finish(error as Error); return; }
        if (!response.success) finish(clientError(response.error.message, response.error.code));
        else finish(undefined, response.data);
      });
      socket.once("connect", () => socket.write(`${JSON.stringify(value)}\n`));
    });
  };

  const subscribe = async (onPush: (push: BrokerPush) => void): Promise<Subscription> => {
    assertLive();
    if (typeof onPush !== "function") throw new TypeError("Broker subscription requires an onPush callback");
    const value = await envelope("subscribe", {});
    return await new Promise<Subscription>((resolve, reject) => {
      const socket = connect(brokerSocketPath(rootSessionId));
      sockets.add(socket);
      const decoder = createBrokerFrameDecoder();
      let acknowledged = false;
      let localDispose = false;
      let settleClosed!: () => void;
      let rejectClosed!: (error: Error) => void;
      const closed = new Promise<void>((resolveClosed, rejectClosedPromise) => { settleClosed = resolveClosed; rejectClosed = rejectClosedPromise; });
      const cleanup = () => sockets.delete(socket);
      const fail = (error: Error) => {
        cleanup();
        if (!acknowledged) {
          subscriptions.delete(handle);
          reject(error);
        }
        else if (localDispose) settleClosed();
        else rejectClosed(error);
      };
      const handle = {
        dispose() {
          if (localDispose) return;
          localDispose = true;
          subscriptions.delete(handle);
          socket.end();
        },
        closed,
      };
      subscriptions.add(handle);
      socket.once("error", (error) => fail(clientError(`Root broker disconnected: ${error.message}`, "BROKER_DISCONNECTED")));
      socket.once("close", () => fail(clientError("Root broker subscription disconnected", "BROKER_DISCONNECTED")));
      socket.on("data", (chunk) => {
        let lines: string[];
        try { lines = decoder.push(chunk); } catch (error) { socket.destroy(error as Error); return; }
        for (const line of lines) {
          try {
            if (!acknowledged) {
              const response = parseBrokerResponse(JSON.parse(line), value);
              if (!response.success) throw clientError(response.error.message, response.error.code);
              acknowledged = true;
              resolve(handle);
            } else {
              const push = parseBrokerPush(JSON.parse(line));
              if (push.rootSessionId !== rootSessionId || push.callerRunId !== callerRunId) throw clientError("Broker push identity does not match", "BROKER_IDENTITY_MISMATCH");
              onPush(push);
            }
          } catch (error) { socket.destroy(error as Error); }
        }
      });
      socket.once("connect", () => socket.write(`${JSON.stringify(value)}\n`));
    });
  };

  const api = {
    ping: () => request("ping"),
    spawn: (params: Record<string, unknown>, options: { requestId?: string; spawnKey?: string } = {}) => {
      const { spawnKey: _modelSpawnKey, ...clean } = params;
      return request("spawn", { ...clean, async: true, clarify: false, ...(options.spawnKey !== undefined ? { spawnKey: options.spawnKey } : {}) }, options);
    },
    lookupSpawn: ({ spawnKey }: { spawnKey: string }) => request("spawn.lookup", { spawnKey }),
    status: (params: Record<string, unknown>) => request("status", params),
    steer: (params: Record<string, unknown>) => request("steer", params),
    interrupt: (params: Record<string, unknown>) => request("interrupt", params),
    stop: (params: Record<string, unknown>) => request("stop", params),
    supervisorPending: () => request("supervisor.pending"),
    supervisorReply: (params: Record<string, unknown>) => request("supervisor.reply", params),
    callerFollowUp: (params: Record<string, unknown>) => request("caller.followup", params),
    subscribe,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const reject of pending) reject(clientError("Root broker client is disposed", "CLIENT_DISPOSED"));
      pending.clear();
      for (const subscription of subscriptions) subscription.dispose();
      subscriptions.clear();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
  };
  return Object.freeze(api);
}
