/**
 * 三态（off/lan/public）ensure 状态机与进程管理。
 * - off：停 web + agent（含存量无主旧 nohup web 的识别接管）；
 * - lan：与现状一致的局域网共享（0.0.0.0，PI_WEB_TOKEN 可选，不设回环豁免）；
 * - public：web 绑 0.0.0.0 + 内部 web-token + PI_WEB_TRUST_LOOPBACK=1，另起出站 agent；
 * - 探活收到任何响应（含 401）即存活；pidfile + cmdline 核对防 PID 复用；组杀仅 pgid==pid；
 * - 本模块错误由 CLI 捕获为中文告警，绝不阻断 pi()。
 */
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { sha256Hex } from "./protocol.ts";
import { loadWebSettings, type WebSettings } from "./config.ts";
import { audit, readDevices, readPending, relayDir } from "./devices.ts";

const execFileAsync = promisify(execFile);

/** 调用方描述（父进程 cmdline，best-effort）：生命周期审计用，定位谁触发了 ensure/stop */
async function callerDesc(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(process.ppid), "-o", "command="], { encoding: "utf8" });
    return `ppid=${process.ppid} cmd=${stdout.trim().slice(0, 120)}`;
  } catch {
    return `ppid=${process.ppid}`;
  }
}

type WebState = { pid: number; port: number; host: string; tokenFingerprint: string; trustLoopback: boolean };

function webStatePath(root: string): string {
  return path.join(relayDir(root), "web.json");
}
function webPidPath(root: string): string {
  return path.join(relayDir(root), "web.pid");
}
function agentPidPath(root: string): string {
  return path.join(relayDir(root), "agent.pid");
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  const raw = await readText(file);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cmdline(pid: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function pgidOf(pid: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "pgid="], { encoding: "utf8" });
    const pgid = Number.parseInt(stdout.trim(), 10);
    return Number.isInteger(pgid) ? pgid : null;
  } catch {
    return null;
  }
}

const isWebCmdline = (line: string): boolean => line.includes("scripts/pi-web.ts");
const isAgentCmdline = (line: string): boolean => line.includes("scripts/pi-relay.ts") && line.includes("_agent");

