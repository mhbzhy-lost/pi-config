import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { captureProcessBirthIdentity } from "../subagent-dispatch/process-birth-identity.ts";

/**
 * One canonical identity for `PI_CODING_WORKSPACE_DIR`.
 *
 * The workspace ledger partitions durable state by the realpath of the state
 * root, so a symlinked alias (`/var/...` on macOS) and its target
 * (`/private/var/...`) must resolve to the same value everywhere: coordinator
 * registry metadata, workspace service/ledger and the read-only audit.
 * Missing trailing segments are preserved because the state root is created
 * lazily by the ledger.
 */
export function canonicalWorkspaceStateRoot(value: string): string {
  const requested = path.resolve(value);
  let cursor = requested;
  const missing: string[] = [];
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error("workspace state root has no available ancestor");
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  return missing.reduce((current, segment) => path.join(current, segment), realpathSync(cursor));
}

export const COORDINATOR_METADATA_FILE = "coordinator.json";
export type CoordinatorMetadata = { protocol: string; instanceId: string; pid: number; birthIdentity: string; repositoryId: string; storageRepositoryId: string; canonicalStateRoot: string; endpoint: string; supersededStateRoots?: string[] };
const protocol = "repository-workspace-coordinator.v1";

export function createCoordinatorRegistry(options: { commonDir: string; stateRoot: string; diagnosticSink?: (entry: unknown) => void }) {
  const diagnose = (entry: unknown) => {
    try { options.diagnosticSink?.(entry); } catch (diagnosticError) { console.error("[coordinator-registry] diagnostic sink failed", { entry, diagnosticError }); }
  };
  const metadataDir = path.join(options.commonDir, ".pi-coordinator");
  const repositoryHash = createHash("sha256").update(path.resolve(options.commonDir)).digest("hex");
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "user";
  const runtimeRoot = process.platform === "win32"
    ? `\\\\.\\pipe\\pi-workspace-coordinator-${uid}`
    : path.join("/tmp", `pi-workspace-coordinator-${uid}`);
  const dir = runtimeRoot;
  const endpointHash = repositoryHash.slice(0, 32);
  const endpoint = process.platform === "win32" ? `${runtimeRoot}-${endpointHash}` : path.join(runtimeRoot, `${endpointHash}.sock`);
  const metadataPath = path.join(metadataDir, COORDINATOR_METADATA_FILE);
  const lockPath = `${metadataPath}.lock`;
  // Resolved at claim time: the ledger may create the state root afterwards.
  const canonicalStateRoot = () => canonicalWorkspaceStateRoot(options.stateRoot);
  async function read(): Promise<CoordinatorMetadata> {
    let value: unknown;
    try { value = JSON.parse(await readFile(metadataPath, "utf8")); } catch (error) { throw new Error(`Coordinator metadata is invalid: ${error.message}`); }
    if (!value || typeof value !== "object" || (value as any).protocol !== protocol || !(value as any).instanceId) throw new Error("Coordinator metadata is invalid");
    return value as CoordinatorMetadata;
  }
  async function writeRaw(value: string) { await mkdir(metadataDir, { recursive: true, mode: 0o700 }); await chmod(metadataDir, 0o700); await writeFile(metadataPath, value, { mode: 0o600 }); }
  async function claim(input: { repositoryId: string; storageRepositoryId: string }): Promise<CoordinatorMetadata> {
    await mkdir(metadataDir, { recursive: true, mode: 0o700 }); await chmod(metadataDir, 0o700);
    if (process.platform !== "win32") { await mkdir(dir, { recursive: true, mode: 0o700 }); await chmod(dir, 0o700); }
    let existing: CoordinatorMetadata | undefined;
    let supersededStateRoots: string[] = [];
    try { existing = await read(); } catch (error) {
      if (!String(error?.message).includes("ENOENT") && !String(error?.message).includes("invalid")) throw error;
      await unlink(metadataPath).catch(() => undefined);
    }
    if (existing) {
      if (existing.repositoryId !== input.repositoryId) throw new Error("Coordinator repository scope mismatch");
      if (existing.storageRepositoryId && existing.storageRepositoryId !== input.storageRepositoryId) throw new Error("Coordinator storage repository scope mismatch");
      let ownerState: "alive" | "dead" | "mismatch" | "undetermined" = "undetermined";
      if (existing.pid > 0 && typeof existing.birthIdentity === "string" && /^[a-f0-9]{64}$/.test(existing.birthIdentity)) {
        try {
          const observed = await captureProcessBirthIdentity(existing.pid);
          ownerState = observed === existing.birthIdentity ? "alive" : "mismatch";
          if (ownerState === "mismatch") diagnose({ version: 1, phase: "coordinator-owner-mismatch", reason: "birth-identity-mismatch", owner: existing });
        } catch (error: any) {
          let errno = error?.cause?.code ?? error?.code;
          if (errno !== "ESRCH") {
            try { process.kill(existing.pid, 0); } catch (signalError: any) {
              if (signalError?.code === "ESRCH") {
                errno = "ESRCH";
                diagnose({ version: 1, phase: "coordinator-owner-dead", reason: "process-not-found", error: signalError, cause: error, errno, owner: existing });
              } else errno = signalError?.code ?? errno;
            }
          }
          ownerState = errno === "ESRCH" ? "dead" : "undetermined";
          if (ownerState === "dead" && error?.cause?.code === "ESRCH") diagnose({ version: 1, phase: "coordinator-owner-dead", reason: "process-not-found", error, cause: error?.cause, errno, owner: existing });
          if (ownerState === "undetermined") diagnose({ version: 1, phase: "coordinator-owner-liveness-undetermined", error, cause: error?.cause, errno, owner: existing });
        }
      } else {
        diagnose({ version: 1, phase: "coordinator-owner-identity-invalid", owner: existing });
      }
      // A legacy metadata file can still carry the aliased form; comparing
      // canonical values keeps one coordinator scope per state root. An
      // unusable recorded root fails closed as a scope mismatch.
      let recorded: string | undefined;
      try { recorded = canonicalWorkspaceStateRoot(existing.canonicalStateRoot); } catch { recorded = undefined; }
      const inherited = Array.isArray(existing.supersededStateRoots) ? existing.supersededStateRoots.filter((value): value is string => typeof value === "string") : [];
      if (ownerState === "alive") {
        // A live owner holds the single repository endpoint, so a different
        // canonical state root is an unrecoverable split brain. A recorded
        // root that cannot be resolved is equally unusable.
        if (recorded !== canonicalStateRoot()) throw new Error("Coordinator state root scope mismatch");
        return existing;
      }
      // Only a confirmed dead owner (ESRCH or observed identity mismatch)
      // may be replaced; a wall-clock TTL or a missing socket never
      // authorizes it. The abandoned canonical state root is retained so the
      // audit keeps reporting the migration debt instead of erasing history.
      if (ownerState === "undetermined") throw new Error("Coordinator owner liveness is undetermined");
      supersededStateRoots = [...new Set(typeof recorded === "string" && recorded !== canonicalStateRoot() ? [...inherited, recorded] : inherited)];
      await unlink(metadataPath).catch(() => undefined);
    }
    let handle;
    try { handle = await open(lockPath, "wx", 0o600); } catch {
      // A SIGKILL can leave the lock behind. Reclaim it only when the recorded
      // owner is confirmed dead (pid unavailable or birth identity mismatch);
      // a live owner's lock survives any wall-clock age (a slow claim is not
      // a deadlock). Legacy locks without owner data keep the TTL fallback.
      if (await lockOwnerIsDead()) { await unlink(lockPath); return claim(input); }
      await new Promise((resolve) => setTimeout(resolve, 10));
      return claim(input);
    }
    try {
      // Record the owner identity so a racing claim can distinguish a live
      // slow owner from a SIGKILL leftover.
      await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, birthIdentity: await captureProcessBirthIdentity(process.pid) })}\n`, { mode: 0o600 });
      try { existing = await read(); if (existing) return existing; } catch { /* claim */ }
      const metadata: CoordinatorMetadata = { protocol, instanceId: randomBytes(16).toString("hex"), pid: process.pid,
        birthIdentity: await captureProcessBirthIdentity(process.pid), repositoryId: input.repositoryId, storageRepositoryId: input.storageRepositoryId,
        canonicalStateRoot: canonicalStateRoot(), endpoint,
        // The replacement is written through one atomic temp+rename so the
        // endpoint owner and the recorded canonical state root never diverge.
        ...(supersededStateRoots.length ? { supersededStateRoots } : {}) };
      const temp = `${metadataPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(temp, `${JSON.stringify(metadata)}\n`, { mode: 0o600 }); await rename(temp, metadataPath); await chmod(metadataPath, 0o600);
      return metadata;
    } finally { await handle.close(); await unlink(lockPath).catch(() => undefined); }
  }
  // 遗留 lock 的回收判定：带 owner 数据时仅确认 owner 死亡（pid 不可用或
  // birth identity 不匹配）才回收；无 owner 数据的旧格式 lock 退回 TTL 兜底。
  async function lockOwnerIsDead(): Promise<boolean> {
    let owner: { pid?: unknown; birthIdentity?: unknown } | undefined;
    try {
      owner = JSON.parse((await readFile(lockPath, "utf8")).trim());
    } catch { owner = undefined; }
    if (!owner || typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.birthIdentity !== "string" || !/^[a-f0-9]{64}$/.test(owner.birthIdentity)) {
      try {
        const age = Date.now() - (await stat(lockPath)).mtimeMs;
        return age > 30_000;
      } catch { return false; }
    }
    try {
      const observed = await captureProcessBirthIdentity(owner.pid);
      if (observed !== owner.birthIdentity) {
        const error = new Error("coordinator lock owner birth identity mismatch");
        error.code = "COORDINATOR_OWNER_IDENTITY_MISMATCH";
        diagnose({ version: 1, phase: "coordinator-lock-owner-mismatch", error, reason: "birth-identity-mismatch", owner });
        return true;
      }
      return false;
    } catch (error: any) {
      const cause = error?.cause;
      let errno = cause?.code ?? error?.code;
      if (errno !== "ESRCH") {
        try { process.kill(owner.pid, 0); } catch (signalError: any) {
          if (signalError?.code === "ESRCH") {
            diagnose({ version: 1, phase: "coordinator-lock-owner-dead", reason: "process-not-found", error: signalError, cause: error, errno: "ESRCH", owner });
            return true;
          }
          errno = signalError?.code ?? errno;
        }
      }
      diagnose({ version: 1, phase: errno === "ESRCH" ? "coordinator-lock-owner-dead" : "coordinator-lock-liveness-check-failed", ...(errno === "ESRCH" ? { reason: "process-not-found" } : {}), error, cause, errno, owner });
      return errno === "ESRCH";
    }
  }
  async function release() {
    const current = await read().catch(() => undefined);
    if (current?.pid !== process.pid) return;
    let identity: string;
    try { identity = await captureProcessBirthIdentity(process.pid); } catch { return; }
    // 保留 metadata：durable audit（coordinator.status=observed）依赖它，而 claim
    // 路径已具备 pid+birth-identity 活性检查与 stale-owner 接管，退出删除只会
    // 让验收 settlement 在 daemon idle-exit 后永久失明（R12f）。
    if (identity === current.birthIdentity) await unlink(`${metadataPath}.lock`).catch(() => undefined);
  }
  return { dir, metadataDir, metadataPath, endpoint, read, writeRaw, claim, release };
}
