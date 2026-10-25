// 只读观测 fixture：观测 Host 内 subagents RPC bridge 的会话生命周期证据。
// 约束：不注册任何工具、不改写任何事件语义；除自身一次 ping 外不向
// subagents:rpc:v1:request 发出任何请求；仅记录与落盘（路径来自
// PI_RPC_BRIDGE_OBSERVATION_OUTPUT），同时向 stderr 输出完整 JSON 备份。
import { writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";

const REQUEST_CHANNEL = "subagents:rpc:v1:request";
const READY_CHANNEL = "subagents:rpc:v1:ready";

export default function subagentRpcBridgeObservation(pi) {
  const observation = {
    fixture: "subagent-rpc-bridge-observation",
    pid: process.pid,
    loadedAt: new Date().toISOString(),
    env: {
      PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD ?? null,
      PI_SUBAGENT_FANOUT_CHILD: process.env.PI_SUBAGENT_FANOUT_CHILD ?? null,
      PI_ROOT_SUBAGENT_BROKER_ENABLED: process.env.PI_ROOT_SUBAGENT_BROKER_ENABLED ?? null,
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR ?? null,
      PI_CODING_WORKSPACE_DIR: process.env.PI_CODING_WORKSPACE_DIR ?? null,
    },
    // session_start 及所有可能调用 resetSessionState 的路径的触发记录。
    sessionLifecycle: [],
    // subagents:rpc:v1:ready 的触发记录（含 emit 时 ready 通道监听者数与 payload）。
    readyEvents: [],
    // patch 安装之后新注册到 request 通道的监听者（bridge 多注册检测辅助）。
    requestSubscriptions: [],
    // 每次 ping 的回执 / 超时原始记录。
    pings: [],
    // ping 发出时 request 通道的真实监听者计数（经底层 emitter 取证）。
    requestChannelAtPing: [],
    instrumentationError: null,
  };

  const outputPath = process.env.PI_RPC_BRIDGE_OBSERVATION_OUTPUT;
  const flush = () => {
    try { console.error(`[rpc-bridge-observation] ${JSON.stringify(observation)}`); } catch {}
    if (outputPath) {
      try { writeFileSync(outputPath, JSON.stringify(observation, null, 2)); } catch {}
    }
  };

  // 只读计数取证：pi eventBus 底座是 node EventEmitter（见
  // pi-coding-agent dist 内 createEventBus）。patch 仅在命中观测通道时
  // 记录 listenerCount / payload，随后原样转发，不改写任何行为。
  try {
    const proto = EventEmitter.prototype;
    const originalEmit = proto.emit;
    proto.emit = function (channel, data) {
      try {
        if (channel === READY_CHANNEL) {
          observation.readyEvents.push({
            at: new Date().toISOString(),
            readyListenerCount: this.listenerCount(READY_CHANNEL),
            payload: data,
          });
          flush();
        }
        if (channel === REQUEST_CHANNEL && data?.source?.probe === "rpc-bridge-observation") {
          observation.requestChannelAtPing.push({
            at: new Date().toISOString(),
            requestListenerCount: this.listenerCount(REQUEST_CHANNEL),
          });
          flush();
        }
      } catch (error) {
        observation.instrumentationError = String(error?.message ?? error);
      }
      return originalEmit.call(this, channel, data);
    };
    const originalOn = proto.on;
    proto.on = function (channel, handler) {
      if (channel === REQUEST_CHANNEL) {
        observation.requestSubscriptions.push({
          at: new Date().toISOString(),
          stack: String(new Error().stack).split("\n").slice(2, 6).join(" | "),
        });
        flush();
      }
      return originalOn.call(this, channel, handler);
    };
  } catch (error) {
    observation.instrumentationError = String(error?.message ?? error);
  }

  const ctxProjection = (ctx) => {
    const projection = {
      hasCtx: ctx != null,
      hasUI: ctx?.hasUI ?? null,
      hasSessionManager: ctx?.sessionManager != null,
      cwd: ctx?.cwd ?? null,
    };
    for (const [name, method] of [["sessionId", "getSessionId"], ["sessionFile", "getSessionFile"]]) {
      try { projection[name] = ctx?.sessionManager?.[method]?.() ?? null; }
      catch (error) { projection[name] = `error:${error?.message ?? error}`; }
    }
    return projection;
  };

  let pingSeq = 0;
  const ping = (label) => new Promise((resolve) => {
    const requestId = `obs-${label}-${process.pid}-${++pingSeq}`;
    const replyChannel = `subagents:rpc:v1:reply:${requestId}`;
    const record = (entry) => {
      observation.pings.push({ label, requestId, at: new Date().toISOString(), ...entry });
      flush();
    };
    let settled = false;
    const unsubscribe = pi.events.on(replyChannel, (reply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      record({ reply });
      resolve();
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      record({ timeoutMs: 3000 });
      try { unsubscribe?.(); } catch {}
      resolve();
    }, 3000);
    pi.events.emit(REQUEST_CHANNEL, {
      version: 1,
      requestId,
      method: "ping",
      source: { probe: "rpc-bridge-observation" },
    });
  });

  for (const type of ["session_start", "session_before_compact", "session_compact", "session_shutdown"]) {
    try {
      pi.on(type, (event, ctx) => {
        observation.sessionLifecycle.push({
          event: type,
          at: new Date().toISOString(),
          reason: event?.reason ?? null,
          ctx: ctxProjection(ctx),
        });
        flush();
        if (type === "session_start") void ping("session-start");
      });
    } catch (error) {
      observation.instrumentationError = String(error?.message ?? error);
    }
  }

  // 装载期 ping：bridge 若已注册则此刻即可应答（ping 不需要 active session）。
  void ping("load");
  flush();
}