/** 探活：收到任何 HTTP 响应（含 401）即存活；连接拒绝/超时视为未运行 */
function probeWeb(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/api/sessions", timeout: 1_000 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}

/** lsof 找端口监听进程，cmdline 匹配本仓 pi-web 才认作可接管对象 */
async function findWebListener(port: number): Promise<{ pid: number; ours: boolean } | null> {
  try {
    const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
    for (const line of stdout.split("\n")) {
      const pid = Number.parseInt(line.trim(), 10);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      return { pid, ours: isWebCmdline(await cmdline(pid)) };
    }
    return null;
  } catch {
    return null;
  }
}

/** 停止进程：先 SIGTERM，组杀仅当 pgid==pid；3s 未退则 SIGKILL；停止动作与升级均入审计 */
async function stopPid(root: string, pid: number, label: string): Promise<void> {
  if (!pidAlive(pid)) return;
  const pgid = await pgidOf(pid);
  const target = pgid === pid ? -pid : pid;
  await audit(root, `stop ${label} pid=${pid} signal=SIGTERM group=${pgid === pid} caller=${await callerDesc()}`);
  try {
    process.kill(target, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && pidAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (pidAlive(pid)) {
    await audit(root, `stop ${label} pid=${pid} escalate=SIGKILL（3s 未退）`);
    try {
      process.kill(target, "SIGKILL");
    } catch {
      // 已退出
    }
  }
}

async function stopWeb(root: string, port: number): Promise<void> {
  const state = await readJson<WebState>(webStatePath(root));
  if (state && pidAlive(state.pid) && isWebCmdline(await cmdline(state.pid))) {
    await stopPid(root, state.pid, "web");
  } else {
    const listener = await findWebListener(port);
    if (listener?.ours) await stopPid(root, listener.pid, "web-legacy");
    else if (listener) throw new Error(`端口 ${port} 被陌生进程占用（pid=${listener.pid}），请手动处理后重试`);
  }
  await unlink(webPidPath(root)).catch(() => {});
  await unlink(webStatePath(root)).catch(() => {});
}

async function stopAgent(root: string): Promise<void> {
  const raw = await readText(agentPidPath(root));
  const pid = raw ? Number.parseInt(raw.trim(), 10) : NaN;
  if (Number.isInteger(pid) && pidAlive(pid) && isAgentCmdline(await cmdline(pid))) {
    await stopPid(root, pid, "agent");
  }
  await unlink(agentPidPath(root)).catch(() => {});
}

/** ensure 互斥锁（O_EXCL + pid 陈旧检测），防双终端并发 pi() 重复拉起 */
async function withEnsureLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const dir = relayDir(root);
  await mkdir(dir, { recursive: true });
  const lockFile = path.join(dir, "ensure.lock");
  const deadline = Date.now() + 8_000;
  for (;;) {
    try {
      const handle = await open(lockFile, "wx", 0o600);
      try {
        await handle.writeFile(String(process.pid));
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = false;
      try {
        const pid = Number.parseInt((await readFile(lockFile, "utf8")).trim(), 10);
        stale = !Number.isInteger(pid) || pid <= 0 || !pidAlive(pid);
      } catch {
        stale = true;
      }
      if (stale) {
        await unlink(lockFile).catch(() => {});
        continue;
      }
      if (Date.now() > deadline) throw new Error("ensure 锁等待超时：可能有其他 pi() 正在初始化，请稍后重试");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lockFile).catch(() => {});
  }
}

async function spawnDetached(root: string, args: string[], logName: string, env: Record<string, string>, pidFile: string): Promise<number> {
  const dir = relayDir(root);
  await mkdir(dir, { recursive: true });
  const logHandle = await open(path.join(dir, logName), "a", 0o600);
  try {
    const child = spawn(process.execPath, args, {
      cwd: root,
      detached: true,
      stdio: ["ignore", logHandle.fd, logHandle.fd],
      env: { ...process.env, ...env },
    });
    child.unref();
    if (!child.pid) throw new Error(`后台进程启动失败：${args.join(" ")}`);
    await writeFile(pidFile, `${child.pid}\n`, { mode: 0o600 });
    return child.pid;
  } finally {
    await logHandle.close();
  }
}

async function ensureWebToken(root: string): Promise<string> {
  const file = path.join(relayDir(root), "web-token");
  const existing = (await readText(file))?.trim();
  if (existing && /^[A-Za-z0-9_-]{16,128}$/.test(existing)) return existing;
  const token = randomBytes(32).toString("base64url");
  await writeFile(file, `${token}\n`, { mode: 0o600 });
  return token;
}

function lanIpv4s(): string[] {
  const result: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === "IPv4" && !net.internal) result.push(net.address);
    }
  }
  return result;
}

/** 当前 web 是否已按期望运行；不符返回 false（调用方负责重启） */
async function webMatches(root: string, desired: WebState): Promise<boolean> {
  const state = await readJson<WebState>(webStatePath(root));
  if (!state || state.pid !== desired.pid) return false;
  return (
    state.port === desired.port &&
    state.host === desired.host &&
    state.tokenFingerprint === desired.tokenFingerprint &&
    state.trustLoopback === desired.trustLoopback &&
    pidAlive(state.pid) &&
    isWebCmdline(await cmdline(state.pid))
  );
}

async function startWeb(root: string, port: number, host: string, token: string | undefined, trustLoopback: boolean): Promise<number> {
  const args = [path.join(root, "scripts", "pi-web.ts"), "--port", String(port), "--host", host];
  if (token) args.push("--token", token);
  const pid = await spawnDetached(root, args, "web.log", trustLoopback ? { PI_WEB_TRUST_LOOPBACK: "1" } : {}, webPidPath(root));
  const state: WebState = { pid, port, host, tokenFingerprint: sha256Hex(token ?? ""), trustLoopback };
  await writeFile(webStatePath(root), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  // 短暂确认监听成功（失败时日志在 var/pi-relay/web.log）
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await probeWeb(port)) return pid;
    if (!pidAlive(pid)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!pidAlive(pid)) throw new Error(`pi-web 启动失败，详见 var/pi-relay/web.log`);
  return pid;
}

