import pty from "node-pty";
import { chmod, readdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";

const execFileAsync = promisify(execFile);

export type PiWebOptions = {
  /** HTTP 监听端口 */
  port: number;
  /** HTTP 监听地址，默认 0.0.0.0 以便局域网访问 */
  host: string;
  /** 可选访问令牌；未设置时同一局域网内任何设备都可控制终端 */
  token?: string;
  /** tmux 会话名前缀（本机 pi 命令使用；手机端仅浏览与进入，不提供创建） */
  session: string;
  /** tmux 会话初始尺寸；之后跟随最后接入的客户端（window-size latest） */
  cols: number;
  rows: number;
  /** pi 进程工作目录 */
  cwd: string;
  /** 在 tmux 里启动 pi 的完整命令，默认走仓内 launcher */
  command: string[];
};

export type SessionInfo = { name: string; windows: number; created: string; attached: boolean };

type ClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

type ServerMessage = { type: "hello"; cols: number; rows: number };

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function here(rel: string): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), rel);
}

async function resolvePackageFile(pkg: string, rel: string): Promise<string> {
  const pkgJson = fileURLToPath(import.meta.resolve(`${pkg}/package.json`));
  return path.join(path.dirname(pkgJson), rel);
}

/**
 * node-pty 的官方 prebuild 下载不保留 spawn-helper 的执行位，
 * 且本机 npm allow-scripts 会拦截安装脚本，这里在启动时统一修复：
 * 已有 prebuilds 时补执行位；缺失时调用官方 prebuild.js 下载。
 */
export async function ensureNodePtyReady(): Promise<void> {
  const pkgDir = path.dirname(fileURLToPath(import.meta.resolve("node-pty/package.json")));
  const prebuildsDir = path.join(pkgDir, "prebuilds");
  let platforms: string[] = [];
  try {
    platforms = await readdir(prebuildsDir);
  } catch {
    // prebuilds 目录不存在，尝试下载
  }
  if (platforms.length === 0) {
    await new Promise<void>((resolve, reject) => {
      const child = execFile(process.execPath, ["scripts/prebuild.js"], { cwd: pkgDir });
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("node-pty prebuild 下载失败"))));
      child.on("error", reject);
    });
    platforms = await readdir(prebuildsDir);
  }
  for (const platform of platforms) {
    const helper = path.join(prebuildsDir, platform, "spawn-helper");
    try {
      const st = await stat(helper);
      if ((st.mode & 0o111) === 0) await chmod(helper, 0o755);
    } catch {
      // 非 unix 平台没有 spawn-helper，忽略
    }
  }
}

/** 枚举本机局域网 IPv4 地址，用于打印手机可访问的 URL */
export function lanUrls(port: number): string[] {
  const urls: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === "IPv4" && !net.internal) urls.push(`http://${net.address}:${port}`);
    }
  }
  return urls;
}

async function tmux(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync("tmux", args, { cwd, encoding: "utf8" });
  return stdout;
}

/** 检查 tmux 是否可用，返回版本号（如 "3.5a"）；不可用时抛出中文错误。 */
export async function checkTmux(): Promise<string> {
  try {
    const version = (await tmux(["-V"])).trim(); // 形如 "tmux 3.5a"
    return version.replace(/^tmux\s+/, "");
  } catch {
    throw new Error("未找到 tmux。请先安装：brew install tmux");
  }
}

/** 比较点分版本号（忽略字母后缀），a >= b 返回 true。 */
function versionAtLeast(version: string, major: number, minor: number): boolean {
  const [ma, mb] = version.split(".").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(ma)) return false;
  if (ma !== major) return ma > major;
  return (Number.isFinite(mb) ? mb : 0) >= minor;
}

