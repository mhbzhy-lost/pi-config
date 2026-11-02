import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
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
export type CoordinatorMetadata = { protocol: string; kind?: string; instanceId: string; pid: number; birthIdentity: string; repositoryId: string; storageRepositoryId: string; canonicalStateRoot: string; endpoint: string; supersededStateRoots?: string[] };
const protocol = "repository-workspace-coordinator.v1";

/**
 * 四态活性判定（alive/dead/mismatch/undetermined）：daemon 登记与 spawn 锁
 * 共用的唯一活性语义；undetermined（权限未知、identity 不可读等）一律由调用
 * 方 fail-closed，不得当作 stale 覆盖。
 */
export async function classifyCoordinatorOwner(owner: { pid?: unknown; birthIdentity?: unknown }, diagnosticSink?: (entry: unknown) => void): Promise<"alive" | "dead" | "mismatch" | "undetermined"> {
  const diagnose = (entry: unknown) => { try { diagnosticSink?.(entry); } catch { /* 诊断失败不影响判定 */ } };
  if (typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
      || typeof owner.birthIdentity !== "string" || !/^[a-f0-9]{64}$/.test(owner.birthIdentity)) return "undetermined";
  try {
    const observed = await captureProcessBirthIdentity(owner.pid);
    if (observed === owner.birthIdentity) return "alive";
    diagnose({ version: 1, phase: "coordinator-owner-mismatch", reason: "birth-identity-mismatch", owner });
    return "mismatch";
  } catch (error) {
    let errno = (error as { cause?: { code?: string } })?.cause?.code ?? (error as { code?: string }).code;
    if (errno !== "ESRCH") {
      try { process.kill(owner.pid, 0); } catch (signalError) {
        if ((signalError as { code?: string }).code === "ESRCH") errno = "ESRCH";
        else errno = (signalError as { code?: string }).code ?? errno;
      }
    }
    if (errno === "ESRCH") {
      diagnose({ version: 1, phase: "coordinator-owner-dead", reason: "process-not-found", error, errno, owner });
      return "dead";
    }
    diagnose({ version: 1, phase: "coordinator-owner-liveness-undetermined", error, errno, owner });
    return "undetermined";
  }
}

/**
 * 同步四态活性判定：与 classifyCoordinatorOwner 同语义，用 execFileSync 的 ps
 * 探测换取同步契约（audit 只读投影要求同步返回）；供只读管理面消费。
 */
export function classifyCoordinatorOwnerSync(owner: { pid?: unknown; birthIdentity?: unknown }, diagnosticSink?: (entry: unknown) => void): "alive" | "dead" | "mismatch" | "undetermined" {
  const diagnose = (entry: unknown) => { try { diagnosticSink?.(entry); } catch { /* 诊断失败不影响判定 */ } };
  if (typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
      || typeof owner.birthIdentity !== "string" || !/^[a-f0-9]{64}$/.test(owner.birthIdentity)) return "undetermined";
  const killProbe = (): "alive" | "dead" | "undetermined" => {
    try { process.kill(owner.pid as number, 0); return "alive"; }
    catch (signalError) {
      if ((signalError as { code?: string }).code === "ESRCH") return "dead";
      return "undetermined";
    }
  };
  let output: Buffer | undefined;
  try {
    output = execFileSync("ps", ["-ww", "-p", String(owner.pid), "-o", "lstart=", "-o", "command="], { encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] });
  } catch (error) {
    // ps 失败不能宜判死亡：以 kill 探测区分 ESRCH 与权限/其他未知。
    const probe = killProbe();
    diagnose({ version: 1, phase: probe === "dead" ? "coordinator-owner-dead" : "coordinator-owner-liveness-undetermined", errno: (error as { code?: string }).code, owner });
    return probe;
  }
  if (!output || output.length === 0 || output.toString("utf8").trim().length === 0) {
    const probe = killProbe();
    diagnose({ version: 1, phase: probe === "dead" ? "coordinator-owner-dead" : "coordinator-owner-liveness-undetermined", reason: "empty-ps-output", owner });
    return probe;
  }
  const observed = createHash("sha256").update(output).digest("hex");
  if (observed === owner.birthIdentity) return "alive";
  diagnose({ version: 1, phase: "coordinator-owner-mismatch", reason: "birth-identity-mismatch", owner });
  return "mismatch";
}

/**
 * 提供只读 read、原子 writeRaw 与路径/endpoint 推导；claim/release 的 owner
 * 语义与锁文件协议已随 in-process coordinator 形态移除（生命周期归
 * coordinator-daemon + coordinator-spawn 所有）。
 */
export function createCoordinatorRegistry(options: { commonDir: string; stateRoot: string; diagnosticSink?: (entry: unknown) => void }) {
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
  async function read(): Promise<CoordinatorMetadata> {
    let value: unknown;
    try { value = JSON.parse(await readFile(metadataPath, "utf8")); } catch (error) { throw new Error(`Coordinator metadata is invalid: ${(error as Error).message}`); }
    if (!value || typeof value !== "object" || (value as any).protocol !== protocol || !(value as any).instanceId) throw new Error("Coordinator metadata is invalid");
    return value as CoordinatorMetadata;
  }
  /** 原子登记写（temp+rename）：崩溃中断不会留下半写 metadata。 */
  async function writeRaw(value: string): Promise<void> {
    await mkdir(metadataDir, { recursive: true, mode: 0o700 });
    await chmod(metadataDir, 0o700);
    const temp = `${metadataPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(temp, value, { mode: 0o600 });
      await rename(temp, metadataPath);
      await chmod(metadataPath, 0o600);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  }
  return { dir, metadataDir, metadataPath, endpoint, read, writeRaw, classify: (owner: { pid?: unknown; birthIdentity?: unknown }) => classifyCoordinatorOwner(owner, options.diagnosticSink) };
}
