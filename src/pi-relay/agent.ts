/**
 * 本机出站 agent：控制 WSS 常连接 + 按需数据通道，把中继流量直通 127.0.0.1 的 pi-web。
 * - 可信设备列表权威在本机 devices.json：agent 只读，实时应答 auth/pair-check；
 * - 目录 watch（降级轮询）检测吊销并推送 device-revoked；lastSeen 独写 devices-lastseen.json；
 * - TLS 用 pinned CA 验证中继证书；agentToken 错（4001）停止重试并中文报错；
 * - 日志不含任何凭据材料（token/secret/Cookie/配对码/hello 内容）。
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { watch as fsWatch } from "node:fs";
import { get as httpGet } from "node:http";
import { connect, type Socket } from "node:net";
import { hostname, networkInterfaces } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import {
  BACKPRESSURE_CHECK_MS,
  BACKPRESSURE_HIGH_BYTES,
  CLOSE_AGENT_TOKEN_INVALID,
  HEARTBEAT_TIMEOUT_MS,
  MAX_WS_MESSAGE_BYTES,
  RECONNECT_MAX_MS,
  RECONNECT_MIN_MS,
  is192168,
  safeEqualHex,
  type DownMessage,
  type LanInfo,
  type SessionBrief,
  type UpMessage,
} from "./protocol.ts";
import { loadWebSettings } from "./config.ts";
import { addPending, clearStalePending, readDevices, readPending, relayDir, writeLastSeen } from "./devices.ts";

const execFileAsync = promisify(execFile);
const HEARTBEAT_PING_CHECK_MS = 5_000;

function log(event: string): void {
  console.error(`[pi-relay-agent] ${event}`);
}

/** 默认路由网卡（macOS route / Linux ip route），用于 192.168 地址优选 */
async function defaultRouteInterface(): Promise<string | null> {
  try {
    if (process.platform === "darwin") {
      const { stdout } = await execFileAsync("route", ["-n", "get", "default"], { encoding: "utf8" });
      return /interface:\s*(\S+)/.exec(stdout)?.[1] ?? null;
    }
    const { stdout } = await execFileAsync("ip", ["route", "show", "default"], { encoding: "utf8" });
    return /\bdev\s+(\S+)/.exec(stdout)?.[1] ?? null;
  } catch {
    return null;
  }
}

const VIRTUAL_IFACE_RE = /^(utun|bridge|vmnet|vnic|parallels|vbox|awdl|llw|anpi|ap\d|gif|stf|lo)/i;

/** 仅 192.168.0.0/16 IPv4，优选默认路由网卡、排除虚拟接口；无合格网卡返回 null */
async function pickLanInfo(webPort: number, webToken: string): Promise<LanInfo | null> {
  const preferred = await defaultRouteInterface();
  const candidates: Array<{ name: string; address: string }> = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    if (VIRTUAL_IFACE_RE.test(name)) continue;
    for (const net of list ?? []) {
      if (net.family === "IPv4" && !net.internal && is192168(net.address)) candidates.push({ name, address: net.address });
    }
  }
  const picked = candidates.find((c) => c.name === preferred) ?? candidates[0];
  return picked ? { host: picked.address, port: webPort, token: webToken } : null;
}

async function writeStatus(dir: string, state: string, lastHeartbeat: string | null): Promise<void> {
  await writeFile(path.join(dir, "agent-status.json"), `${JSON.stringify({ state, since: new Date().toISOString(), lastHeartbeat }, null, 2)}\n`, { mode: 0o600 });
}

/** 经回环 HTTP 消费 pi-web /api/sessions（跨 feature 只走公开 HTTP API，不 import 实现）；4s 超时 destroy */
function fetchSessions(webPort: number): Promise<SessionBrief[]> {
  return new Promise((resolve) => {
    const req = httpGet({ host: "127.0.0.1", port: webPort, path: "/api/sessions", timeout: 4_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { sessions?: unknown };
          resolve(Array.isArray(data.sessions) ? data.sessions.filter(isSessionBrief) : []);
        } catch {
          resolve([]);
        }
      });
      res.on("error", () => resolve([]));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve([]));
  });
}

