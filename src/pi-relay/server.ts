/**
 * ECS 中继服务端：TLS socket 层字节透明反向代理（多 agent）。
 * - 终止手机侧 TLS 后按连接做一次性路由/设备鉴权，随后原始 HTTP 字节经 WSS 数据通道直通对应 Mac 的 pi-web；
 * - /api/sessions 中继本地拦截：并行拉取全部获批在线主机的会话拍平合并（逐会话附 host/hostName/lan 直连基址）；
 * - 设备配对（/pair + /pair-status）与批准状态经控制连接往返对应 agent，中继不落盘任何设备凭据；
 *   Cookie 多主机映射（v2）兼容 v1 单条目（host-1）；批准权威在各 Mac 本机；
 * - 控制连接任何原因关闭只清名下通道/pending/配对桶，不波及其他主机；
 * - 日志只含事件类别与 channel id，不含 URL/query/Cookie/token 等任何凭据材料。
 */
import { randomBytes, randomInt } from "node:crypto";
import { IncomingMessage } from "node:http";
import { createServer as createTlsServer, type TLSSocket } from "node:tls";
import { Buffer } from "node:buffer";
import { WebSocketServer, type WebSocket } from "ws";
import {
  AUTH_FAIL_MAX_PER_IP_PER_MIN,
  AUTH_TIMEOUT_MS,
  BACKPRESSURE_CHECK_MS,
  BACKPRESSURE_HIGH_BYTES,
  CHANNEL_IDLE_MS,
  CHANNEL_TTL_MS,
  CLOSE_AGENT_TOKEN_INVALID,
  CLOSE_CHANNEL_INVALID,
  DEVICE_COOKIE_MAX_AGE,
  DEVICE_COOKIE_NAME,
  DEVICE_ID_BYTES,
  DEVICE_SECRET_BYTES,
  HEADER_MAX_BYTES,
  HEADER_TIMEOUT_MS,
  HEARTBEAT_PING_MS,
  HEARTBEAT_TIMEOUT_MS,
  LEGACY_AGENT_ID,
  MAX_AGENTS,
  MAX_DATA_CHANNELS,
  MAX_GLOBAL_DATA_CHANNELS,
  MAX_GLOBAL_PENDING_CHANNELS,
  MAX_PENDING_CHANNELS,
  MAX_WS_MESSAGE_BYTES,
  PAIR_MAX_GLOBAL,
  PAIR_MAX_PER_IP_PER_MIN,
  PAIR_TTL_MS,
  PREAUTH_MAX_PER_IP,
  normalizeIp,
  safeEqualHex,
  sha256Hex,
  type DownMessage,
  type LanInfo,
  type SessionBrief,
  type UpMessage,
} from "./protocol.ts";
import { loadServerConfig, type AgentEntry } from "./server-config.ts";
import { readCaPem, readServerCert } from "./certs.ts";

type PendingChannel = { browser: TLSSocket; head: Buffer; deviceId: string; timer: NodeJS.Timeout };
type ActiveChannel = { browser: TLSSocket; dataWs: WebSocket; deviceId: string; idleTimer: NodeJS.Timeout };
type Waiter = { resolve: (msg: UpMessage | null) => void; timer: NodeJS.Timeout };
type PairEntry = { secret: string; code: string; ua: string; ip: string; ts: number; timer: NodeJS.Timeout };

/** Cookie 映射：agentId → 设备凭据（v1 归一化为 host-1 单条目） */
type DeviceCookie = Map<string, { id: string; secret: string }>;

type ControlState = {
  ws: WebSocket;
  agentId: string;
  label: string | null;
  hostname: string | null;
  ip: string;
  lan: LanInfo | null;
  pending: Map<string, PendingChannel>;
  active: Map<string, ActiveChannel>;
  waiters: Map<string, Waiter>;
  pingTimer: NodeJS.Timeout;
  lastPong: number;
};

function log(event: string, channel?: string): void {
  console.error(`[pi-relay] ${event}${channel ? ` channel=${channel}` : ""}`);
}

/** 简单滑动窗口计数（内存，60s 窗口） */
function hitWindow(map: Map<string, number[]>, key: string, limit: number): boolean {
  const now = Date.now();
  const list = (map.get(key) ?? []).filter((ts) => now - ts < 60_000);
  list.push(now);
  map.set(key, list);
  return list.length > limit;
}

function parseHead(head: Buffer): { method: string; target: string; headers: Record<string, string> } | null {
  const text = head.toString("latin1");
  const lines = text.split("\r\n");
  const requestLine = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(lines[0] ?? "");
  if (!requestLine) return null;
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return { method: requestLine[1]!, target: requestLine[2]!, headers };
}

