import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_SESSION_HEADER_BYTES, canonicalizeCwd, normalizeSessionPath, readSessionHeaderBytes } from "./contract.ts";
import type {
  CommitSwitchTargetInput,
  ProcessOwnerRecord,
  RegistryStore,
  SwitchBlockReason,
  SwitchBlocked,
  SwitchIdentity,
  SwitchReservation,
  SwitchTarget,
} from "./registry.ts";
import {
  abortSwitchTarget,
  commitSwitchTarget,
  listLiveRecords,
  releaseOwnRecord,
  reserveSwitchTarget,
  updateOwnRecord,
} from "./registry.ts";

// S1b：受控运行期 session switch 的 lifecycle 绑定，消费 S1g §2/§4/§6 与 S1a 的三个公开事务 API。
// 身份只来自本次 ctx 的公开 getter（source）与目标文件的有界 header（target）；
// 事务只由 registry 在单个 guard 内完成，lifecycle 不再用 list→update 当作 CAS。

export type SessionIdentity = Readonly<{ cwd: string; sessionId: string | null; sessionFile: string | null }>;

// 通知分类：另一 owner 占用 / 目标身份不可验证 / 当前身份不可验证 / 未完成切换 / 登记故障 / 事件不受支持 / 内部异常。
// 后六类绝不允许被统一误称为「另一个 Pi 窗口占用」。
export type SessionOwnerNoticeKind =
  | "session-owned" | "target-unverifiable" | "source-unverifiable"
  | "transitioning" | "registry-failure" | "unsupported-event" | "internal-failure";

export type SessionOwnerBlock = Readonly<{ kind: SessionOwnerNoticeKind; reason: string; conflictingOwnerId?: string }>;
// lifecycle 内部形式仍带 cancel 布尔；extension 必须显式转换成 SDK 的 { cancel: true }。
export type BeforeSwitchDecision =
  | Readonly<{ cancel: false }>
  | Readonly<{ cancel: true; kind: SessionOwnerNoticeKind; reason: string; conflictingOwnerId?: string }>;
export type SessionStartInput = Readonly<{ reason?: unknown; previousSessionFile?: unknown }>;

export type SessionOwnerLifecycleDeps = Readonly<{
  store: RegistryStore; ownerId: string; pid: number;
  listLiveRecords?: typeof listLiveRecords; updateOwnRecord?: typeof updateOwnRecord; releaseOwnRecord?: typeof releaseOwnRecord;
  reserveSwitchTarget?: typeof reserveSwitchTarget; commitSwitchTarget?: typeof commitSwitchTarget; abortSwitchTarget?: typeof abortSwitchTarget;
  readHeaderBytes?: typeof readSessionHeaderBytes;
}>;

export class SessionOwnerTransitionError extends Error {
  readonly kind: SessionOwnerNoticeKind;
  readonly reason: string;
  readonly conflictingOwnerId?: string;
  constructor(block: SessionOwnerBlock, message: string, options?: Readonly<{ cause?: unknown }>) {
    super(message, options);
    this.name = "SessionOwnerTransitionError";
    this.kind = block.kind;
    this.reason = block.reason;
    if (block.conflictingOwnerId !== undefined) this.conflictingOwnerId = block.conflictingOwnerId;
  }
}

type CommitRequest =
  | Readonly<{ kind: "resume"; source: SwitchIdentity; reservationId: string; target: SwitchIdentity }>
  | Readonly<{ kind: "startup"; source: null; reservationId: null; target: SwitchIdentity }>
  | Readonly<{ kind: "reload"; source: SwitchIdentity; reservationId: null; target: SwitchIdentity }>
  | Readonly<{ kind: "new" | "fork"; source: SwitchIdentity; reservationId: null; target: SwitchIdentity }>;
type TargetResolution =
  | Readonly<{ kind: "resolved"; target: SwitchTarget }>
  | Readonly<{ kind: "unverifiable"; reason: string }>;
// 返回字符串时它就是不可验证原因；返回对象时才是已验证的 header 身份。
type HeaderLine = Readonly<{ id: string; cwd: string }> | string;

function block(kind: SessionOwnerNoticeKind, reason: string, conflictingOwnerId?: string): SessionOwnerBlock {
  return conflictingOwnerId === undefined ? { kind, reason } : { kind, reason, conflictingOwnerId };
}

