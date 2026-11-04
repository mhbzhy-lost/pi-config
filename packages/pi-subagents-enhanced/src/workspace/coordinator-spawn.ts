// coordinator daemon 拉起器：spawn 文件锁 + 四态 fail-closed 活性判定 +
// startupReady 握手。只负责「确保 daemon 存在并返回 metadata」，不建业务
// client（client 由 coordinator-client.ts 用 metadata + brokerRegistration 建立）。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { open, readFile, stat, unlink, type FileHandle } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { captureProcessBirthIdentity } from "../subagent-dispatch/process-birth-identity.ts";
import { canonicalWorkspaceStateRoot, classifyCoordinatorOwner, createCoordinatorRegistry, type CoordinatorMetadata } from "./coordinator-registry.ts";

const DAEMON_ENTRY = fileURLToPath(new URL("./coordinator-daemon.ts", import.meta.url));
const SHA256 = /^[a-f0-9]{64}$/;

export type CoordinatorDaemonHandle = { metadata: CoordinatorMetadata };
export type EnsureCoordinatorDaemonInput = {
  stateRoot: string;
  repositoryId: string;
  storageRepositoryId?: string;
  /** origin 仓库 .git 根（metadata 登记目录由其推导）。 */
  commonDir: string;
  endpoint: string;
  spawnTimeoutMs?: number;
  /** 透传给 daemon 的归零宽限毫秒数（缺省用 daemon 默认 60s）。 */
  idleExitGraceMs?: number;
};

function failure(code: string, message: string, cause?: unknown): Error & { code: string } {
  const error = new Error(message, cause === undefined ? undefined : { cause }) as Error & { code: string };
  error.code = code;
  return error;
}

const diagnosticSinkLocal = (entry: unknown) => { try { console.error(`[coordinator-spawn] ${JSON.stringify(entry)}`); } catch { /* 诊断失败不影响拉起 */ } };

function probeEndpoint(endpoint: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(endpoint);
    // 结算与销毁都绑定本次调用创建的 socket，且幂等：peer 提前 end/close 时同样
    // 结算为「不可用」。socket 被销毁后空闲超时定时器不再触发，缺少 end/close
    // 结算会让探测永久 pending，因此这里必须显式结算。
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("end", () => finish(false));
    socket.once("close", () => finish(false));
  });
}