/** 列出当前全部 tmux 会话（即手机可接入的全部终端会话）。 */
export async function listTmuxSessions(): Promise<SessionInfo[]> {
  try {
    const out = await tmux([
      "list-sessions",
      "-F",
      "#{session_name}\t#{session_windows}\t#{session_created_string}\t#{session_attached}",
    ]);
    return out
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const [name, windows, created, attached] = line.split("\t");
        return {
          name,
          windows: Number(windows) || 1,
          created,
          attached: attached !== "0",
        };
      });
  } catch {
    // tmux server 尚未启动（没有任何会话）时 list-sessions 报错，返回空列表
    return [];
  }
}

async function applyTmuxTuning(tmuxVersion: string): Promise<void> {
  // TUI 体验选项（幂等设置；tmux server 尚未启动（零会话）时会失败，安全跳过，
  // 待首次创建会话后由 pi() 侧的调优补设）：
  // - escape-time：Esc 延迟从默认 500ms 降到 10ms，否则 TUI 内按 Esc 会明显迟滞
  // - RGB overrides：让 24bit 真彩色穿透 tmux
  // - extended-keys：pi 官方推荐，让 Shift+Enter / Ctrl+Enter 等修饰键穿透 tmux
  const settings: Array<[string[], boolean]> = [
    [["set-option", "-s", "escape-time", "10"], false],
    [["set-option", "-as", "terminal-overrides", ",*:RGB"], false],
    [["set-option", "-g", "extended-keys", "on"], false],
    // mouse on：备用屏应用（pi fullscreen）自带滚轮处理，tmux 默认转发（send-keys -M）；
    // 主屏会话走 copy-mode 滚 tmux 历史，并重绑为逐行滚动（默认 5 行，触屏不跟手）。
    // 注意：多命令必须作为单个参数传入，分号独立 token 会被 tmux 当命令分隔符致绑定截断。
    [["set-option", "-g", "mouse", "on"], false],
    // 恢复出厂默认：备用屏应用（pi）转发滚轮自滚，主屏会话进 copy-mode。
    // 注：手写同款 if-shell 绑定时嵌套 format 求值异常，故用 unbind 回落到默认。
    [["unbind-key", "-T", "root", "WheelUpPane"], false],
    [["bind-key", "-T", "copy-mode", "WheelUpPane", "select-pane ; send-keys -X -N 1 scroll-up"], false],
    [["bind-key", "-T", "copy-mode", "WheelDownPane", "select-pane ; send-keys -X -N 1 scroll-down"], false],
    [["bind-key", "-T", "copy-mode-vi", "WheelUpPane", "select-pane ; send-keys -X -N 1 scroll-up"], false],
    [["bind-key", "-T", "copy-mode-vi", "WheelDownPane", "select-pane ; send-keys -X -N 1 scroll-down"], false],
  ];
  if (versionAtLeast(tmuxVersion, 3, 5)) settings.push([["set-option", "-g", "extended-keys-format", "csi-u"], false]);
  for (const [args] of settings) {
    try {
      await tmux(args);
    } catch {
      // 无 tmux server 时跳过；有会话后重试即可
    }
  }
}

/** tmux 会话名白名单：避免目标语法（冒号、点号）注入与歧义 */
const SESSION_NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;