function blockOf(error: SessionOwnerTransitionError): SessionOwnerBlock {
  return block(error.kind, error.reason, error.conflictingOwnerId);
}

// registry 的 blocked reason 映射为通知分类；owner-mismatch 意味着自身登记缺失/失效，属于登记故障而不是别人占用。
function noticeKind(reason: SwitchBlockReason): SessionOwnerNoticeKind {
  if (reason === "session-owned" || reason === "selector-active") return "session-owned";
  if (reason === "registry-busy" || reason === "registry-unavailable" || reason === "owner-mismatch") return "registry-failure";
  return "transitioning";
}

function blockedError(result: SwitchBlocked, label: string): SessionOwnerTransitionError {
  return new SessionOwnerTransitionError(block(noticeKind(result.reason), result.reason, result.conflictingOwnerId), `${label} was blocked: ${result.reason}`);
}

function cancelled(error: SessionOwnerTransitionError): BeforeSwitchDecision {
  return { cancel: true, ...blockOf(error) };
}

function sameIdentity(left: SwitchIdentity, right: SwitchIdentity): boolean {
  return left.cwd === right.cwd && left.sessionId === right.sessionId && left.sessionFile === right.sessionFile;
}

function recordIdentity(record: ProcessOwnerRecord): SwitchIdentity {
  return { cwd: record.cwd, sessionId: record.sessionId, sessionFile: record.sessionFile };
}

// 只有 phase reserved 仍占资源；committed/aborted 只是幂等 receipt。
function reservedOf(record: ProcessOwnerRecord): SwitchReservation | null {
  const reservation = record.switchReservation ?? null;
  return reservation !== null && reservation.phase === "reserved" ? reservation : null;
}

// 只有 phase reserved 的 target 仍占资源；committed/aborted 只是幂等 receipt。
function reservedTargetOf(record: ProcessOwnerRecord): SwitchTarget | null {
  const reservation = reservedOf(record);
  return reservation === null ? null : reservation.target;
}

function owns(record: ProcessOwnerRecord, deps: SessionOwnerLifecycleDeps): boolean {
  return record.ownerId === deps.ownerId && record.pid === deps.pid;
}

// 同一物理路径在 record 中可能是 resolve 形式（Pi 只在首条 user/assistant 消息时创建会话文件，
// 此时 realpath 不可得）或 realpath 形式（文件已落盘）。两者指向同一文件，都接受；
// 其他路径一律拒绝，不做更宽松的前缀、别名或 ID 推断。
function matchesStoredSessionFile(stored: string | null, resolved: string, canonical: string): boolean {
  return stored !== null && (stored === resolved || stored === canonical);
}

// 与 registry.claimsIdentity 等价的保守预检：只用于 new/fork 的 source 冲突核验（这两条路径没有 target 可交给 reserve）。
// 权威冲突判定始终在 registry 的 reserve/commit guard 内完成，这里不放宽也不新增占用语义。
function claimsIdentity(record: ProcessOwnerRecord, identity: SwitchIdentity): boolean {
  const reserved = reservedTargetOf(record);
  const file = identity.sessionFile;
  if (file !== null && (record.sessionFile === file || record.pendingSessionFile === file
    || (record.forkSource !== null && record.forkSource.sessionFile === file)
    || (reserved !== null && reserved.sessionFile === file))) return true;
  const sessionId = identity.sessionId;
  return sessionId !== null && ((record.cwd === identity.cwd && record.sessionId === sessionId)
    || (record.forkSource !== null && record.forkSource.cwd === identity.cwd && record.forkSource.sessionId === sessionId)
    || (reserved !== null && reserved.cwd === identity.cwd && reserved.sessionId === sessionId));
}

// SDK normalizePath/resolvePath 的默认规则（dist/utils/paths.js:61–91）：不 trim、不替换 Unicode 空格，
// 先展开 ~，再解码 file://，相对路径按真实 process.cwd() 解算；当前 POSIX 受控入口不承诺 Windows shell 路径转换。
function resolveEventPath(raw: string, baseCwd: string): string | null {
  let value = raw;
  const home = homedir();
  if (value === "~") return resolve(home);
  if (value.startsWith("~/")) value = join(home, value.slice(2));
  if (/^file:\/\//.test(value)) {
    try { value = fileURLToPath(value); } catch { return null; }
  }
  return isAbsolute(value) ? resolve(value) : resolve(baseCwd, value);
}

