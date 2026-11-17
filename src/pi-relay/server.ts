/**
 * ECS 中继服务端：TLS socket 层字节透明反向代理。
 * - 终止手机侧 TLS 后按连接做一次性路由/设备鉴权，随后原始 HTTP 字节经 WSS 数据通道直通本机 pi-web；
 * - 设备配对（/pair + /pair-status）与批准状态经控制连接往返本机 agent，中继不落盘任何设备凭据；
 * - 控制连接任何原因关闭即清名下全部数据通道/pending/配对表；
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
  MAX_DATA_CHANNELS,
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
  type UpMessage,
} from "./protocol.ts";
import { loadServerConfig } from "./server-config.ts";
import { readCaPem, readServerCert } from "./certs.ts";

type PendingChannel = { browser: TLSSocket; head: Buffer; deviceId: string; timer: NodeJS.Timeout };
type ActiveChannel = { browser: TLSSocket; dataWs: WebSocket; deviceId: string; idleTimer: NodeJS.Timeout };
type Waiter = { resolve: (msg: UpMessage | null) => void; timer: NodeJS.Timeout };
type PairEntry = { secret: string; code: string; ua: string; ip: string; ts: number; timer: NodeJS.Timeout };

type ControlState = {
  ws: WebSocket;
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

const CLEAR_COOKIE = `${DEVICE_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;

function pairPage(id: string, code: string, ua: string, offline: boolean): string {
  const escapedUa = ua.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const body = offline
    ? `<p class="msg">本机离线，请稍后再试。</p>`
    : `<p>请在本机终端核对配对码后批准：</p>
  <div class="code">${code}</div>
  <p class="ua">设备：${escapedUa}</p>
  <p class="msg" id="msg">等待批准中…（本机运行 node scripts/pi-relay.ts devices 查看）</p>
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
  let control: ControlState | null = null;
  const pairPending = new Map<string, PairEntry>();
  const authFails = new Map<string, number[]>();
  const pairCreates = new Map<string, number[]>();
  const preauthCount = new Map<string, number>();
  const liveSockets = new Set<TLSSocket>();
  let reqSeq = 0;

  const send = (msg: DownMessage): boolean => {
    if (!control || control.ws.readyState !== control.ws.OPEN) return false;
    try {
      control.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  };

  /** 经控制连接请求-应答（auth/pair-check），超时/控制死亡返回 null */
  const request = (msg: DownMessage & { req: string }): Promise<UpMessage | null> => {
    return new Promise((resolve) => {
      if (!control) {
        resolve(null);
        return;
      }
      const timer = setTimeout(() => {
        control?.waiters.delete(msg.req);
        resolve(null);
      }, AUTH_TIMEOUT_MS);
      control.waiters.set(msg.req, { resolve, timer });
      if (!send(msg)) {
        clearTimeout(timer);
        control?.waiters.delete(msg.req);
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

  /** 控制连接任何原因关闭/被替换：清名下全部通道、pending、配对表，应答等待者 */
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
    for (const entry of pairPending.values()) clearTimeout(entry.timer);
    pairPending.clear();
    if (control === state) control = null;
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

  const pairDataChannel = (channelId: string, dataWs: WebSocket): void => {
    const state = control;
    const entry = state?.pending.get(channelId);
    if (!state || !entry) {
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
    dataWs.on("close", cleanup);
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

  const handleControlUpgrade = (req: IncomingMessage, socket: TLSSocket, head: Buffer, ip: string): void => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (control) cleanupControl(control);
      const state: ControlState = {
        ws,
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
      control = state;
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
          log("agent-hello");
        } else if (msg.type === "auth-result" || msg.type === "pair-check-result") {
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

  const handlePair = (socket: TLSSocket, ip: string, ua: string): void => {
    if (!control) {
      respond(socket, 200, { "Content-Type": "text/html; charset=utf-8" }, pairPage("", "", ua, true));
      return;
    }
    if (hitWindow(pairCreates, ip, PAIR_MAX_PER_IP_PER_MIN)) {
      respond(socket, 429, { "Content-Type": "text/plain; charset=utf-8" }, "配对请求过于频繁，请稍后再试");
      return;
    }
    const now = Date.now();
    for (const [id, entry] of pairPending) {
      if (now - entry.ts >= PAIR_TTL_MS) {
        clearTimeout(entry.timer);
        pairPending.delete(id);
      }
    }
    if (pairPending.size >= PAIR_MAX_GLOBAL) {
      respond(socket, 429, { "Content-Type": "text/plain; charset=utf-8" }, "配对槽位已满，请稍后再试");
      return;
    }
    const id = randomBytes(DEVICE_ID_BYTES).toString("hex");
    const secret = randomBytes(DEVICE_SECRET_BYTES).toString("base64url");
    let code = "";
    for (let i = 0; i < 16; i++) {
      code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      if (![...pairPending.values()].some((entry) => entry.code === code)) break;
    }
    const timer = setTimeout(() => pairPending.delete(id), PAIR_TTL_MS);
    pairPending.set(id, { secret, code, ua, ip, ts: now, timer });
    send({ type: "pair-request", id, code, ua, ip, secretHash: sha256Hex(secret) });
    respond(socket, 200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }, pairPage(id, code, ua, false));
  };

  const handlePairStatus = async (socket: TLSSocket, id: string | null): Promise<void> => {
    if (!id || !/^[0-9a-f]{16}$/.test(id)) {
      respondJson(socket, 200, { status: "expired" });
      return;
    }
    const entry = pairPending.get(id);
    if (!entry) {
      respondJson(socket, 200, { status: "expired" });
      return;
    }
    const result = await request({ type: "pair-check", req: `r${++reqSeq}`, id });
    const status = result?.type === "pair-check-result" ? result.status : "pending";
    if (status === "approved") {
      // secret 只在此刻一次性下发给持有该 id 的轮询者；下发后 pending 作废
      pairPending.delete(id);
      clearTimeout(entry.timer);
      respondJson(
        socket,
        200,
        { status: "approved", redirect: "/" },
        { "Set-Cookie": `${DEVICE_COOKIE_NAME}=${id}.${entry.secret}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${DEVICE_COOKIE_MAX_AGE}` },
      );
    } else if (status === "denied") {
      pairPending.delete(id);
      clearTimeout(entry.timer);
      respondJson(socket, 200, { status: "denied" });
    } else {
      respondJson(socket, 200, { status: "pending" });
    }
  };

  const handleBrowser = async (
    socket: TLSSocket,
    ip: string,
    head: Buffer,
    parsed: { method: string; target: string; headers: Record<string, string> },
    url: URL,
  ): Promise<void> => {
    const isNav = parsed.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html") && (parsed.headers.accept ?? "").includes("text/html");
    if (!control) {
      respondJson(socket, 503, { error: "本机离线：pi-relay agent 未连接中继" });
      return;
    }
    const cookie = cookieValue(parsed.headers, DEVICE_COOKIE_NAME);
    const match = cookie ? /^([0-9a-f]{16})\.([A-Za-z0-9_-]{43})$/.exec(cookie) : null;
    const deny = (): void => {
      if (hitWindow(authFails, ip, AUTH_FAIL_MAX_PER_IP_PER_MIN)) {
        respondJson(socket, 429, { error: "请求过于频繁，请稍后再试" });
        return;
      }
      if (isNav) redirect(socket, "/pair", cookie ? { "Set-Cookie": CLEAR_COOKIE } : {});
      else respondJson(socket, 401, { error: "设备未获批准：请先访问 /pair 完成配对" }, cookie ? { "Set-Cookie": CLEAR_COOKIE } : {});
    };
    if (!match) {
      deny();
      return;
    }
    const [, deviceId, secret] = match;
    const result = await request({ type: "auth", req: `r${++reqSeq}`, id: deviceId!, secretHash: sha256Hex(secret!) });
    if (result?.type !== "auth-result" || !result.allow) {
      deny();
      return;
    }
    // 同局域网感知（192.168 收窄）：仅已批准设备的顶层导航，且来源 IP == agent NAT 出口 IP
    const state = control;
    if (!state) {
      respondJson(socket, 503, { error: "本机离线：pi-relay agent 未连接中继" });
      return;
    }
    const lan = state.lan;
    if (lan && ip === state.ip && isNav && url.searchParams.get("stay") !== "1") {
      redirect(socket, `http://${lan.host}:${lan.port}/?token=${encodeURIComponent(lan.token)}`);
      return;
    }
    if (state.active.size >= MAX_DATA_CHANNELS || state.pending.size >= MAX_PENDING_CHANNELS) {
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
    state.pending.set(channelId, { browser: socket, head, deviceId: deviceId!, timer });
    socket.pause(); // 等待数据通道配对，期间不继续读浏览器字节
    if (!send({ type: "open", channel: channelId })) {
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
      if (!safeEqualHex(token, config.agentToken)) {
        upgrade(fakeReq(), (ws) => ws.close(CLOSE_AGENT_TOKEN_INVALID, "agentToken 无效"));
        return;
      }
      if (pathname === "/agent/control") {
        handleControlUpgrade(fakeReq(), socket, rest, ip);
        return;
      }
      const channelId = url.searchParams.get("channel") ?? "";
      upgrade(fakeReq(), (ws) => pairDataChannel(channelId, ws));
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
      respondJson(socket, 200, { agentOnline: control !== null, waitingPairs: pairPending.size });
      return;
    }
    if (pathname === "/pair") {
      handlePair(socket, ip, (parsed.headers["user-agent"] ?? "").slice(0, 200));
      return;
    }
    if (pathname === "/pair-status") {
      await handlePairStatus(socket, url.searchParams.get("id"));
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
    if (control) cleanupControl(control);
    for (const entry of pairPending.values()) clearTimeout(entry.timer);
    pairPending.clear();
    for (const socket of liveSockets) socket.destroy();
    wss.close();
    await new Promise<void>((resolve) => tlsServer.close(() => resolve()));
  };
  return { close };
}