async function agentRunning(root: string): Promise<boolean> {
  const raw = await readText(agentPidPath(root));
  const pid = raw ? Number.parseInt(raw.trim(), 10) : NaN;
  return Number.isInteger(pid) && pidAlive(pid) && isAgentCmdline(await cmdline(pid));
}

/** 待批准提示：同一 pending 集合只提示一次（状态记 pending-hint.json） */
async function hintPending(root: string): Promise<void> {
  const pending = (await readPending(root)).filter((p) => p.status === "pending");
  const hintFile = path.join(relayDir(root), "pending-hint.json");
  const ids = pending.map((p) => p.id).sort().join(",");
  const last = await readText(hintFile);
  if (pending.length === 0) {
    if (last !== "") await writeFile(hintFile, "", { mode: 0o600 }).catch(() => {});
    return;
  }
  if (last === ids) return;
  console.log(`有 ${pending.length} 台设备等待批准，运行 node scripts/pi-relay.ts devices 查看`);
  await writeFile(hintFile, ids, { mode: 0o600 }).catch(() => {});
}

export type EnsureResult = { exposure: string; changed: boolean; messages: string[] };

/** 三态状态机主入口；调用方（CLI/shell）负责把错误降级为告警 */
export async function ensureWeb(root: string, settingsPath: string): Promise<EnsureResult> {
  const settings: WebSettings = await loadWebSettings(settingsPath);
  const port = Number.parseInt(process.env.PI_WEB_PORT ?? "7681", 10) || 7681;
  const messages: string[] = [];
  // 生命周期审计：记录配置路径与三态判定（ENOENT 会归为 off），供进程异常停止时溯源
  await audit(root, `ensure exposure=${settings.exposure} settings=${settingsPath} caller=${await callerDesc()}`);

  return withEnsureLock(root, async () => {
    const prevState = await readJson<{ exposure: string; webPid: number | null; agentPid: number | null }>(path.join(relayDir(root), "ensure-state.json"));

    if (settings.exposure === "off") {
      await stopWeb(root, port);
      await stopAgent(root);
      await writeFile(path.join(relayDir(root), "ensure-state.json"), JSON.stringify({ exposure: "off", webPid: null, agentPid: null }), { mode: 0o600 });
      return { exposure: "off", changed: prevState?.exposure !== "off", messages };
    }

    if (settings.exposure === "public" && !settings.relay) {
      throw new Error("webExposure=public 需要 webRelay 凭据（url/agentToken/caFingerprint）：请先在 ECS 运行 init 并把输出注入 pi/settings.local.json");
    }
    if (settings.exposure === "public") {
      const caFile = path.join(relayDir(root), "root-ca.crt");
      if (!(await readText(caFile))) {
        throw new Error("缺少中继 CA（var/pi-relay/root-ca.crt）：请先运行 node scripts/pi-relay.ts fetch-ca");
      }
    }

    const trustLoopback = settings.exposure === "public";
    const token = settings.exposure === "public" ? await ensureWebToken(root) : process.env.PI_WEB_TOKEN || undefined;
    const host = "0.0.0.0";
    const desired: WebState = { pid: 0, port, host, tokenFingerprint: sha256Hex(token ?? ""), trustLoopback };

    // 识别当前 web：托管 pidfile 优先，其次探活 + lsof/cmdline 归属核对（接管存量旧 nohup）
    let currentPid: number | null = null;
    const managed = await readJson<WebState>(webStatePath(root));
    if (managed && pidAlive(managed.pid) && isWebCmdline(await cmdline(managed.pid))) {
      currentPid = managed.pid;
    } else if (await probeWeb(port)) {
      const listener = await findWebListener(port);
      if (listener?.ours) currentPid = listener.pid;
      else if (listener) throw new Error(`端口 ${port} 被陌生进程占用（pid=${listener.pid}），请手动处理后重试`);
    } else {
      const listener = await findWebListener(port);
      if (listener && !listener.ours) throw new Error(`端口 ${port} 被陌生进程占用（pid=${listener.pid}），请手动处理后重试`);
    }

    let webPid = currentPid;
    if (currentPid !== null) {
      desired.pid = currentPid;
      if (!(await webMatches(root, desired))) {
        await stopPid(root, currentPid, "web-restart");
        await unlink(webStatePath(root)).catch(() => {});
        webPid = await startWeb(root, port, host, token, trustLoopback);
      }
    } else {
      webPid = await startWeb(root, port, host, token, trustLoopback);
    }

    let agentPid: number | null = null;
    if (settings.exposure === "public") {
      if (!(await agentRunning(root))) {
        agentPid = await spawnDetached(
          root,
          [path.join(root, "scripts", "pi-relay.ts"), "_agent"],
          "agent.log",
          { PI_WEB_PORT: String(port), PI_LOCAL_SETTINGS_PATH: settingsPath },
          agentPidPath(root),
        );
      } else {
        agentPid = Number.parseInt((await readText(agentPidPath(root)))!.trim(), 10);
      }
    } else {
      await stopAgent(root);
    }

    const changed = prevState?.exposure !== settings.exposure || prevState?.webPid !== webPid || prevState?.agentPid !== agentPid;
    if (changed) {
      if (settings.exposure === "lan") {
        for (const ip of lanIpv4s()) messages.push(`pi-web 局域网访问：http://${ip}:${port}${token ? `/?token=${token}` : ""}`);
      } else {
        const relayHost = new URL(settings.relay!.url).hostname;
        const relayPort = new URL(settings.relay!.url).port;
        messages.push(`pi-relay 公网入口：https://${relayHost}${relayPort && relayPort !== "443" ? `:${relayPort}` : ""}/（首次访问需本机批准配对）`);
        for (const ip of lanIpv4s()) messages.push(`pi-web 局域网直连：http://${ip}:${port}/?token=${token}`);
      }
    }
    await hintPending(root);
    await writeFile(path.join(relayDir(root), "ensure-state.json"), JSON.stringify({ exposure: settings.exposure, webPid, agentPid }), { mode: 0o600 });
    return { exposure: settings.exposure, changed, messages };
  });
}