// 有界首行解析：预算 16KiB、首个 LF 截止、允许 EOF 无 LF 的完整短首行与 CRLF；
// 达到上限仍无 LF 说明首行不完整，必须拒绝。绝不回退到全文件读取或 SessionManager.open 探测。
function parseSessionHeaderLine(bytes: Buffer): HeaderLine {
  const lineEnd = bytes.indexOf(10);
  if (lineEnd < 0 && bytes.length >= MAX_SESSION_HEADER_BYTES) return "target-header-oversize";
  const line = (lineEnd < 0 ? bytes : bytes.subarray(0, lineEnd)).toString("utf8").replace(/\r$/, "");
  if (line === "") return bytes.length === 0 ? "target-empty" : "target-header-missing";
  let header: unknown;
  try { header = JSON.parse(line); } catch { return "target-header-invalid"; }
  if (!header || typeof header !== "object") return "target-header-invalid";
  const candidate = header as { type?: unknown; id?: unknown; cwd?: unknown };
  if (candidate.type !== "session") return "target-header-type";
  if (typeof candidate.id !== "string" || candidate.id === "" || candidate.id.includes("\0")) return "target-header-id";
  if (typeof candidate.cwd !== "string" || candidate.cwd === "") return "target-header-cwd";
  return { id: candidate.id, cwd: candidate.cwd };
}

// 目标身份只能由既存 regular file 的有界 header 证明；ENOENT 正是外部 import 在 before 时点的形状（blocked-upstream）。
function resolveSwitchTarget(raw: unknown, readHeader: (path: string) => Buffer): TargetResolution {
  if (typeof raw !== "string" || raw === "" || raw.includes("\0")) return { kind: "unverifiable", reason: "missing-target" };
  const resolved = resolveEventPath(raw, process.cwd());
  if (resolved === null) return { kind: "unverifiable", reason: "target-path-unparsable" };
  let sessionFile: string;
  // normalizeSessionPath 的 ENOENT fallback 不是「已验证目标」，因此随后必须 stat 成功且是 regular file。
  try { sessionFile = normalizeSessionPath(resolved, process.cwd()); }
  catch { return { kind: "unverifiable", reason: "target-path-unverifiable" }; }
  let info;
  try { info = statSync(sessionFile); }
  catch (error) {
    return { kind: "unverifiable", reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "blocked-upstream" : "target-stat-failed" };
  }
  if (!info.isFile()) return { kind: "unverifiable", reason: "target-not-a-file" };
  let bytes: Buffer;
  try { bytes = readHeader(sessionFile); } catch { return { kind: "unverifiable", reason: "target-header-unreadable" }; }
  const header = parseSessionHeaderLine(bytes);
  if (typeof header === "string") return { kind: "unverifiable", reason: header };
  // header cwd 允许不同于 source cwd（合法跨 cwd resume），但必须能 canonicalize 为既存目录。
  let cwd: string;
  try { cwd = canonicalizeCwd(header.cwd); } catch { return { kind: "unverifiable", reason: "target-cwd-unknown" }; }
  return { kind: "resolved", target: { cwd, sessionId: header.id, sessionFile } };
}