/** startupReady 握手：startup.ping 仅在 startup recovery 完成后 ready:true。 */
function pingStartup(endpoint: string, timeoutMs = 1000): Promise<{ instanceId: string; ready: boolean } | undefined> {
  return new Promise((resolve) => {
    const socket = net.createConnection(endpoint);
    let settled = false;
    let buffer = "";
    // 完成函数幂等并绑定本次 socket：成功、错误、超时、peer 提前 end/close 都只
    // 结算一次，且释放本调用自己创建的 socket。peer 在完整响应前断开一律结算为
    // 既有失败结果 undefined（fail-closed），绝不降级成 ready:true，也不留下
    // 永久 pending 的握手等待。
    const finish = (value: { instanceId: string; ready: boolean } | undefined) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(undefined));
    socket.once("connect", () => socket.write(`${JSON.stringify({ protocol: "repository-workspace-coordinator.v1", requestId: "startup-ping", method: "startup.ping" })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      try {
        const reply = JSON.parse(buffer.slice(0, index));
        if (reply.ok !== true || typeof reply.result?.instanceId !== "string" || typeof reply.result?.ready !== "boolean") return finish(undefined);
        finish({ instanceId: reply.result.instanceId, ready: reply.result.ready });
      } catch { finish(undefined); }
    });
    socket.once("error", () => finish(undefined));
    socket.once("end", () => finish(undefined));
    socket.once("close", () => finish(undefined));
  });
}

async function readDaemonLogTail(stateRoot: string, repositoryId: string, lines = 20): Promise<string> {
  try {
    const logPath = path.join(canonicalWorkspaceStateRoot(stateRoot), "logs", `coordinator-${repositoryId.slice(0, 16)}.log`);
    const content = await readFile(logPath, "utf8");
    return content.split("\n").filter(Boolean).slice(-lines).join("\n");
  } catch { return ""; }
}

/**
 * 取得 spawn 排他锁，只返回本次成功 open 得到的句柄。
 * 循环内只解释 open 自身的 EEXIST（竞争者语义）：没有取得锁的调用不得 close 或
 * unlink 他人的锁。持锁后的初始化异常不属于竞争者分支，由调用方在同一 finally
 * 内释放本调用拥有的句柄与锁。
 */
async function acquireSpawnLock(lockPath: string, deadline: number): Promise<FileHandle> {
  for (;;) {
    try {
      return await open(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      let raw: string | undefined;
      try { raw = (await readFile(lockPath, "utf8")).trim(); } catch { raw = undefined; }
      if (raw === "") {
        // 空锁 = 持有者处在「创建→写入 owner」窗口内：短暂重试等待写入完成；
        // 锁文件消失 = 持有者已完成并释放，直接重试获取；长时间空锁（持有者
        // 写前崩溃）按 malformed fail-closed，不猜测覆盖。
        let age = 0;
        try { age = Date.now() - (await stat(lockPath)).mtimeMs; }
        catch (statError) {
          if ((statError as { code?: string }).code === "ENOENT") { await new Promise((resolve) => setTimeout(resolve, 10)); continue; }
          throw statError;
        }
        if (age < 2_000 && Date.now() < deadline) { await new Promise((resolve) => setTimeout(resolve, 25)); continue; }
        throw failure("COORDINATOR_SPAWN_LOCK_UNDETERMINED", `spawn lock 持有者未完成登记（${lockPath}）；请人工核对后清理`);
      }
      let owner: { pid?: unknown; birthIdentity?: unknown } | undefined;
      try { owner = JSON.parse(raw); } catch { owner = undefined; }
      // 锁内容 malformed：无法证明持有者死亡，一律 fail-closed，不做 TTL 覆盖。
      if (!owner || typeof owner !== "object") throw failure("COORDINATOR_SPAWN_LOCK_UNDETERMINED", `spawn lock 无法解析（${lockPath}）；请人工核对后清理`);
      const lockState = await classifyCoordinatorOwner(owner, diagnosticSinkLocal);
      // 仅「pid 不可达（dead）」可回收；mismatch（pid 复用）/undetermined 一律
      // fail-closed（D4）：不得以推断覆盖锁持有者。
      if (lockState === "dead") {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (lockState === "mismatch" || lockState === "undetermined") {
        throw failure("COORDINATOR_SPAWN_LOCK_UNDETERMINED", `spawn lock 持有者活性无法确认（pid ${String(owner.pid)}，${lockState}）；请人工核对后清理 ${lockPath}`);
      }
      if (lockState === "alive") {
        if (Date.now() >= deadline) throw failure("COORDINATOR_SPAWN_LOCK_TIMEOUT", `spawn lock 被存活进程（pid ${owner.pid}）持有超时`);
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      throw failure("COORDINATOR_SPAWN_LOCK_UNDETERMINED", `spawn lock 持有者活性无法确认（pid ${String(owner.pid)}）；请人工核对后清理 ${lockPath}`);
    }
  }
}

export async function ensureCoordinatorDaemon(input: EnsureCoordinatorDaemonInput): Promise<CoordinatorDaemonHandle> {
  if (!SHA256.test(input.repositoryId ?? "")) throw failure("COORDINATOR_SPAWN_USAGE", "repositoryId 必须是 sha256");
  if (input.storageRepositoryId !== undefined && !SHA256.test(input.storageRepositoryId)) throw failure("COORDINATOR_SPAWN_USAGE", "storageRepositoryId 必须是 sha256");
  const spawnTimeoutMs = input.spawnTimeoutMs ?? 10_000;
  // endpoint 父目录（/tmp/pi-workspace-coordinator-<uid>）在首次拉起前创建并设 0700；
  // registry 已无 claim 路径，目录保证由拉起器与 daemon 自身共同承担。
  if (process.platform !== "win32") {
    mkdirSync(path.dirname(input.endpoint), { recursive: true, mode: 0o700 });
    chmodSync(path.dirname(input.endpoint), 0o700);
  }
  const registry = createCoordinatorRegistry({ commonDir: input.commonDir, stateRoot: input.stateRoot });
  const canonicalStateRoot = canonicalWorkspaceStateRoot(input.stateRoot);
  const storageRepositoryId = input.storageRepositoryId ?? input.repositoryId;
  const validateScope = (metadata: CoordinatorMetadata) => {
    if (metadata.repositoryId !== input.repositoryId || (metadata.storageRepositoryId && metadata.storageRepositoryId !== storageRepositoryId)
        || metadata.endpoint !== input.endpoint) {
      throw failure("COORDINATOR_SCOPE_MISMATCH", "coordinator metadata 仓库范围不匹配");
    }
    try {
      if (canonicalWorkspaceStateRoot(metadata.canonicalStateRoot) !== canonicalStateRoot) throw new Error("state root mismatch");
    } catch (cause) {
      throw failure("COORDINATOR_SCOPE_MISMATCH", "coordinator metadata state root 范围不可用", cause);
    }
  };

  // ① 既有 metadata 的四态分类（只读，不接管不覆盖）。
  let existing: CoordinatorMetadata | undefined;
  try { existing = await registry.read(); } catch (error) {
    if (!String((error as Error)?.message).includes("ENOENT") && !String((error as Error)?.message).includes("invalid")) throw error;
    existing = undefined;
  }
  if (existing) {
    validateScope(existing);
    const state = await classifyCoordinatorOwner(existing, diagnosticSinkLocal);
    const connectable = await probeEndpoint(input.endpoint);
    if (state === "alive") {
      if (connectable) return { metadata: existing };
      // owner 活着但 endpoint 连不上：可能仍是旧 in-process coordinator 收缩形态，
      // fail-closed 提示重启该 Host，绝不覆盖活进程。
      throw failure("COORDINATOR_LOCKED_BY_LIVE_OWNER", `coordinator owner pid ${existing.pid} 存活但 endpoint 不可用；请重启该 Host 后重试`);
    }
    if (state === "undetermined" || state === "mismatch") {
      throw failure("COORDINATOR_OWNER_UNDETERMINED", `coordinator owner 活性无法确认（pid ${existing.pid}，${state}）；请人工核对后清理 ${registry.metadataPath}`);
    }
    // dead：落入下方锁内清理 + 拉起。
  }

  // ② spawn 文件锁（O_EXCL + 四态陈旧判定，fail-closed 矩阵）：只有本次成功
  // open 的调用返回句柄，也才有 close/unlink 的资格。
  const lockPath = `${input.endpoint}.spawn.lock`;
  const deadline = Date.now() + spawnTimeoutMs;
  const lockHandle = await acquireSpawnLock(lockPath, deadline);
  try {
    // ②b 持锁初始化：身份采集与锁内容写入也在同一资源所有权范围内。capture 或
    // writeFile 失败必须保留原始 error/code/cause 原样抛到 finally，由 finally
    // 显式关闭本次句柄并释放本次锁，不得把持锁后的异常当作竞争者状态。
    await lockHandle.writeFile(`${JSON.stringify({ pid: process.pid, birthIdentity: await captureProcessBirthIdentity(process.pid) })}\n`, "utf8");

    // ③ 锁内 double-check：其他拉起者可能刚刚完成。
    const recheck = await pingStartup(input.endpoint, 1000);
    if (recheck?.ready) {
      const fresh = await registry.read();
      validateScope(fresh);
      if (fresh.instanceId === recheck.instanceId) return { metadata: fresh };
    }
    // endpoint 清理守卫：可连接但 startup.ping 无效 = 存在未知协议的活跃
    // listener（旧 coordinator 或非 coordinator 进程），fail-closed 不清理；
    // 仅连接被拒/不存在时才可安全移除陈旧 socket 文件。
    if (await probeEndpoint(input.endpoint)) {
      throw failure("COORDINATOR_LOCKED_BY_LIVE_OWNER", `endpoint ${input.endpoint} 存在活跃但无法握手确认的 listener；请人工核对后处理`);
    }
    // 清理已确认死亡 owner 的陈旧产物（锁内独占执行）。
    if (existing) await unlink(registry.metadataPath).catch(() => undefined);
    await unlink(input.endpoint).catch(() => undefined);

    // ④ detached spawn daemon；spawn 同步失败（ENOENT 等）经 error 事件收敛到统一错误码。
    const args = [DAEMON_ENTRY, "--state-root", input.stateRoot, "--repository-id", input.repositoryId,
      "--storage-repository-id", storageRepositoryId, "--endpoint", input.endpoint, "--common-dir", input.commonDir];
    if (input.idleExitGraceMs !== undefined) args.push("--idle-exit-grace-ms", String(input.idleExitGraceMs));
    let spawnError: Error | undefined;
    const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", env: process.env });
    child.once("error", (error) => { spawnError = error; });
    child.unref();

    // ⑤ startupReady 握手 + metadata 就绪重试（daemon 在 ready 后原子登记）。
    const handshakeDeadline = Date.now() + spawnTimeoutMs;
    for (;;) {
      const ping = await pingStartup(input.endpoint, 1000);
      if (ping?.ready) {
        for (let attempt = 0; attempt < 40; attempt += 1) {
          try {
            const metadata = await registry.read();
            validateScope(metadata);
            if (metadata.instanceId === ping.instanceId) return { metadata };
            throw failure("COORDINATOR_SPAWN_FAILED", "daemon 登记的 instanceId 与握手结果不一致");
          } catch (error) {
            if ((error as { code?: string }).code?.startsWith("COORDINATOR_")) throw error;
            if (Date.now() >= handshakeDeadline) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
      }
      if (Date.now() >= handshakeDeadline) {
        const tail = await readDaemonLogTail(input.stateRoot, input.repositoryId);
        throw failure("COORDINATOR_SPAWN_FAILED", `coordinator daemon 拉起超时（${spawnTimeoutMs}ms）${spawnError ? `；spawn 失败：${String((spawnError as Error)?.message ?? spawnError)}` : ""}${tail ? `；daemon 日志尾部：\n${tail}` : ""}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    // 释放顺序与既有策略一致：先关本次句柄再删本次锁；清理失败只记录诊断，
    // 不掩盖首因、也不把清理失败伪装成业务成功。
    await lockHandle.close().catch((error: unknown) => {
      diagnosticSinkLocal({ phase: "spawn-lock-close-failed", lockPath, error: String((error as Error)?.message ?? error) });
    });
    await unlink(lockPath).catch((error: unknown) => {
      diagnosticSinkLocal({ phase: "spawn-lock-unlink-failed", lockPath, error: String((error as Error)?.message ?? error) });
    });
  }
}