function cookieValue(headers: Record<string, string>, name: string): string | null {
  const raw = headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

const COOKIE_ID_RE = /^[0-9a-f]{16}$/;
const COOKIE_SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const AGENT_ID_RE = /^(?:[0-9a-f]{8}|host-1)$/;

/** 解析设备 Cookie：v1 `<id>.<secret>` 归一化为 host-1；v2 `v2.<base64url(JSON映射)>`；非法返回 null */
function parseDeviceCookie(headers: Record<string, string>): DeviceCookie | null {
  const raw = cookieValue(headers, DEVICE_COOKIE_NAME);
  if (!raw) return null;
  const v1 = /^([0-9a-f]{16})\.([A-Za-z0-9_-]{43})$/.exec(raw);
  if (v1) return new Map([[LEGACY_AGENT_ID, { id: v1[1]!, secret: v1[2]! }]]);
  if (!raw.startsWith("v2.")) return null;
  try {
    const obj = JSON.parse(Buffer.from(raw.slice(3), "base64url").toString("utf8")) as Record<string, unknown>;
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    const entries = Object.entries(obj);
    if (entries.length === 0 || entries.length > MAX_AGENTS) return null;
    const map: DeviceCookie = new Map();
    for (const [agentId, value] of entries) {
      if (!AGENT_ID_RE.test(agentId) || !value || typeof value !== "object") return null;
      const { id, secret } = value as Record<string, unknown>;
      if (typeof id !== "string" || !COOKIE_ID_RE.test(id) || typeof secret !== "string" || !COOKIE_SECRET_RE.test(secret)) return null;
      map.set(agentId, { id, secret });
    }
    return map;
  } catch {
    return null;
  }
}

function serializeDeviceCookie(map: DeviceCookie): string {
  const obj: Record<string, { id: string; secret: string }> = {};
  for (const [agentId, value] of map) obj[agentId] = value;
  return `v2.${Buffer.from(JSON.stringify(obj), "utf8").toString("base64url")}`;
}

function setCookieHeader(value: string): string {
  return `${DEVICE_COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${DEVICE_COOKIE_MAX_AGE}`;
}

/** HTML 转义（hostname/label/UA 等不可信文本进页面统一走这里） */
function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** 清洗控制字符并截断（hostname 来自 agent 上报，进页面另经 escapeHtml） */
function cleanHostname(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64);
  return cleaned.length > 0 ? cleaned : null;
}