function isSessionBrief(s: unknown): s is SessionBrief {
  if (!s || typeof s !== "object") return false;
  const o = s as Record<string, unknown>;
  return typeof o.name === "string" && typeof o.windows === "number" && typeof o.created === "string" && typeof o.attached === "boolean";
}

/** 非 upgrade 请求的首块头部注入 Connection: close：
 * 中继按连接路由，浏览器 keep-alive 复用会让后续 /api/sessions 绕过中继拦截直达单台 pi-web；
 * 令 pi-web 响应后关 TCP → 数据通道成对关闭 → 浏览器每请求新建连接，逐请求路由才成立。
 * WS upgrade 请求不改（Connection: Upgrade 语义必须保留）。首块必含完整头部（中继缓冲至 \r\n\r\n 后才转发）。 */
function forceConnectionClose(chunk: Buffer): Buffer {
  const idx = chunk.indexOf("\r\n\r\n");
  if (idx < 0) return chunk;
  let header = chunk.subarray(0, idx).toString("latin1");
  if (/^upgrade:/im.test(header)) return chunk;
  header = header.replace(/^connection:[^\r\n]*\r\n/gim, "");
  header += "\r\nConnection: close";
  return Buffer.concat([Buffer.from(header, "latin1"), chunk.subarray(idx)]);
}

/** TCP→WS / WS→TCP 双向背压 pipe（与中继侧同策略）；transformFirst 仅对首个 WS 消息生效 */
function pipePair(socket: Socket, ws: WebSocket, transformFirst: boolean): void {
  let checkTimer: NodeJS.Timeout | null = null;
  socket.on("data", (chunk: Buffer) => {
    if (ws.readyState !== ws.OPEN) {
      socket.destroy();
      return;
    }
    ws.send(chunk);
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
  ws.on("message", (data: Buffer) => {
    if (socketClosed || socket.destroyed) return;
    if (transformFirst) {
      data = forceConnectionClose(data);
      transformFirst = false;
    }
    if (!socket.write(data)) ws.pause();
  });
  socket.on("drain", () => ws.resume());
  // 方向性清理：pi-web 侧先关（Connection: close 响应完毕）必须等 WS 缓冲字节 flush 后
  // 优雅 close，否则 terminate 丢弃未发送帧 → 浏览器 chunked 响应截断；
  // WS 侧先关意味着浏览器已断开，直接销毁本地 socket。
  let socketClosed = false;
  const drainThenCloseWs = (): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 0) {
      setTimeout(drainThenCloseWs, BACKPRESSURE_CHECK_MS);
      return;
    }
    try {
      ws.close(1000);
    } catch {
      // 忽略
    }
  };
  socket.on("close", () => {
    socketClosed = true;
    if (checkTimer) clearInterval(checkTimer);
    drainThenCloseWs();
  });
  socket.on("error", () => {
    socketClosed = true;
    if (checkTimer) clearInterval(checkTimer);
    try {
      ws.terminate();
    } catch {
      // 忽略
    }
  });
  ws.on("close", () => {
    if (checkTimer) clearInterval(checkTimer);
    socket.destroy();
  });
  ws.on("error", () => socket.destroy());
}