/** 停止本机 web + agent 并清理状态 */
export async function stopAll(root: string): Promise<void> {
  const port = Number.parseInt(process.env.PI_WEB_PORT ?? "7681", 10) || 7681;
  await audit(root, `stop-all caller=${await callerDesc()}`);
  await withEnsureLock(root, async () => {
    await stopWeb(root, port);
    await stopAgent(root);
    await writeFile(path.join(relayDir(root), "ensure-state.json"), JSON.stringify({ exposure: "off", webPid: null, agentPid: null }), { mode: 0o600 });
  });
}

/** status 报告（仅本机终端展示；局域网 URL 含内部 token） */
export async function statusReport(root: string, settingsPath: string): Promise<string> {
  const settings = await loadWebSettings(settingsPath);
  const port = Number.parseInt(process.env.PI_WEB_PORT ?? "7681", 10) || 7681;
  const lines: string[] = [`webExposure：${settings.exposure}`];
  const web = await readJson<WebState>(webStatePath(root));
  if (web && pidAlive(web.pid)) lines.push(`pi-web：pid=${web.pid} ${web.host}:${web.port} trustLoopback=${web.trustLoopback}`);
  else lines.push("pi-web：未运行");
  const agentStatus = await readJson<{ state: string; lastHeartbeat: string | null }>(path.join(relayDir(root), "agent-status.json"));
  if (await agentRunning(root)) lines.push(`agent：${agentStatus?.state ?? "unknown"}${agentStatus?.lastHeartbeat ? ` 最近心跳=${agentStatus.lastHeartbeat}` : ""}`);
  else lines.push("agent：未运行");
  const devices = await readDevices(root);
  const pending = (await readPending(root)).filter((p) => p.status === "pending");
  lines.push(`可信设备：${devices.length} 台；待批准：${pending.length} 台`);
  if (settings.exposure !== "off") {
    const token = settings.exposure === "public" ? (await readText(path.join(relayDir(root), "web-token")))?.trim() : process.env.PI_WEB_TOKEN;
    for (const ip of lanIpv4s()) lines.push(`局域网直连：http://${ip}:${port}/?token=${token ?? ""}`);
    if (settings.exposure === "public" && settings.relay) {
      const url = new URL(settings.relay.url);
      lines.push(`公网入口：https://${url.hostname}${url.port && url.port !== "443" ? `:${url.port}` : ""}/`);
    }
  }
  return lines.join("\n");
}