export function createSessionOwnerLifecycle(deps: SessionOwnerLifecycleDeps) {
  const list = deps.listLiveRecords ?? listLiveRecords;
  const update = deps.updateOwnRecord ?? updateOwnRecord;
  const release = deps.releaseOwnRecord ?? releaseOwnRecord;
  const reserve = deps.reserveSwitchTarget ?? reserveSwitchTarget;
  const commit = deps.commitSwitchTarget ?? commitSwitchTarget;
  const abort = deps.abortSwitchTarget ?? abortSwitchTarget;
  const readHeader = deps.readHeaderBytes ?? readSessionHeaderBytes;

  // source 三字段全部 canonical；cwd 不可验证或字段不可用时 fail closed，不用宽松身份代替。
  function canonicalSource(value: SessionIdentity): SessionIdentity {
    try {
      if (!value || typeof value !== "object") throw new Error("session identity is missing");
      const sessionId = value.sessionId ?? null;
      const sessionFile = value.sessionFile ?? null;
      // 空字串或带 NUL 的字段不得被静默归一化成 cwd/其他路径；这是 fail closed 校验，不是兼容 fallback。
      if (sessionId !== null && (typeof sessionId !== "string" || sessionId === "" || sessionId.includes("\0"))) throw new Error("session id is not usable");
      if (sessionFile !== null && (typeof sessionFile !== "string" || sessionFile === "" || sessionFile.includes("\0"))) throw new Error("session file is not usable");
      const cwd = canonicalizeCwd(value.cwd);
      return { cwd, sessionId, sessionFile: sessionFile === null ? null : normalizeSessionPath(sessionFile, cwd) };
    } catch (error) {
      throw new SessionOwnerTransitionError(block("source-unverifiable", "source-identity-unverifiable"), "current session identity cannot be canonicalized", { cause: error });
    }
  }

  async function snapshot(): Promise<readonly ProcessOwnerRecord[]> {
    try { return await list(deps.store); }
    catch (error) { throw new SessionOwnerTransitionError(block("registry-failure", "registry-unavailable"), "session owner registry is unavailable", { cause: error }); }
  }

  function ownFrom(records: readonly ProcessOwnerRecord[]): ProcessOwnerRecord {
    const own = records.find((record) => record.ownerId === deps.ownerId);
    if (!own) throw new SessionOwnerTransitionError(block("registry-failure", "owner-mismatch"), "this process holds no session owner record");
    // 同 ownerId 不同 pid 说明记录已不属于本进程；不得覆盖它。
    if (!owns(own, deps)) throw new SessionOwnerTransitionError(block("registry-failure", "owner-mismatch", own.ownerId), "session owner record does not belong to this process");
    return own;
  }

  async function ownRecord(): Promise<ProcessOwnerRecord> {
    return ownFrom(await snapshot());
  }

  function verifySource(own: ProcessOwnerRecord, source: SessionIdentity): void {
    if (own.state !== "active") {
      throw new SessionOwnerTransitionError(block("transitioning", own.state === "transitioning" ? "source-transitioning" : "source-not-active"), `current session owner record is not active: ${own.state}`);
    }
    if (!sameIdentity(recordIdentity(own), source)) {
      throw new SessionOwnerTransitionError(block("transitioning", "source-mismatch"), "current session identity does not match the retained owner record");
    }
  }

  function verifyNoForeignClaim(records: readonly ProcessOwnerRecord[], source: SessionIdentity): void {
    const foreign = records.find((record) => !owns(record, deps) && claimsIdentity(record, source));
    if (foreign) throw new SessionOwnerTransitionError(block("session-owned", "session-owned", foreign.ownerId), `another owner record claims the current session: ${foreign.ownerId}`);
  }

  async function commitTarget(request: CommitRequest): Promise<void> {
    // registry 在同一个 guard 内重新校验全部前置条件；这里的快照只是输入，不是 CAS。
    const input = { store: deps.store, ownerId: deps.ownerId, pid: deps.pid, ...request } as unknown as CommitSwitchTargetInput;
    const result = await commit(input);
    if (result.decision !== "committed") throw blockedError(result, "session switch commit");
  }

  // previousSessionFile 若存在，必须与持久 record 保留的 source file 规范匹配；缺失时只用 record 证据，不猜身份。
  function verifyPreviousSessionFile(raw: unknown, source: SwitchIdentity): void {
    if (raw === undefined || raw === null) return;
    if (typeof raw !== "string" || raw === "" || raw.includes("\0")) {
      throw new SessionOwnerTransitionError(block("transitioning", "previous-session-unverifiable"), "previous session file is not a usable path");
    }
    const resolved = resolveEventPath(raw, source.cwd);
    if (resolved === null) throw new SessionOwnerTransitionError(block("transitioning", "previous-session-unverifiable"), "previous session file cannot be resolved");
    let canonical: string;
    try { canonical = normalizeSessionPath(resolved, source.cwd); }
    catch { throw new SessionOwnerTransitionError(block("transitioning", "previous-session-unverifiable"), "previous session file cannot be normalized"); }
    if (!matchesStoredSessionFile(source.sessionFile, resolved, canonical)) {
      throw new SessionOwnerTransitionError(block("transitioning", "previous-session-mismatch"), "previous session file does not match the retained owner source");
    }
  }

  // shutdown 提供的 destination 只做规范化核对，不是提前 claim；不匹配就不写 transitioning，保留可重试的 active+pending。
  function verifyShutdownTarget(raw: unknown, target: SwitchTarget, baseCwd: string): void {
    if (raw === undefined || raw === null) return;
    if (typeof raw !== "string" || raw === "" || raw.includes("\0")) {
      throw new SessionOwnerTransitionError(block("transitioning", "shutdown-target-unverifiable"), "shutdown destination is not a usable path");
    }
    const resolved = resolveEventPath(raw, baseCwd);
    if (resolved === null) throw new SessionOwnerTransitionError(block("transitioning", "shutdown-target-unverifiable"), "shutdown destination cannot be resolved");
    let canonical: string;
    try { canonical = normalizeSessionPath(resolved, baseCwd); }
    catch { throw new SessionOwnerTransitionError(block("transitioning", "shutdown-target-unverifiable"), "shutdown destination cannot be normalized"); }
    if (!matchesStoredSessionFile(target.sessionFile, resolved, canonical)) {
      throw new SessionOwnerTransitionError(block("transitioning", "shutdown-target-mismatch"), "runtime opened a session file that was never reserved");
    }
  }

  // receipt 参数：undefined 表示省略字段以保留 live reservation；null 表示显式清除终态 receipt。
  async function transition(source: SessionIdentity, receipt: null | undefined): Promise<void> {
    const input = {
      store: deps.store, ownerId: deps.ownerId, pid: deps.pid, state: "transitioning" as const,
      cwd: source.cwd, sessionId: source.sessionId, sessionFile: source.sessionFile,
    };
    try {
      await update(receipt === undefined ? input : { ...input, switchReservation: null });
    } catch (error) {
      throw new SessionOwnerTransitionError(block("registry-failure", "registry-unavailable"), "cannot record the transitional session owner state", { cause: error });
    }
  }

  async function start(value: SessionIdentity, event: SessionStartInput = {}): Promise<void> {
    const identity = canonicalSource(value);
    const reason = event?.reason;
    // startup/reload 不需要目标事务：startup 走 launcher 原可启动规则，reload 只做同 guard 原子验证。
    if (reason === "startup") return commitTarget({ kind: "startup", source: null, reservationId: null, target: identity });
    if (reason === "reload") return commitTarget({ kind: "reload", source: identity, reservationId: null, target: identity });
    // resume/new/fork 与未知 reason 都必须先读持久 record 作为 source 证据；未知 reason 读取后 fail closed。
    const own = await ownRecord();
    if (reason !== "resume" && reason !== "new" && reason !== "fork") {
      throw new SessionOwnerTransitionError(block("unsupported-event", "unknown-session-start-reason"), `unsupported session_start reason: ${String(reason)}`);
    }
    const source = recordIdentity(own);
    verifyPreviousSessionFile(event?.previousSessionFile, source);
    if (reason === "resume") {
      // 新 extension 只用持久 receipt 重建 plain token；session_start 事件本身不携带 reservationId。
      const reservation = own.switchReservation ?? null;
      if (reservation === null || reservation.phase === "aborted") {
        throw new SessionOwnerTransitionError(block("transitioning", "stale-reservation"), "no reserved switch receipt is available for this resume");
      }
      if (!sameIdentity(reservation.source, source)) {
        throw new SessionOwnerTransitionError(block("transitioning", "source-mismatch"), "reserved switch source does not match the retained owner record");
      }
      // commit guard 会重新校验 nonce、source、target 与 transitioning 状态；此处不预先放宽。
      return commitTarget({ kind: "resume", source: reservation.source, reservationId: reservation.reservationId, target: identity });
    }
    return commitTarget({ kind: reason, source, reservationId: null, target: identity });
  }

  async function beforeSwitch(reason: unknown, targetSessionFile: unknown, value: SessionIdentity): Promise<BeforeSwitchDecision> {
    try {
      if (reason !== "new" && reason !== "resume") {
        throw new SessionOwnerTransitionError(block("unsupported-event", "unknown-before-switch-reason"), `unsupported session_before_switch reason: ${String(reason)}`);
      }
      const source = canonicalSource(value);
      const records = await snapshot();
      const own = ownFrom(records);
      verifySource(own, source);
      if (reason === "new") {
        // pending 存在时改选 new 一律拒绝；不放弃原 pending，也不偷偷换目标。
        if (reservedOf(own) !== null) throw new SessionOwnerTransitionError(block("transitioning", "transition-in-progress"), "an unfinished switch target is still pending");
        verifyNoForeignClaim(records, source);
        return { cancel: false };
      }
      // resume：先用有界 header 验证既存目标身份，再在 open 之前交给 reserve guard。
      // 幂等重试（同 source+target 返回原 nonce）与 pending 换目标拒绝均由 registry 在同一 guard 内权威判定。
      const resolved = resolveSwitchTarget(targetSessionFile, readHeader);
      if (resolved.kind === "unverifiable") {
        throw new SessionOwnerTransitionError(block("target-unverifiable", resolved.reason), `switch target identity is unverifiable: ${resolved.reason}`);
      }
      const result = await reserve({ store: deps.store, ownerId: deps.ownerId, pid: deps.pid, source, target: resolved.target });
      if (result.decision !== "reserved") throw blockedError(result, "switch target reservation");
      return { cancel: false };
    } catch (error) {
      // handler 自身必须把已知失败转成 cancel；非预期异常交给 extension 的 catch（它同样显式 cancel）。
      if (error instanceof SessionOwnerTransitionError) return cancelled(error);
      throw error;
    }
  }

  async function beforeFork(value: SessionIdentity): Promise<BeforeSwitchDecision> {
    try {
      // before_fork 事件不携带目标身份：只核验 source 可用性与冲突，不宣称前置 claim 新目标。
      const source = canonicalSource(value);
      const records = await snapshot();
      const own = ownFrom(records);
      verifySource(own, source);
      if (reservedOf(own) !== null) throw new SessionOwnerTransitionError(block("transitioning", "transition-in-progress"), "an unfinished switch target is still pending");
      verifyNoForeignClaim(records, source);
      return { cancel: false };
    } catch (error) {
      if (error instanceof SessionOwnerTransitionError) return cancelled(error);
      throw error;
    }
  }

  async function shutdown(reason: unknown, targetSessionFile: unknown, read: () => SessionIdentity): Promise<void> {
    // quit 只释放自身 record；旧 ctx 可能已失效，因此这条路径绝不依赖 identity 读取。
    if (reason === "quit") return release({ store: deps.store, ownerId: deps.ownerId, pid: deps.pid });
    // reload 不释放、不清 pending、不改 source：owner 记录仍由本进程持有，旧 ctx 先失效不影响归属。
    if (reason === "reload") return;
    if (reason !== "resume" && reason !== "new" && reason !== "fork") {
      throw new SessionOwnerTransitionError(block("unsupported-event", "unknown-shutdown-reason"), `unsupported session_shutdown reason: ${String(reason)}`);
    }
    const source = canonicalSource(read());
    const own = await ownRecord();
    verifySource(own, source);
    const reservation = reservedOf(own);
    if (reason === "resume") {
      // 省略 pendingSessionFile/switchReservation：source 与 target pending 原样保留，只把 state 改 transitioning。
      if (reservation !== null) {
        verifyShutdownTarget(targetSessionFile, reservation.target, source.cwd);
        return transition(source, undefined);
      }
      // 无 live reservation 时，终态 receipt 与 transitioning 不自洽（S1g §4 的 record 不变量），显式清 null。
      return transition(source, null);
    }
    // new/fork 只在无 live reservation 时才应到达这里；仍保留 source，不做新目标 ID/file claim。
    if (reservation !== null) throw new SessionOwnerTransitionError(block("transitioning", "transition-in-progress"), "an unfinished switch target is still pending");
    return transition(source, null);
  }

  // 本批没有任何事件路径会自动调用它：SDK 不公开 switch 结果 hook，lifecycle 无法证明 teardown 尚未发生。
  // 仅供明确知道尚未 teardown 的合法调用方或隔离测试使用（S1g §4），不构成运行期 rollback 承诺。
  async function abortReservedTarget(value: SessionIdentity): Promise<void> {
    const source = canonicalSource(value);
    const own = await ownRecord();
    const reservation = reservedOf(own);
    if (reservation === null) throw new SessionOwnerTransitionError(block("transitioning", "stale-reservation"), "no reserved switch receipt is available to abort");
    const result = await abort({ store: deps.store, ownerId: deps.ownerId, pid: deps.pid, source, target: reservation.target, reservationId: reservation.reservationId });
    if (result.decision !== "aborted") throw blockedError(result, "switch target abort");
  }

  return Object.freeze({ start, beforeSwitch, beforeFork, shutdown, abortReservedTarget });
}