export async function runAgent(root: string, settingsPath: string): Promise<void> {
  const settings = await loadWebSettings(settingsPath);
  if (settings.exposure !== "public" || !settings.relay) {
    throw new Error("agent 仅在 webExposure=public 且 webRelay 配置完整时运行");
  }
  const relay = settings.relay;
  const dir = relayDir(root);
  await mkdir(dir, { recursive: true });
  let caPem: string;
  try {
    caPem = await readFile(path.join(dir, "root-ca.crt"), "utf8");
  } catch {
    throw new Error("缺少 var/pi-relay/root-ca.crt：请先运行 node scripts/pi-relay.ts fetch-ca 获取并校验中继 CA");
  }
  let webToken: string;
  try {
    webToken = (await readFile(path.join(dir, "web-token"), "utf8")).trim();
  } catch {
    throw new Error("缺少 var/pi-relay/web-token：请先运行 node scripts/pi-relay.ts ensure");
  }
  const webPort = Number.parseInt(process.env.PI_WEB_PORT ?? "7681", 10) || 7681;
  const baseUrl = relay.url.replace(/\/+$/, "");
  const tlsOptions = { ca: caPem, rejectUnauthorized: true };

  let control: WebSocket | null = null;
  let stopped = false;
  let backoff = RECONNECT_MIN_MS;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let lastPingAt = 0;
  let lastHeartbeat: string | null = null;
  let lastStatusWriteAt = 0;
  let deviceSnapshot = new Set<string>();
  const lastSeen = new Map<string, string>();
  let lastSeenDirty = false;

  const sendUp = (msg: UpMessage): void => {
    if (control?.readyState === WebSocket.OPEN) {
      try {
        control.send(JSON.stringify(msg));
      } catch {
        // 忽略：连接即将关闭，走重连
      }
    }
  };

  /** 数据通道：新建 WSS + 回环 TCP 到 pi-web，双向 pipe，任一侧关闭成对清理 */
  const openDataChannel = (channel: string): void => {
    const ws = new WebSocket(`${baseUrl}/agent/data?agentToken=${encodeURIComponent(relay.agentToken)}&channel=${encodeURIComponent(channel)}`, {
      ...tlsOptions,
      maxPayload: MAX_WS_MESSAGE_BYTES,
    });
    let socket: Socket | null = null;
    // 中继在配对成功后立即写入已缓冲的头部字节，可能先于 TCP connect 到达；
    // 必须先挂 message 监听缓冲，否则首请求丢失导致浏览器挂起
    const early: Buffer[] = [];
    const onEarly = (data: Buffer): void => {
      early.push(data);
    };
    ws.on("message", onEarly);
    ws.on("open", () => {
      socket = connect({ host: "127.0.0.1", port: webPort });
      socket.on("connect", () => {
        ws.removeListener("message", onEarly);
        const hadEarly = early.length > 0;
        if (hadEarly) early[0] = forceConnectionClose(early[0]!);
        for (const chunk of early.splice(0)) socket!.write(chunk);
        pipePair(socket!, ws, !hadEarly);
      });
      socket.on("error", () => {
        try {
          ws.terminate();
        } catch {
          // 忽略
        }
      });
    });
    ws.on("close", () => socket?.destroy());
    ws.on("error", () => socket?.destroy());
  };

  const handleMessage = async (msg: DownMessage): Promise<void> => {
    if (msg.type === "auth") {
      // 实时读权威列表（文件小，无缓存），吊销即时生效
      const devices = await readDevices(root);
      const device = devices.find((d) => d.id === msg.id);
      const allow = !!device && safeEqualHex(device.secretHash, msg.secretHash);
      if (allow && device) {
        lastSeen.set(device.id, new Date().toISOString());
        lastSeenDirty = true;
      }
      sendUp({ type: "auth-result", req: msg.req, allow, ...(allow && device ? { name: device.name } : {}) });
    } else if (msg.type === "pair-request") {
      await addPending(root, { id: msg.id, code: msg.code, ua: msg.ua, ip: msg.ip, secretHash: msg.secretHash, ts: Date.now(), status: "pending" });
      log("pair-request-persisted");
    } else if (msg.type === "pair-check") {
      const devices = await readDevices(root);
      const pending = await readPending(root);
      const status = devices.some((d) => d.id === msg.id) ? "approved" : pending.find((p) => p.id === msg.id)?.status === "denied" ? "denied" : "pending";
      sendUp({ type: "pair-check-result", req: msg.req, status });
    } else if (msg.type === "open") {
      openDataChannel(msg.channel);
    } else if (msg.type === "list-sessions") {
      const sessions = await fetchSessions(webPort);
      sendUp({ type: "sessions-result", req: msg.req, sessions });
    }
  };

  /** 吊销 diff：快照对比，移除的 id 推送 device-revoked（中继切断存量通道） */
  const diffDevices = async (push: boolean): Promise<void> => {
    try {
      const devices = await readDevices(root);
      const current = new Set(devices.map((d) => d.id));
      if (push) {
        for (const id of deviceSnapshot) {
          if (!current.has(id)) sendUp({ type: "device-revoked", id });
        }
      }
      deviceSnapshot = current;
    } catch {
      // 存储损坏时不推送，fail closed 由 auth 实时读兜底
    }
  };

  const connectControl = (): void => {
    if (stopped) return;
    void writeStatus(dir, "connecting", lastHeartbeat);
    const ws = new WebSocket(`${baseUrl}/agent/control?agentToken=${encodeURIComponent(relay.agentToken)}`, {
      ...tlsOptions,
      maxPayload: MAX_WS_MESSAGE_BYTES,
    });
    control = ws;
    let opened = false;
    ws.on("open", () => {
      opened = true;
      backoff = RECONNECT_MIN_MS;
      lastPingAt = Date.now();
      void (async () => {
        const lan = await pickLanInfo(webPort, webToken);
        sendUp({ type: "hello", lan, hostname: hostname().slice(0, 64) });
        await clearStalePending(root).catch(() => {});
        await diffDevices(false);
        await writeStatus(dir, "connected", lastHeartbeat);
        log("control-connected");
      })();
    });
    ws.on("ping", () => {
      lastPingAt = Date.now();
      lastHeartbeat = new Date().toISOString();
      // 心跳落盘节流（≥15s），供 status 展示最近心跳
      if (Date.now() - lastStatusWriteAt >= 15_000) {
        lastStatusWriteAt = Date.now();
        void writeStatus(dir, "connected", lastHeartbeat);
      }
    });
    ws.on("message", (raw) => {
      let msg: DownMessage;
      try {
        msg = JSON.parse(String(raw)) as DownMessage;
      } catch {
        return;
      }
      void handleMessage(msg).catch(() => log("message-handle-failed"));
    });
    ws.on("close", (code) => {
      if (control === ws) control = null;
      if (code === CLOSE_AGENT_TOKEN_INVALID) {
        stopped = true;
        log("agentToken 与中继不一致，请核对 settings.local.json 与 ECS init 输出");
        void writeStatus(dir, "stopped", lastHeartbeat).then(() => process.exit(1));
        return;
      }
      if (!opened) log("control-connect-failed");
      else log("control-disconnected");
      void writeStatus(dir, "connecting", lastHeartbeat);
      scheduleReconnect();
    });
    ws.on("error", () => {
      // 细节（含 URL/token）不进日志；close 事件负责重连
    });
  };

  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer) return;
    const delay = backoff + randomBytes(2).readUInt16BE(0) % 500;
    backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectControl();
    }, delay);
  };

  // 心跳监测：中继每 5s ping，15s 无 ping 判死重连
  const heartbeatTimer = setInterval(() => {
    if (control?.readyState === WebSocket.OPEN && Date.now() - lastPingAt > HEARTBEAT_TIMEOUT_MS) {
      log("heartbeat-timeout");
      control.terminate();
    }
  }, HEARTBEAT_PING_CHECK_MS);

  // lastSeen 节流落盘（agent 独占写者）
  const lastSeenTimer = setInterval(() => {
    if (!lastSeenDirty) return;
    lastSeenDirty = false;
    void writeLastSeen(root, Object.fromEntries(lastSeen)).catch(() => {});
  }, 60_000);

  // 吊销检测：目录级 watch（temp+rename 原子写会使单文件 watch 失效）+ 文件名过滤 + debounce；
  // watch 失效降级 5s 全量 diff 轮询兜底
  let watchDebounce: NodeJS.Timeout | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  try {
    const watcher = fsWatch(dir);
    watcher.on("change", (_event, filename) => {
      if (String(filename) !== "devices.json") return;
      if (watchDebounce) clearTimeout(watchDebounce);
      watchDebounce = setTimeout(() => void diffDevices(true), 200);
    });
    watcher.on("error", () => {
      watcher.close();
      if (!pollTimer) pollTimer = setInterval(() => void diffDevices(true), 5_000);
    });
    process.on("exit", () => watcher.close());
  } catch {
    pollTimer = setInterval(() => void diffDevices(true), 5_000);
  }

  const shutdown = (): void => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    clearInterval(heartbeatTimer);
    clearInterval(lastSeenTimer);
    if (pollTimer) clearInterval(pollTimer);
    control?.terminate();
    void writeStatus(dir, "stopped", lastHeartbeat).then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await diffDevices(false);
  connectControl();
  // 长驻进程：保持事件循环活跃
  await new Promise<void>(() => {});
}