/** 多主机在线时的 /pair 主机选择页（唯一保留选主机的地方：批准权威在各 Mac） */
function hostSelectPage(agents: Array<{ id: string; name: string }>): string {
  const items = agents.map((a) => `<a class="host" href="/pair?host=${encodeURIComponent(a.id)}">${escapeHtml(a.name)}<span class="go">配对 →</span></a>`).join("\n");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pi · 选择主机</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#101014;color:#d8d8e0;font:15px -apple-system,sans-serif}
.box{max-width:420px;width:100%;padding:32px 24px}
h1{font-size:18px;margin:0 0 6px}
p{color:#6a6a78;font-size:12px;line-height:1.6;margin:0 0 16px}
.host{display:flex;justify-content:space-between;align-items:center;background:#17171d;border:1px solid #26262e;border-radius:12px;padding:14px;margin-bottom:10px;color:#d8d8e0;text-decoration:none;font:600 15px ui-monospace,Menlo,monospace}
.host:active{background:#1e1e26}
.go{color:#4a6a95;font:14px -apple-system,sans-serif}
</style></head><body><div class="box"><h1>选择要配对的主机</h1>
<p>设备批准由各主机独立管理：选择后在该主机的终端核对配对码并批准。</p>
${items}</div></body></html>`;
}

const HTTP_REASON: Record<number, string> = {
  200: "OK",
  302: "Found",
  401: "Unauthorized",
  404: "Not Found",
  429: "Too Many Requests",
  503: "Service Unavailable",
};

function respond(socket: TLSSocket, status: number, headers: Record<string, string>, body: string | Buffer): void {
  const payload = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  const lines = [`HTTP/1.1 ${status} ${HTTP_REASON[status] ?? "OK"}`];
  for (const [key, value] of Object.entries(headers)) lines.push(`${key}: ${value}`);
  lines.push(`Content-Length: ${payload.length}`, "Connection: close", "", "");
  socket.end(Buffer.concat([Buffer.from(lines.join("\r\n"), "latin1"), payload]));
}

function respondJson(socket: TLSSocket, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  respond(socket, status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders }, JSON.stringify(value));
}

function redirect(socket: TLSSocket, location: string, extraHeaders: Record<string, string> = {}): void {
  respond(socket, 302, { Location: location, ...extraHeaders }, "");
}

function pairPage(id: string, code: string, ua: string, offline: boolean, hostName: string | null): string {
  const escapedUa = escapeHtml(ua);
  const hostLine = hostName ? `<p class="ua">主机：${escapeHtml(hostName)}</p>` : "";
  const body = offline
    ? `<p class="msg">本机离线，请稍后再试。</p>`
    : `<p>请在${hostName ? `主机 <b>${escapeHtml(hostName)}</b> 的` : "本机"}终端核对配对码后批准：</p>
  <div class="code">${code}</div>
  <p class="ua">设备：${escapedUa}</p>${hostLine}
  <p class="msg" id="msg">等待批准中…（在对应主机运行 node scripts/pi-relay.ts devices 查看）</p>
  <script>
  var id = ${JSON.stringify(id)};
  var timer = setInterval(function () {
    fetch("/pair-status?id=" + encodeURIComponent(id)).then(function (r) { return r.json(); }).then(function (d) {
      if (d.status === "approved") { clearInterval(timer); location.replace(d.redirect || "/"); }
      else if (d.status === "denied") { clearInterval(timer); document.getElementById("msg").textContent = "本机已拒绝此设备的配对请求。"; }
      else if (d.status === "expired") { clearInterval(timer); document.getElementById("msg").innerHTML = "配对已过期，请<a href=\\"/pair\\">重新配对</a>。"; }
    }).catch(function () {});
  }, 2000);
  </script>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="pair-id" content="${id}">
<title>pi · 设备配对</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#101014;color:#d8d8e0;font:15px -apple-system,sans-serif}
.box{max-width:420px;padding:32px 24px;text-align:center}
.code{font:700 40px ui-monospace,Menlo,monospace;letter-spacing:10px;margin:18px 0;color:#7ec98f}
.ua{font-size:12px;color:#6a6a78;word-break:break-all}
.msg{color:#9a9ab0;line-height:1.7}
a{color:#4a6a95}
</style></head><body><div class="box"><h1>pi 设备配对</h1>${body}</div></body></html>`;
}

export async function startRelayServer(root: string): Promise<{ close: () => Promise<void> }> {
  const config = await loadServerConfig(root);
  const [{ key, cert }, caPem] = await Promise.all([readServerCert(root), readCaPem(root)]);
  const caBytes = Buffer.from(caPem, "utf8");

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_MESSAGE_BYTES });
  /** 多 agent 控制连接：agentId → 状态（同 id 重连只替换自己） */
  const controls = new Map<string, ControlState>();
  /** 配对表按 agent 分桶；某 agent 死亡只清自己的桶 */
  const pairBuckets = new Map<string, Map<string, PairEntry>>();
  const authFails = new Map<string, number[]>();
  const pairCreates = new Map<string, number[]>();
  const preauthCount = new Map<string, number>();
  const liveSockets = new Set<TLSSocket>();
  let reqSeq = 0;

  const agentByToken = (token: string): AgentEntry | null => {
    for (const agent of config.agents) {
      if (safeEqualHex(token, agent.token)) return agent;
    }
    return null;
  };
  const displayName = (agentId: string): string => {
    const agent = config.agents.find((a) => a.id === agentId);
    const state = controls.get(agentId);
    return agent?.label ?? state?.hostname ?? agentId;
  };
  const totalPendingPairs = (): number => {
    let n = 0;
    for (const bucket of pairBuckets.values()) n += bucket.size;
    return n;
  };
  const allPairEntries = (): Array<[string, PairEntry]> => {
    const out: Array<[string, PairEntry]> = [];
    for (const bucket of pairBuckets.values()) out.push(...bucket.entries());
    return out;
  };
  const globalChannelCounts = (): { active: number; pending: number } => {
    let active = 0;
    let pending = 0;
    for (const state of controls.values()) {
      active += state.active.size;
      pending += state.pending.size;
    }
    return { active, pending };
  };

  const send = (state: ControlState, msg: DownMessage): boolean => {
    if (state.ws.readyState !== state.ws.OPEN) return false;
    try {
      state.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  };

  /** 经指定 agent 控制连接请求-应答（auth/pair-check/list-sessions），超时/控制死亡返回 null */
  const request = (state: ControlState, msg: DownMessage & { req: string }): Promise<UpMessage | null> => {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        state.waiters.delete(msg.req);
        resolve(null);
      }, AUTH_TIMEOUT_MS);
      state.waiters.set(msg.req, { resolve, timer });
      if (!send(state, msg)) {
        clearTimeout(timer);
        state.waiters.delete(msg.req);
        resolve(null);
      }
    });
  };

  const destroyChannel = (channelId: string, entry: PendingChannel | ActiveChannel): void => {
    if ("timer" in entry) clearTimeout(entry.timer);
    if ("idleTimer" in entry) clearTimeout(entry.idleTimer);
    entry.browser.destroy();
    if ("dataWs" in entry) {
      try {
        entry.dataWs.terminate();
      } catch {
        // 忽略
      }
    }
    log("channel-closed", channelId);
  };

  /** 控制连接任何原因关闭/被替换：只清名下通道、pending、waiters 与自己的配对桶 */
  const cleanupControl = (state: ControlState): void => {
    clearInterval(state.pingTimer);
    for (const [id, entry] of state.pending) destroyChannel(id, entry);
    state.pending.clear();
    for (const [id, entry] of state.active) destroyChannel(id, entry);
    state.active.clear();
    for (const waiter of state.waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
    state.waiters.clear();
    const bucket = pairBuckets.get(state.agentId);
    if (bucket) {
      for (const entry of bucket.values()) clearTimeout(entry.timer);
      pairBuckets.delete(state.agentId);
    }
    if (controls.get(state.agentId) === state) controls.delete(state.agentId);
    try {
      state.ws.terminate();
    } catch {
      // 忽略
    }
    log("control-closed");
  };

  /** TCP→WS 背压：bufferedAmount 超高则 pause，定时检查回落后 resume（ws 无 drain 事件） */
  const pipeSocketToWs = (socket: TLSSocket, ws: WebSocket, onBytes: () => void): void => {
    let checkTimer: NodeJS.Timeout | null = null;
    socket.on("data", (chunk: Buffer) => {
      if (ws.readyState !== ws.OPEN) {
        socket.destroy();
        return;
      }
      ws.send(chunk);
      onBytes();
      if (ws.bufferedAmount > BACKPRESSURE_HIGH_BYTES && !checkTimer) {
        socket.pause();
        checkTimer = setInterval(() => {
          if (ws.bufferedAmount <= BACKPRESSURE_HIGH_BYTES || ws.readyState !== ws.OPEN) {
            if (checkTimer) clearInterval(checkTimer);
            checkTimer = null;
            socket.resume();
          }
        }, BACKPRESSURE_CHECK_MS);
      }
    });
    socket.on("close", () => {
      if (checkTimer) clearInterval(checkTimer);
    });
  };

  /** WS→TCP 背压：write 返回 false 则 ws.pause，drain 后 resume */
  const pipeWsToSocket = (ws: WebSocket, socket: TLSSocket, onBytes: () => void): void => {
    ws.on("message", (data: Buffer) => {
      onBytes();
      if (!socket.write(data)) ws.pause();
    });
    socket.on("drain", () => ws.resume());
  };

  const pairDataChannel = (state: ControlState, channelId: string, dataWs: WebSocket): void => {
    const entry = state.pending.get(channelId);
    if (!entry) {
      dataWs.close(CLOSE_CHANNEL_INVALID, "channel 无效");
      return;
    }
    state.pending.delete(channelId);
    clearTimeout(entry.timer);
    const { browser, head, deviceId } = entry;
    const resetIdle = (): void => {
      clearTimeout(active.idleTimer);
      active.idleTimer = setTimeout(() => {
        state.active.delete(channelId);
        destroyChannel(channelId, active);
      }, CHANNEL_IDLE_MS);
    };
    const active: ActiveChannel = { browser, dataWs, deviceId, idleTimer: setTimeout(() => {}, 0) };
    clearTimeout(active.idleTimer);
    state.active.set(channelId, active);
    resetIdle();
    const cleanup = (): void => {
      if (state.active.delete(channelId)) destroyChannel(channelId, active);
    };
    // agent 侧优雅关闭（pi-web Connection: close 响应已完整）：等浏览器侧缓冲字节 flush
    // 再 end，避免 destroy 丢弃未发送字节 → chunked 截断；error/其余路径仍立即切断。
    dataWs.on("close", () => {
      if (!state.active.delete(channelId)) return;
      clearTimeout(active.idleTimer);
      const guard = setTimeout(() => browser.destroy(), 5_000);
      const finish = (): void => {
        if (browser.destroyed) {
          clearTimeout(guard);
          return;
        }
        if (browser.writableLength > 0) {
          browser.once("drain", finish);
          return;
        }
        clearTimeout(guard);
        browser.end();
      };
      finish();
      log("channel-closed", channelId);
    });
    dataWs.on("error", cleanup);
    browser.on("close", cleanup);
    browser.on("error", cleanup);
    pipeSocketToWs(browser, dataWs, resetIdle);
    pipeWsToSocket(dataWs, browser, resetIdle);
    // 已缓冲的头部（及紧随的 body 字节）原样写入数据通道，随后全字节直通
    dataWs.send(head);
    browser.resume();
    log("channel-open", channelId);
  };

  const handleControlUpgrade = (req: IncomingMessage, socket: TLSSocket, head: Buffer, ip: string, agent: AgentEntry): void => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      const old = controls.get(agent.id);
      if (old) cleanupControl(old);
      const state: ControlState = {
        ws,
        agentId: agent.id,
        label: agent.label ?? null,
        hostname: null,
        ip,
        lan: null,
        pending: new Map(),
        active: new Map(),
        waiters: new Map(),
        pingTimer: setInterval(() => {
          if (Date.now() - state.lastPong > HEARTBEAT_TIMEOUT_MS) {
            ws.terminate();
            return;
          }
          try {
            ws.ping();
          } catch {
            // 忽略
          }
        }, HEARTBEAT_PING_MS),
        lastPong: Date.now(),
      };
      controls.set(agent.id, state);
      ws.on("pong", () => {
        state.lastPong = Date.now();
      });
      ws.on("message", (raw) => {
        let msg: UpMessage;
        try {
          msg = JSON.parse(String(raw)) as UpMessage;
        } catch {
          return;
        }
        if (msg.type === "hello") {
          state.lan = msg.lan && typeof msg.lan.host === "string" && typeof msg.lan.port === "number" && typeof msg.lan.token === "string" ? msg.lan : null;
          state.hostname = cleanHostname(msg.hostname);
          log("agent-hello");
        } else if (msg.type === "auth-result" || msg.type === "pair-check-result" || msg.type === "sessions-result") {
          const waiter = state.waiters.get(msg.req);
          if (waiter) {
            state.waiters.delete(msg.req);
            clearTimeout(waiter.timer);
            waiter.resolve(msg);
          }
        } else if (msg.type === "device-revoked") {
          for (const [id, entry] of state.active) {
            if (entry.deviceId === msg.id) {
              state.active.delete(id);
              destroyChannel(id, entry);
            }
          }
          for (const [id, entry] of state.pending) {
            if (entry.deviceId === msg.id) {
              state.pending.delete(id);
              destroyChannel(id, entry);
            }
          }
          log("device-revoked-applied");
        }
      });
      ws.on("close", () => cleanupControl(state));
      ws.on("error", () => cleanupControl(state));
      log("control-open");
    });
  };

  const handlePair = (socket: TLSSocket, ip: string, ua: string, url: URL): void => {
    // 目标主机：?host= 指定；缺省时在线 agent 恰好一个则用它，多个出主机选择页
    const hostParam = url.searchParams.get("host");
    let target: ControlState | undefined;
    if (hostParam) {
      target = controls.get(hostParam);
      if (!target) {
        respond(socket, 200, { "Content-Type": "text/html; charset=utf-8" }, pairPage("", "", ua, true, null));
        return;
      }
    } else if (controls.size === 1) {
      target = controls.values().next().value;
    } else if (controls.size > 1) {
      const online = config.agents.filter((a) => controls.has(a.id)).map((a) => ({ id: a.id, name: displayName(a.id) }));
      respond(socket, 200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }, hostSelectPage(online));
      return;
    }
    if (!target) {
      respond(socket, 200, { "Content-Type": "text/html; charset=utf-8" }, pairPage("", "", ua, true, null));
      return;
    }
    const state = target;
    const hostName = displayName(state.agentId);
    if (hitWindow(pairCreates, ip, PAIR_MAX_PER_IP_PER_MIN)) {
      respond(socket, 429, { "Content-Type": "text/plain; charset=utf-8" }, "配对请求过于频繁，请稍后再试");
      return;
    }
    const now = Date.now();
    for (const [id, entry] of allPairEntries()) {
      if (now - entry.ts >= PAIR_TTL_MS) {
        clearTimeout(entry.timer);
        for (const bucket of pairBuckets.values()) bucket.delete(id);
      }
    }
    if (totalPendingPairs() >= PAIR_MAX_GLOBAL) {
      respond(socket, 429, { "Content-Type": "text/plain; charset=utf-8" }, "配对槽位已满，请稍后再试");
      return;
    }
    const id = randomBytes(DEVICE_ID_BYTES).toString("hex");
    const secret = randomBytes(DEVICE_SECRET_BYTES).toString("base64url");
    // 配对码跨桶全局去重：避免两台 Mac 同屏同码导致批错主机
    const usedCodes = new Set(allPairEntries().map(([, e]) => e.code));
    let code = "";
    for (let i = 0; i < 16; i++) {
      code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      if (!usedCodes.has(code)) break;
    }
    const timer = setTimeout(() => {
      for (const bucket of pairBuckets.values()) {
        if (bucket.delete(id)) clearTimeout(timer);
      }
    }, PAIR_TTL_MS);
    let bucket = pairBuckets.get(state.agentId);
    if (!bucket) {
      bucket = new Map();
      pairBuckets.set(state.agentId, bucket);
    }
    bucket.set(id, { secret, code, ua, ip, ts: now, timer });
    send(state, { type: "pair-request", id, code, ua, ip, secretHash: sha256Hex(secret) });
    respond(socket, 200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }, pairPage(id, code, ua, false, hostName));
  };

  const handlePairStatus = async (socket: TLSSocket, id: string | null, headers: Record<string, string>): Promise<void> => {
    if (!id || !COOKIE_ID_RE.test(id)) {
      respondJson(socket, 200, { status: "expired" });
      return;
    }
    // 按 pairId 扫 ≤16 个桶定位所属 agent
    let owner: ControlState | null = null;
    let entry: PairEntry | null = null;
    for (const [agentId, bucket] of pairBuckets) {
      const found = bucket.get(id);
      if (found) {
        owner = controls.get(agentId) ?? null;
        entry = found;
        break;
      }
    }
    if (!entry || !owner) {
      respondJson(socket, 200, { status: "expired" });
      return;
    }
    const result = await request(owner, { type: "pair-check", req: `r${++reqSeq}`, id });
    const status = result?.type === "pair-check-result" ? result.status : "pending";
    if (status === "approved") {
      // secret 只在此刻一次性下发给持有该 id 的轮询者；下发后 pending 作废；合并进既有 Cookie 映射
      for (const bucket of pairBuckets.values()) bucket.delete(id);
      clearTimeout(entry.timer);
      const map = parseDeviceCookie(headers) ?? new Map();
      map.set(owner.agentId, { id, secret: entry.secret });
      respondJson(socket, 200, { status: "approved", redirect: "/" }, { "Set-Cookie": setCookieHeader(serializeDeviceCookie(map)) });
    } else if (status === "denied") {
      for (const bucket of pairBuckets.values()) bucket.delete(id);
      clearTimeout(entry.timer);
      respondJson(socket, 200, { status: "denied" });
    } else {
      respondJson(socket, 200, { status: "pending" });
    }
  };

  /** 对 Cookie 中有入口的在线 agent 并行 auth，返回获批集合（按配置顺序）与候选数。
   * 扇出内单 host 失败不计 authFails（否则吊销残留条目 + 3s 轮询会连带 429 封掉其他 host）；
   * 候选数 0（无在线主机）由调用方回 503，亦不计（与 v1 离线语义一致）。 */
  const approvedOnline = async (cookie: DeviceCookie | null): Promise<{ approved: ControlState[]; candidates: number }> => {
    if (!cookie || cookie.size === 0) return { approved: [], candidates: 0 };
    const candidates = config.agents
      .map((a) => controls.get(a.id))
      .filter((s): s is ControlState => !!s && cookie.has(s.agentId));
    const results = await Promise.all(
      candidates.map(async (state) => {
        const cred = cookie.get(state.agentId)!;
        const result = await request(state, { type: "auth", req: `r${++reqSeq}`, id: cred.id, secretHash: sha256Hex(cred.secret) });
        return result?.type === "auth-result" && result.allow ? state : null;
      }),
    );
    return { approved: results.filter((s): s is ControlState => !!s), candidates: candidates.length };
  };

  const handleBrowser = async (
    socket: TLSSocket,
    ip: string,
    head: Buffer,
    parsed: { method: string; target: string; headers: Record<string, string> },
    url: URL,
  ): Promise<void> => {
    const isNav = parsed.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html") && (parsed.headers.accept ?? "").includes("text/html");
    const cookie = parseDeviceCookie(parsed.headers);
    // 整体 deny 才计 authFails；不再清 Cookie（多主机下会误伤其他 host 的凭据）
    const deny = (): void => {
      if (hitWindow(authFails, ip, AUTH_FAIL_MAX_PER_IP_PER_MIN)) {
        respondJson(socket, 429, { error: "请求过于频繁，请稍后再试" });
        return;
      }
      if (isNav) redirect(socket, "/pair");
      else respondJson(socket, 401, { error: "设备未获批准：请先访问 /pair 完成配对" });
    };
    const stay = url.searchParams.get("stay") === "1";

    // 聚合会话列表（中继本地拦截，不透传）：拍平全部获批在线主机的会话
    if (parsed.method === "GET" && url.pathname === "/api/sessions") {
      if (!cookie) {
        deny();
        return;
      }
      const { approved, candidates } = await approvedOnline(cookie);
      if (candidates === 0) {
        respondJson(socket, 503, { error: "本机离线：pi-relay agent 未连接中继" });
        return;
      }
      if (approved.length === 0) {
        deny();
        return;
      }
      const lists = await Promise.all(
        approved.map(async (state) => {
          const result = await request(state, { type: "list-sessions", req: `r${++reqSeq}` });
          return { state, sessions: result?.type === "sessions-result" ? result.sessions : [] };
        }),
      );
      const sessions: Array<SessionBrief & { host: string; hostName: string; lan: string | null }> = [];
      for (const { state, sessions: list } of lists) {
        const lanBase = !stay && state.lan && ip === state.ip ? `http://${state.lan.host}:${state.lan.port}/?token=${encodeURIComponent(state.lan.token)}` : null;
        for (const s of list) {
          sessions.push({ ...s, host: state.agentId, hostName: displayName(state.agentId), lan: lanBase });
        }
      }
      const hosts = config.agents.map((a) => ({ id: a.id, name: displayName(a.id), online: controls.has(a.id) }));
      respondJson(socket, 200, { relay: true, hosts, sessions });
      return;
    }

    // /ws：host 参数定位 agent；缺省时获批在线恰好一个则用它，否则 400
    let target: ControlState | null = null;
    if (url.pathname === "/ws") {
      const hostParam = url.searchParams.get("host");
      if (hostParam) {
        const state = controls.get(hostParam);
        if (!state) {
          respondJson(socket, 503, { error: "本机离线：pi-relay agent 未连接中继" });
          return;
        }
        const cred = cookie?.get(hostParam);
        if (!cred) {
          deny();
          return;
        }
        const result = await request(state, { type: "auth", req: `r${++reqSeq}`, id: cred.id, secretHash: sha256Hex(cred.secret) });
        if (result?.type !== "auth-result" || !result.allow) {
          deny();
          return;
        }
        target = state;
      } else {
        if (!cookie) {
          deny();
          return;
        }
        const { approved, candidates } = await approvedOnline(cookie);
        if (candidates === 0) {
          respondJson(socket, 503, { error: "本机离线：pi-relay agent 未连接中继" });
          return;
        }
        if (approved.length === 0) {
          deny();
          return;
        }
        if (approved.length > 1) {
          respondJson(socket, 400, { error: "多主机在线：/ws 必须携带 host 参数" });
          return;
        }
        target = approved[0]!;
      }
    } else {
      // 页面/静态资源：按配置顺序取第一个获批在线 agent（确定性选择，避免版本漂移）
      if (!cookie) {
        deny();
        return;
      }
      const { approved, candidates } = await approvedOnline(cookie);
      if (candidates === 0) {
        respondJson(socket, 503, { error: "本机离线：pi-relay agent 未连接中继" });
        return;
      }
      if (approved.length === 0) {
        deny();
        return;
      }
      target = approved[0]!;
      // 根导航 LAN redirect：仅在线 agent 恰好一个、同 NAT 出口、192.168、无 stay=1（多主机不 redirect）
      if (controls.size === 1 && isNav && !stay && target.lan && ip === target.ip) {
        redirect(socket, `http://${target.lan.host}:${target.lan.port}/?token=${encodeURIComponent(target.lan.token)}`);
        return;
      }
    }

    const state = target;
    const deviceId = cookie?.get(state.agentId)?.id ?? "";
    const counts = globalChannelCounts();
    if (
      state.active.size >= MAX_DATA_CHANNELS ||
      state.pending.size >= MAX_PENDING_CHANNELS ||
      counts.active >= MAX_GLOBAL_DATA_CHANNELS ||
      counts.pending >= MAX_GLOBAL_PENDING_CHANNELS
    ) {
      respondJson(socket, 503, { error: "并发通道已满，请稍后再试" });
      return;
    }
    const channelId = randomBytes(16).toString("hex");
    const timer = setTimeout(() => {
      if (state.pending.delete(channelId)) {
        socket.destroy();
        log("channel-pending-expired", channelId);
      }
    }, CHANNEL_TTL_MS);
    state.pending.set(channelId, { browser: socket, head, deviceId, timer });
    socket.pause(); // 等待数据通道配对，期间不继续读浏览器字节
    if (!send(state, { type: "open", channel: channelId })) {
      clearTimeout(timer);
      state.pending.delete(channelId);
      respondJson(socket, 503, { error: "本机离线：pi-relay agent 未连接中继" });
    }
  };

  const route = async (socket: TLSSocket, ip: string, head: Buffer, rest: Buffer): Promise<void> => {
    const parsed = parseHead(head);
    if (!parsed) {
      socket.destroy();
      return;
    }
    let url: URL;
    try {
      url = new URL(parsed.target, "http://relay.local");
    } catch {
      socket.destroy();
      return;
    }
    const pathname = url.pathname;
    const upgrade = (req: IncomingMessage, cb: (ws: WebSocket) => void): void => {
      wss.handleUpgrade(req, socket, rest, cb);
    };
    const fakeReq = (): IncomingMessage => {
      const req = new IncomingMessage(socket);
      req.method = parsed.method;
      req.url = parsed.target;
      req.headers = parsed.headers;
      return req;
    };

    if (pathname === "/agent/control" || pathname === "/agent/data") {
      const token = url.searchParams.get("agentToken") ?? "";
      const agent = agentByToken(token);
      if (!agent) {
        upgrade(fakeReq(), (ws) => ws.close(CLOSE_AGENT_TOKEN_INVALID, "agentToken 无效"));
        return;
      }
      if (pathname === "/agent/control") {
        handleControlUpgrade(fakeReq(), socket, rest, ip, agent);
        return;
      }
      const channelId = url.searchParams.get("channel") ?? "";
      const state = controls.get(agent.id);
      upgrade(fakeReq(), (ws) => {
        if (!state) {
          ws.close(CLOSE_CHANNEL_INVALID, "agent 离线");
          return;
        }
        pairDataChannel(state, channelId, ws);
      });
      return;
    }

    if (parsed.method !== "GET") {
      respondJson(socket, 404, { error: "Not Found" });
      return;
    }
    if (pathname === "/ca.crt") {
      respond(socket, 200, { "Content-Type": "application/x-x509-ca-cert", "Cache-Control": "no-store" }, caBytes);
      return;
    }
    if (pathname === "/relay-status") {
      respondJson(socket, 200, {
        agentOnline: controls.size > 0,
        agents: config.agents.map((a) => ({ id: a.id, name: displayName(a.id), online: controls.has(a.id) })),
        waitingPairs: totalPendingPairs(),
      });
      return;
    }
    if (pathname === "/pair") {
      handlePair(socket, ip, (parsed.headers["user-agent"] ?? "").slice(0, 200), url);
      return;
    }
    if (pathname === "/pair-status") {
      await handlePairStatus(socket, url.searchParams.get("id"), parsed.headers);
      return;
    }
    // 浏览器流量：连接级设备鉴权后全字节直通（head 含已缓冲头部，rest 为紧随字节）
    await handleBrowser(socket, ip, Buffer.concat([head, rest]), parsed, url);
  };

  const tlsServer = createTlsServer({ key, cert }, (socket) => {
    liveSockets.add(socket);
    const ip = normalizeIp(socket.remoteAddress ?? "");
    const count = (preauthCount.get(ip) ?? 0) + 1;
    preauthCount.set(ip, count);
    if (count > PREAUTH_MAX_PER_IP) {
      socket.destroy();
      return;
    }
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      const left = (preauthCount.get(ip) ?? 1) - 1;
      if (left <= 0) preauthCount.delete(ip);
      else preauthCount.set(ip, left);
    };
    let buf = Buffer.alloc(0);
    const headerTimer = setTimeout(() => {
      socket.destroy(); // slowloris：10s 内未发完头部
    }, HEADER_TIMEOUT_MS);
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > HEADER_MAX_BYTES) {
        socket.destroy();
        return;
      }
      const idx = buf.indexOf("\r\n\r\n");
      if (idx < 0) return;
      socket.removeListener("data", onData);
      clearTimeout(headerTimer);
      release(); // 预鉴权阶段结束，进入路由/鉴权/通道阶段
      void route(socket, ip, buf.subarray(0, idx + 4), buf.subarray(idx + 4)).catch(() => socket.destroy());
    };
    socket.on("data", onData);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      clearTimeout(headerTimer);
      release();
      liveSockets.delete(socket);
    });
  });
  tlsServer.on("tlsClientError", () => {
    // 证书校验失败/非 TLS 探测等，不记录对端细节
  });

  await new Promise<void>((resolve, reject) => {
    tlsServer.once("error", reject);
    tlsServer.listen(config.port, config.listen, () => resolve());
  });
  console.error(`[pi-relay] 中继已启动 listen=${config.listen}:${config.port}`);

  const close = async (): Promise<void> => {
    for (const state of [...controls.values()]) cleanupControl(state);
    for (const bucket of pairBuckets.values()) {
      for (const entry of bucket.values()) clearTimeout(entry.timer);
    }
    pairBuckets.clear();
    for (const socket of liveSockets) socket.destroy();
    wss.close();
    await new Promise<void>((resolve) => tlsServer.close(() => resolve()));
  };
  return { close };
}