export async function startPiWebServer(opts: PiWebOptions): Promise<{ server: Server; close: () => Promise<void>; urls: string[] }> {
  await ensureNodePtyReady();
  const tmuxVersion = await checkTmux();
  await applyTmuxTuning(tmuxVersion);

  const [xtermJs, xtermCss, fitJs] = await Promise.all([
    readFile(await resolvePackageFile("@xterm/xterm", "lib/xterm.js")),
    readFile(await resolvePackageFile("@xterm/xterm", "css/xterm.css")),
    readFile(await resolvePackageFile("@xterm/addon-fit", "lib/addon-fit.js")),
  ]);

  const assets: Record<string, { body: string | Buffer; type: string }> = {
    "/": { body: (await readFile(here("public/index.html"))).toString("utf8").replaceAll("__BUILD__", new Date().toISOString().slice(11, 19)), type: MIME[".html"]! },
    "/xterm.js": { body: xtermJs, type: MIME[".js"]! },
    "/xterm.css": { body: xtermCss, type: MIME[".css"]! },
    "/xterm-fit.js": { body: fitJs, type: MIME[".js"]! },
  };

  const wss = new WebSocketServer({ noServer: true });
  const checkToken = (url: URL): boolean => !opts.token || url.searchParams.get("token") === opts.token;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!checkToken(url)) {
      res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
      res.end("令牌无效：请在 URL 上携带 ?token=...");
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/sessions") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ sessions: await listTmuxSessions() }));
      return;
    }
    const asset = assets[url.pathname];
    if (!asset || req.method !== "GET") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    res.writeHead(200, { "content-type": asset.type, "cache-control": "no-store" });
    res.end(asset.body);
  });

  const livePties = new Set<pty.IPty>();
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws" || !checkToken(url)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    const sessionName = url.searchParams.get("session") ?? opts.session;
    wss.handleUpgrade(req, socket, head, async (ws) => {
      // 消息缓冲：tmux 校验与 pty spawn 是异步的，在此之前到达的 resize/input 先排队，
      // 避免“首次 resize 丢失导致手机始终显示原始会话尺寸”的竞态。
      const pending: string[] = [];
      let attach: pty.IPty | null = null;
      const dispatch = (raw: string) => {
        if (!attach) {
          pending.push(raw);
          return;
        }
        let msg: ClientMessage;
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }
        if (msg.type === "input") attach.write(msg.data);
        else if (msg.type === "resize") {
          const cols = Math.max(2, Math.min(500, Math.floor(msg.cols)));
          const rows = Math.max(2, Math.min(300, Math.floor(msg.rows)));
          try {
            attach.resize(cols, rows);
          } catch {
            // attach 退出瞬间 resize 可能失败，忽略
          }
        }
      };
      ws.on("message", (raw) => dispatch(String(raw)));
      // 每个浏览器连接 attach 一次 tmux：多设备天然同步，pi 生命周期与连接解耦。
      // 剥离父会话的 session-owner 标识，避免 web 会话被父会话门控误判。
      const env = { ...process.env, TERM: "xterm-256color" } as Record<string, string>;
      delete env.PI_SESSION_OWNER_ID;
      delete env.PI_SESSION_OWNER_REGISTRY;
      try {
        if (!SESSION_NAME_RE.test(sessionName)) throw new Error(`会话名不合法：${sessionName}`);
        await tmux(["has-session", "-t", sessionName]); // 只 attach 已存在会话，由列表页负责创建
        attach = pty.spawn("tmux", ["attach-session", "-t", sessionName], {
          name: "xterm-256color",
          cols: opts.cols,
          rows: opts.rows,
          cwd: opts.cwd,
          env,
        });
        const att = attach;
        livePties.add(att);
        ws.send(JSON.stringify({ type: "hello", cols: att.cols, rows: att.rows } satisfies ServerMessage));
        att.onData((data) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "output", data }));
        });
        att.onExit(() => {
          livePties.delete(att);
          // attach 断开只代表此客户端离开；pi 会话由 tmux 保活。客户端会自动重连。
          if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close();
        });
        for (const raw of pending.splice(0)) dispatch(raw); // 回放就绪前到达的消息
        ws.on("close", () => {
          try {
            att.kill();
          } catch {
            // 已退出则忽略
          }
          livePties.delete(attach);
        });
      } catch (error) {
        // tmux 不可用或会话创建失败：把原因透给客户端展示。
        const reason = error instanceof Error ? error.message : String(error);
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "output", data: `\r\n\x1b[31m[pi-web 会话不可用：${reason}]\x1b[0m\r\n` }));
        ws.close();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(opts.port, opts.host, resolve));
  const close = async () => {
    for (const ws of wss.clients) ws.close();
    for (const p of livePties) {
      try {
        p.kill();
      } catch {
        // 忽略
      }
    }
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { server, close, urls: lanUrls(opts.port) };
}
