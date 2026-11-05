#!/usr/bin/env node
// workspace coordinator 守护进程入口（无主模型）：由拉起器 detached spawn，
// 不属于任何会话 Host。生命周期 = 引用计数：
//   - 引用 = Host 到本 daemon 的持久连接，进程任何死法下由内核保证关闭；
//   - 统一 idle 快照（连接/在途/保留注册全零）持续宽限期 → 优雅退出；
//   - startup recovery 完成后才以 temp+rename 原子登记 metadata；
//   - 退出清理以 metadata.instanceId 比对守卫，防止旧实例误删新实例产物。
import { appendFileSync, chmodSync, closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { captureProcessBirthIdentity } from "../subagent-dispatch/process-birth-identity.ts";
import { canonicalWorkspaceStateRoot, COORDINATOR_METADATA_FILE } from "./coordinator-registry.ts";
import { createCoordinatorServer } from "./coordinator-server.ts";

export const COORDINATOR_DAEMON_PROTOCOL = "repository-workspace-coordinator.v1";
export const COORDINATOR_DAEMON_METADATA_KIND = "daemon";
export const COORDINATOR_DAEMON_DEFAULT_IDLE_EXIT_GRACE_MS = 60_000;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_INSTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;

export type CoordinatorDaemonOptions = {
  /** workspace ledger 状态根（PI_CODING_WORKSPACE_DIR 语义）。 */
  stateRoot: string;
  repositoryId: string;
  storageRepositoryId?: string;
  /** coordinator unix socket 绝对路径。 */
  endpoint: string;
  /** 仓库公共目录（origin 仓库 .git 根）；提供时 daemon 自行登记 metadata。 */
  commonDir?: string;
  /** 外部指定的实例标识（兼容既有 env 形拉起）；缺省随机生成。 */
  instanceId?: string;
  /** 归零宽限毫秒数。 */
  idleExitGraceMs?: number;
  /** 是否把 console/stderr 重定向到 state root 下日志文件（CLI 形态 true，env wrapper 形态 false）。 */
  logToFile?: boolean;
};

function usageFailure(message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = "COORDINATOR_DAEMON_USAGE";
  return error;
}

export function parseCoordinatorDaemonArgs(argv: readonly string[]): CoordinatorDaemonOptions {
  const spec = new Map([
    ["--state-root", "stateRoot"],
    ["--repository-id", "repositoryId"],
    ["--storage-repository-id", "storageRepositoryId"],
    ["--endpoint", "endpoint"],
    ["--common-dir", "commonDir"],
    ["--instance-id", "instanceId"],
    ["--idle-exit-grace-ms", "idleExitGraceMs"],
  ]);
  const out: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = spec.get(argv[index]!);
    if (!key) throw usageFailure(`未知参数: ${argv[index]}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw usageFailure(`参数缺少值: ${argv[index]}`);
    out[key] = value;
    index += 1;
  }
  if (typeof out.stateRoot !== "string" || !path.isAbsolute(out.stateRoot) || path.normalize(out.stateRoot) !== out.stateRoot || out.stateRoot.includes("\0")) {
    throw usageFailure("--state-root 必须是规范绝对路径");
  }
  if (typeof out.repositoryId !== "string" || !SHA256.test(out.repositoryId)) throw usageFailure("--repository-id 必须是 sha256");
  if (out.storageRepositoryId !== undefined && !SHA256.test(out.storageRepositoryId)) throw usageFailure("--storage-repository-id 必须是 sha256");
  if (typeof out.endpoint !== "string" || !path.isAbsolute(out.endpoint)) throw usageFailure("--endpoint 必须是绝对路径");
  if (out.commonDir !== undefined && (!path.isAbsolute(out.commonDir) || path.normalize(out.commonDir) !== out.commonDir)) throw usageFailure("--common-dir 必须是规范绝对路径");
  if (out.instanceId !== undefined && !SAFE_INSTANCE_ID.test(out.instanceId)) throw usageFailure("--instance-id 非法");
  const grace = Number(out.idleExitGraceMs ?? COORDINATOR_DAEMON_DEFAULT_IDLE_EXIT_GRACE_MS);
  if (!Number.isSafeInteger(grace) || grace <= 0) throw usageFailure("--idle-exit-grace-ms 必须是正整数");
  return {
    stateRoot: out.stateRoot,
    repositoryId: out.repositoryId,
    storageRepositoryId: out.storageRepositoryId,
    endpoint: out.endpoint,
    commonDir: out.commonDir,
    instanceId: out.instanceId,
    idleExitGraceMs: grace,
  };
}

function redirectConsoleToLog(logPath: string): void {
  try {
    mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
    try {
      if (statSync(logPath).size > 1024 * 1024) {
        const descriptor = openSync(logPath, "r+");
        try { ftruncateSync(descriptor, 0); } finally { closeSync(descriptor); }
      }
    } catch { /* 首次运行无日志文件 */ }
    const write = (chunk: unknown): boolean => {
      try { appendFileSync(logPath, typeof chunk === "string" ? chunk : `${String(chunk)}`); } catch { /* 日志失败不阻断 daemon */ }
      return true;
    };
    const line = (parts: unknown[]) => write(parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" ") + "\n");
    console.log = (...args: unknown[]) => void line(args);
    console.info = (...args: unknown[]) => void line(args);
    console.warn = (...args: unknown[]) => void line(args);
    console.error = (...args: unknown[]) => void line(args);
    (process.stdout.write as unknown) = write as typeof process.stdout.write;
    (process.stderr.write as unknown) = write as typeof process.stderr.write;
  } catch { /* 重定向失败保持原始终端输出 */ }
}

export async function runCoordinatorDaemon(options: CoordinatorDaemonOptions): Promise<number> {
  const canonicalStateRoot = canonicalWorkspaceStateRoot(options.stateRoot);
  // endpoint 父目录自建（与拉起器共同承担；0700）。
  if (process.platform !== "win32") {
    mkdirSync(path.dirname(options.endpoint), { recursive: true, mode: 0o700 });
    chmodSync(path.dirname(options.endpoint), 0o700);
  }
  const metadataDir = options.commonDir ? path.join(options.commonDir, ".pi-coordinator") : undefined;
  const metadataPath = metadataDir ? path.join(metadataDir, COORDINATOR_METADATA_FILE) : undefined;
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  if (options.logToFile !== false) {
    redirectConsoleToLog(path.join(canonicalStateRoot, "logs", `coordinator-${options.repositoryId.slice(0, 16)}.log`));
  }
  // 本实例的出生身份只采集一次并缓存：它既是 metadata 登记事实，也是退出守卫的
  // 比对依据（守卫必须在同一个同步块内完成「比对 → 删除」，不得中间 await）。
  let selfBirthIdentity: string | undefined;
  async function ownBirthIdentity() {
    selfBirthIdentity ??= await captureProcessBirthIdentity(process.pid);
    return selfBirthIdentity;
  }
  /** 原子登记 durable owner 事实（temp + rename）；重入幂等（内容相同）。 */
  function registerMetadata() {
    if (!metadataDir || !metadataPath) return;
    const metadata = {
      protocol: COORDINATOR_DAEMON_PROTOCOL,
      kind: COORDINATOR_DAEMON_METADATA_KIND,
      instanceId: server.instanceId,
      pid: process.pid,
      birthIdentity: selfBirthIdentity,
      repositoryId: options.repositoryId,
      storageRepositoryId: options.storageRepositoryId ?? options.repositoryId,
      canonicalStateRoot,
      endpoint: options.endpoint,
    };
    mkdirSync(metadataDir, { recursive: true, mode: 0o700 });
    chmodSync(metadataDir, 0o700);
    const temp = `${metadataPath}.${process.pid}.${Date.now().toString(16)}.tmp`;
    writeFileSync(temp, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
    renameSync(temp, metadataPath);
    chmodSync(metadataPath, 0o600);
  }
  // recovery 事件投递：daemon 无 pi.sendMessage 快路径，一律落 durable 并记
  // delivery debt，由 Host 侧 recovery.status 轮询通道等价消费（D7）。
  const server = createCoordinatorServer({
    endpoint: options.endpoint,
    repositoryId: options.repositoryId,
    storageRepositoryId: options.storageRepositoryId,
    instanceId: options.instanceId,
    stateRoot: canonicalStateRoot,
    recoveryEventSink: async () => ({ state: "debt", reason: "coordinator daemon durable-only delivery; hosts poll recovery.status" }),
    // 审计 #18：endpoint 一绑定就发布 durable owner 事实。既有「startup recovery
    // 完成后才登记」在「daemon 已存活并已开始恢复」的整个窗口里让 registry 报告
    // “本仓无 coordinator”：拉起器已删掉死 owner 的 metadata，而新 daemon 尚未
    // 重登记（实测 0.4–2s），期间的 proof replay 已写出回执却读不到 owner。
    // readiness 仍是独立事实（startup.ping.ready），由拉起器等待。
    onListening: async () => { await ownBirthIdentity(); registerMetadata(); },
    diagnosticSink: (entry) => { try { console.error(`[coordinator-daemon] ${JSON.stringify(entry)}`); } catch { /* 已被重定向或失败时忽略 */ } },
  });
  let shuttingDown = false;
  let shutdownResult: Promise<number> | undefined;
  const shutdown = (code: number): Promise<number> => {
    if (shuttingDown) return shutdownResult!;
    shuttingDown = true;
    shutdownResult = (async () => {
      // 退出清理守卫：仅当 metadata 可验证且 instanceId+pid+birthIdentity 全部
      // 属于本实例时才删除 socket/metadata；不可验证或已属新实例时一律不动，
      // 防止旧进程误删新实例产物。
      //
      // 判定与删除必须同在一个同步块：既有实现先 readFileSync 比对，再
      // `await captureProcessBirthIdentity(process.pid)`（ps 子进程，实测可达
      // 400ms 级），最后才 unlink——期间新实例（或拉起器）可原子覆盖
      // metadata，旧进程随后删掉的是**新实例的登记**。缓存出生身份后不再跨
      // await，检查与动作之间不再有 JS 可调度的窗口。
      let unlinkEndpoint = false;
      if (metadataPath) {
        let current: { instanceId?: unknown; pid?: unknown; birthIdentity?: unknown } | undefined;
        try { current = JSON.parse(readFileSync(metadataPath, "utf8")); } catch { current = undefined; }
        if (current && typeof current.instanceId === "string" && current.instanceId === server.instanceId
            && current.pid === process.pid && typeof current.birthIdentity === "string"
            && selfBirthIdentity !== undefined && current.birthIdentity === selfBirthIdentity) {
          unlinkEndpoint = true;
          try { unlinkSync(metadataPath); } catch { /* 已被替换或删除：绝不动他人登记 */ }
        }
      } else {
        // 无 metadata 管理（env wrapper 兼容形态）：endpoint 归本进程所有。
        unlinkEndpoint = true;
      }
      await server.close({ unlinkEndpoint }).catch(() => undefined);
      return code;
    })();
    return shutdownResult;
  };
  process.once("SIGTERM", () => { void shutdown(0).then((code) => process.exit(code)); });
  process.once("SIGINT", () => { void shutdown(0).then((code) => process.exit(code)); });
  try {
    await server.listen();
  } catch (error) {
    console.error(`[coordinator-daemon] listen failed: ${String((error as Error)?.message ?? error)}`);
    // endpoint 已有活 listener（EADDRINUSE 且探测存活）：双 daemon 防护，退出码 3。
    return (error as { code?: string })?.code === "EADDRINUSE" ? 3 : 1;
  }
  if (shuttingDown) return await shutdownResult!;
  // 不再二次登记：durable owner 事实已在 endpoint 绑定时（onListening）原子发布，
  // 这里重写只是同一个事实的重复写入，反而在 fixture 拆除与写入重叠时制造
  // ENOTEMPTY 类噪声。早登记失败会直接使 listen() 失败，走 fail-closed。
  originalStdoutWrite(`${JSON.stringify({
    protocol: COORDINATOR_DAEMON_PROTOCOL,
    ...(metadataPath ? { kind: COORDINATOR_DAEMON_METADATA_KIND } : {}),
    repositoryId: options.repositoryId,
    storageRepositoryId: options.storageRepositoryId ?? options.repositoryId,
    instanceId: server.instanceId,
    endpoint: options.endpoint,
  })}\n`);
  // 引用计数归零监视：统一 idle 快照全零持续宽限期后退出。
  const graceMs = options.idleExitGraceMs ?? COORDINATOR_DAEMON_DEFAULT_IDLE_EXIT_GRACE_MS;
  await new Promise<void>((resolve) => {
    let idleSince: number | undefined;
    const tickMs = Math.min(1000, Math.max(50, Math.floor(graceMs / 4)));
    const timer = setInterval(() => {
      if (shuttingDown) { clearInterval(timer); resolve(); return; }
      const snapshot = server.idleSnapshot();
      const idle = snapshot.clients === 0 && snapshot.active === 0 && snapshot.retained === 0;
      if (!idle) { idleSince = undefined; return; }
      idleSince ??= Date.now();
      if (Date.now() - idleSince >= graceMs) { clearInterval(timer); resolve(); }
    }, tickMs);
    timer.unref?.();
  });
  return await shutdown(0);
}

const invokedAsMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invokedAsMain) {
  try {
    process.exitCode = await runCoordinatorDaemon(parseCoordinatorDaemonArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`${(error as { code?: string })?.code ?? "COORDINATOR_DAEMON_ERROR"}: ${(error as Error)?.message ?? error}`);
    process.exit((error as { code?: string })?.code === "COORDINATOR_DAEMON_USAGE" ? 2 : 1);
  }
}
