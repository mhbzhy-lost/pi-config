import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

// 受控运行期 session switch 事务身份（S1g §3）：全部字段必须是已规范化 absolute 值，registry 只做精确比较，不做路径解析或探测。
export type SwitchIdentity = Readonly<{ cwd: string; sessionId: string | null; sessionFile: string | null }>;
export type SwitchTarget = Readonly<{ cwd: string; sessionId: string; sessionFile: string }>;
export type SwitchReservation = Readonly<{
  reservationId: string;
  source: SwitchIdentity;
  target: SwitchTarget;
  phase: "reserved" | "committed" | "aborted";
}>;

export type ProcessOwnerRecord = Readonly<{
  protocol: "pi-session-owner.v1";
  ownerId: string;
  pid: number;
  cwd: string;
  sessionId: string | null;
  sessionFile: string | null;
  state: "pending" | "selecting" | "active" | "transitioning";
  pendingSessionFile: string | null;
  forkSource: ForkSource | null;
  // 缺字段的 legacy v1 record 等价 null；字段存在但畸形或与其他字段不一致时整条 record fail closed。
  switchReservation?: SwitchReservation | null;
  startedAt: string;
}>;

export type ForkSource = Readonly<{ cwd: string; sessionFile: string; sessionId: string }>;

export type RegistryStore = Readonly<{
  root: string;
  guardTimeoutMs: number;
  uid?: () => number | undefined;
  ownershipUid?: (path: string, observedUid: number) => number;
}>;
export type LaunchReservation =
  | { kind: "new"; rejectSelecting?: boolean }
  | { kind: "selecting" }
  | { kind: "session"; cwd: string; sessionFile: string; sessionId: string | null }
  | { kind: "session-id"; cwd: string; sessionId: string }
  | { kind: "fork-source"; cwd: string; source: ForkSource };
export type PrepareLaunchInput = Readonly<{ store: RegistryStore; pid: number; ownerId: string; startedAt: string; reservation?: LaunchReservation; resolveReservation?: () => Promise<LaunchReservation> }>;
export type BlockReason = "session-owned" | "session-id-owned" | "selector-active" | "active-owner-exists" | "registry-busy" | "registry-unavailable";
export type PrepareLaunchResult =
  | { decision: "allow"; record: ProcessOwnerRecord; recordPath: string }
  | { decision: "blocked"; reason: BlockReason; conflictingOwnerId?: string };
export type SwitchBlockReason =
  | "owner-mismatch" | "source-mismatch" | "transition-in-progress"
  | "target-mismatch" | "stale-reservation" | "session-owned"
  | "selector-active" | "registry-busy" | "registry-unavailable";
export type SwitchBlocked = Readonly<{
  decision: "blocked";
  reason: SwitchBlockReason;
  conflictingOwnerId?: string;
}>;
export type ReserveSwitchTargetInput = Readonly<{
  store: RegistryStore;
  ownerId: string;
  pid: number;
  source: SwitchIdentity;
  target: SwitchTarget;
}>;
export type CommitSwitchTargetInput = Readonly<{
  store: RegistryStore;
  ownerId: string;
  pid: number;
  target: SwitchIdentity;
}> & (
  | Readonly<{ kind: "resume"; source: SwitchIdentity; reservationId: string }>
  | Readonly<{ kind: "startup"; source: null; reservationId: null }>
  | Readonly<{ kind: "reload"; source: SwitchIdentity; reservationId: null }>
  | Readonly<{ kind: "new" | "fork"; source: SwitchIdentity; reservationId: null }>
);
export type AbortSwitchTargetInput = Readonly<{
  store: RegistryStore;
  ownerId: string;
  pid: number;
  source: SwitchIdentity;
  target: SwitchTarget;
  reservationId: string;
}>;

type OwnUpdate = Readonly<{ store: RegistryStore; ownerId: string; pid: number; state: "active" | "transitioning"; cwd: string; sessionId: string | null; sessionFile: string | null; pendingSessionFile?: string | null; forkSource?: ForkSource | null; switchReservation?: SwitchReservation | null }>;
type OwnRelease = Readonly<{ store: RegistryStore; ownerId: string; pid: number }>;
type Guard = Readonly<{ pid: number; token: string }>;

const RECORD_PROTOCOL = "pi-session-owner.v1";
const GUARD_PROTOCOL = "pi-session-owner.guard.v1";
const OWNER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,159}$/;
// 事务 nonce 只由 registry 自己 randomUUID() 生成；receipt 中的 nonce 必须仍是 UUID 形态。
const RESERVATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createRegistryStore(root = join(process.env.XDG_RUNTIME_DIR ?? process.env.TMPDIR ?? "/tmp", `pi-session-owner-${process.getuid?.() ?? 0}`), guardTimeoutMs = 250): RegistryStore {
  return Object.freeze({ root: resolve(root), guardTimeoutMs });
}

function unavailable(message: string, cause?: unknown, details?: unknown): Error {
  const error = new Error(message, cause === undefined ? undefined : { cause }) as Error & { code?: string; details?: unknown };
  error.code = "REGISTRY_UNAVAILABLE";
  if (details !== undefined) error.details = details;
  return error;
}

function busy(message: string): Error {
  const error = new Error(message) as Error & { code?: string };
  error.code = "REGISTRY_BUSY";
  return error;
}

function noFollow(flags: number): number { return flags | (constants.O_NOFOLLOW ?? 0); }

function callerUid(store: RegistryStore): number {
  const uid = (store.uid ?? process.getuid)?.();
  if (!Number.isSafeInteger(uid) || uid! < 0) throw unavailable("process uid is unavailable");
  return uid!;
}

function checkedUid(store: RegistryStore, path: string, uid: number): number {
  return store.ownershipUid ? store.ownershipUid(path, uid) : uid;
}

function ensureRoot(store: RegistryStore): void {
  if (!Number.isFinite(store.guardTimeoutMs) || store.guardTimeoutMs < 0 || !store.root || resolve(store.root) !== store.root) throw unavailable("registry store is invalid");
  mkdirSync(store.root, { recursive: true, mode: 0o700 });
  const info = lstatSync(store.root);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 || checkedUid(store, store.root, info.uid) !== callerUid(store)) throw unavailable("registry root must be a caller-owned 0700 directory");
}

function privateJson(store: RegistryStore, path: string, label: string): unknown {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o777) !== 0o600 || checkedUid(store, path, before.uid) !== callerUid(store)) throw unavailable(`${label} must be a caller-owned 0600 regular file`);
  let fd: number | undefined;
  try {
    fd = openSync(path, noFollow(constants.O_RDONLY));
    const opened = fstatSync(fd);
    if (!opened.isFile() || (opened.mode & 0o777) !== 0o600 || checkedUid(store, path, opened.uid) !== callerUid(store)) throw unavailable(`${label} must be a caller-owned 0600 regular file`);
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw unavailable(`${label} changed while opening`);
    let content = "";
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const bytes = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (bytes === 0) break;
      offset += bytes;
    }
    content = buffer.toString("utf8", 0, offset);
    return JSON.parse(content);
  } finally { if (fd !== undefined) closeSync(fd); }
}

function writePrivate(path: string, value: unknown): void {
  const fd = openSync(path, noFollow(constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY), 0o600);
  try { writeFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); }
  finally { closeSync(fd); }
  chmodSync(path, 0o600);
}

function publishExclusivePrivate(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writePrivate(temporary, value);
    linkSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch { /* temp 已发布或由异常清理。 */ }
  }
}

function recordPath(store: RegistryStore, ownerId: string): string {
  if (!OWNER_ID.test(ownerId) || ownerId.includes("..")) throw unavailable("owner id is invalid");
  return join(store.root, `${ownerId}.json`);
}

function canonicalProcessCwd(): string {
  try { return realpathSync.native(process.cwd()); }
  catch { throw unavailable("process cwd is unavailable"); }
}

function isDead(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || (pid as number) < 1) return false;
  try { process.kill(pid as number, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

function guardPath(store: RegistryStore): string { return join(store.root, ".guard"); }

function guardSnapshot(store: RegistryStore): Record<string, unknown> {
  const path = guardPath(store);
  try {
    const info = lstatSync(path);
    let content: string | null = null;
    try { content = readFileSync(path, "utf8"); } catch (error) { content = `[read failed: ${(error as Error).message}]`; }
    let parsed: unknown = null;
    let parseError: string | null = null;
    try { parsed = JSON.parse(content); } catch (error) { parseError = (error as Error).message; }
    return { exists: true, isFile: info.isFile(), mode: info.mode & 0o777, size: info.size, mtimeMs: info.mtimeMs, content, parsed, parseError };
  } catch (error) {
    return { exists: false, error: (error as Error).message };
  }
}

function acquireGuard(store: RegistryStore): Guard {
  ensureRoot(store);
  const guard = { protocol: GUARD_PROTOCOL, pid: process.pid, token: randomUUID() };
  const deadline = Date.now() + store.guardTimeoutMs;
  for (;;) {
    try { publishExclusivePrivate(guardPath(store), guard); return { pid: guard.pid, token: guard.token }; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw unavailable("cannot create registry guard", error, guardSnapshot(store));
    }
    let observed: any;
    try { observed = privateJson(store, guardPath(store), "registry guard"); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // guard在原子替换窗口内可能已经被另一合法owner发布；只对这个精确竞态重读，
      // malformed、权限、owner、类型和symlink异常仍然fail closed。
      if ((code === "ENOENT" || (error as Error).message === "registry guard changed while opening") && Date.now() < deadline) continue;
      throw unavailable("registry guard is invalid", error, guardSnapshot(store));
    }
    // 共享 guard 陈旧或损坏时只能人工确认后恢复，当前进程绝不能删除它。
    if (Date.now() >= deadline) throw busy("registry guard is held; inspect and remove .guard manually after verifying its owner");
  }
}

function releaseGuard(store: RegistryStore, guard: Guard): void {
  try {
    const observed: any = privateJson(store, guardPath(store), "registry guard");
    if (observed?.protocol === GUARD_PROTOCOL && observed.pid === guard.pid && observed.token === guard.token) unlinkSync(guardPath(store));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw unavailable("cannot release registry guard", error, guardSnapshot(store));
  }
}

function withGuard<T>(store: RegistryStore, operation: () => T): T {
  const guard = acquireGuard(store);
  try { return operation(); }
  finally { releaseGuard(store, guard); }
}

async function withGuardAsync<T>(store: RegistryStore, operation: () => Promise<T>): Promise<T> {
  const guard = acquireGuard(store);
  try { return await operation(); }
  finally { releaseGuard(store, guard); }
}

function validForkSource(value: unknown): value is ForkSource {
  return !!value && typeof value === "object" && typeof (value as ForkSource).cwd === "string"
    && typeof (value as ForkSource).sessionFile === "string" && typeof (value as ForkSource).sessionId === "string";
}

function normalizedAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && value !== "" && !value.includes("\0") && isAbsolute(value) && resolve(value) === value;
}

function normalizedSessionId(value: unknown): value is string {
  return typeof value === "string" && value !== "" && !value.includes("\0");
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

// 未知结构一律 fail closed：不自动补字段，也不忽略多余字段。
function validSwitchIdentity(value: unknown): value is SwitchIdentity {
  if (!value || typeof value !== "object" || !exactKeys(value as object, ["cwd", "sessionId", "sessionFile"])) return false;
  const identity = value as Record<string, unknown>;
  if (!normalizedAbsolutePath(identity.cwd)) return false;
  if (identity.sessionId !== null && !normalizedSessionId(identity.sessionId)) return false;
  return identity.sessionFile === null || normalizedAbsolutePath(identity.sessionFile);
}

function validSwitchTarget(value: unknown): value is SwitchTarget {
  if (!value || typeof value !== "object" || !exactKeys(value as object, ["cwd", "sessionId", "sessionFile"])) return false;
  const target = value as Record<string, unknown>;
  return normalizedAbsolutePath(target.cwd) && normalizedSessionId(target.sessionId) && normalizedAbsolutePath(target.sessionFile);
}

function validSwitchReservation(value: unknown): value is SwitchReservation {
  if (!value || typeof value !== "object" || !exactKeys(value as object, ["phase", "reservationId", "source", "target"])) return false;
  const reservation = value as Record<string, unknown>;
  return typeof reservation.reservationId === "string" && RESERVATION_ID.test(reservation.reservationId)
    && validSwitchIdentity(reservation.source) && validSwitchTarget(reservation.target)
    && ["reserved", "committed", "aborted"].includes(reservation.phase as string);
}

function sameIdentity(left: SwitchIdentity, right: SwitchIdentity): boolean {
  return left.cwd === right.cwd && left.sessionId === right.sessionId && left.sessionFile === right.sessionFile;
}

function recordIdentity(record: ProcessOwnerRecord): SwitchIdentity {
  return { cwd: record.cwd, sessionId: record.sessionId, sessionFile: record.sessionFile };
}

function reservationOf(record: ProcessOwnerRecord): SwitchReservation | null {
  return record.switchReservation ?? null;
}

// 只有 phase reserved 的 target 仍占资源；committed/aborted 只是幂等 receipt，不占用旧 source 或 target。
function reservedTargetOf(record: ProcessOwnerRecord): SwitchTarget | null {
  const reservation = reservationOf(record);
  return reservation !== null && reservation.phase === "reserved" ? reservation.target : null;
}

// §4 phase 一致性：reserved 顶层===source、state active|transitioning、pending===target.file；
// committed 顶层===target、active、pending null；aborted 顶层===source、active、pending null。不一致即坏 record。
function consistentReservation(record: ProcessOwnerRecord, reservation: SwitchReservation): boolean {
  const identity = recordIdentity(record);
  if (reservation.phase === "reserved") return sameIdentity(identity, reservation.source)
    && (record.state === "active" || record.state === "transitioning")
    && record.pendingSessionFile === reservation.target.sessionFile;
  if (reservation.phase === "committed") return sameIdentity(identity, reservation.target)
    && record.state === "active" && record.pendingSessionFile === null;
  return sameIdentity(identity, reservation.source) && record.state === "active" && record.pendingSessionFile === null;
}

function copyIdentity(value: SwitchIdentity): SwitchIdentity {
  return { cwd: value.cwd, sessionId: value.sessionId, sessionFile: value.sessionFile };
}

function copyTarget(value: SwitchTarget): SwitchTarget {
  return { cwd: value.cwd, sessionId: value.sessionId, sessionFile: value.sessionFile };
}

// 占用匹配：file 规范路径相等，或 canonical cwd + sessionId 相等；reserved target 的 cwd/id 独立于顶层 source。
function claimsIdentity(record: ProcessOwnerRecord, identity: SwitchIdentity): boolean {
  const file = identity.sessionFile;
  const reserved = reservedTargetOf(record);
  if (file !== null && (record.sessionFile === file || record.pendingSessionFile === file
    || (record.forkSource !== null && record.forkSource.sessionFile === file)
    || (reserved !== null && reserved.sessionFile === file))) return true;
  const sessionId = identity.sessionId;
  return sessionId !== null && ((record.cwd === identity.cwd && record.sessionId === sessionId)
    || (record.forkSource !== null && record.forkSource.cwd === identity.cwd && record.forkSource.sessionId === sessionId)
    || (reserved !== null && reserved.cwd === identity.cwd && reserved.sessionId === sessionId));
}

function switchStore(value: unknown): RegistryStore {
  if (!value || typeof value !== "object") throw unavailable("registry store is invalid");
  const candidate = value as RegistryStore;
  if (typeof candidate.root !== "string" || candidate.root === "" || resolve(candidate.root) !== candidate.root
    || !Number.isFinite(candidate.guardTimeoutMs) || candidate.guardTimeoutMs < 0) throw unavailable("registry store is invalid");
  return candidate;
}

// ownerId 本身就是 launcher owner nonce；只有 ownerId+pid 同时匹配才算自身。
function switchOwner(ownerId: unknown, pid: unknown): Readonly<{ ownerId: string; pid: number }> {
  if (typeof ownerId !== "string" || !OWNER_ID.test(ownerId) || ownerId.includes("..")) throw unavailable("owner id is invalid");
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) throw unavailable("process id is invalid");
  return { ownerId, pid: pid as number };
}

function switchIdentity(value: unknown, label: string): SwitchIdentity {
  if (!validSwitchIdentity(value)) throw unavailable(`${label} is not a normalized switch identity`);
  return copyIdentity(value as SwitchIdentity);
}

function switchTargetIdentity(value: unknown, label: string): SwitchTarget {
  if (!validSwitchTarget(value)) throw unavailable(`${label} is not a normalized switch target`);
  return copyTarget(value as SwitchTarget);
}

function switchReservationId(value: unknown): string {
  if (typeof value !== "string" || !RESERVATION_ID.test(value)) throw unavailable("switch reservation id is invalid");
  return value;
}

function normalizeRecord(value: unknown): ProcessOwnerRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.protocol !== RECORD_PROTOCOL || typeof record.ownerId !== "string" || !OWNER_ID.test(record.ownerId)
    || !Number.isSafeInteger(record.pid) || (record.pid as number) <= 0 || typeof record.cwd !== "string"
    || !(typeof record.sessionId === "string" || record.sessionId === null)
    || !(typeof record.sessionFile === "string" || record.sessionFile === null)
    || !["pending", "selecting", "active", "transitioning"].includes(record.state as string)
    || !(typeof record.pendingSessionFile === "string" || record.pendingSessionFile === null)
    || ("forkSource" in record && record.forkSource !== null && !validForkSource(record.forkSource))
    || ("switchReservation" in record && record.switchReservation !== null && !validSwitchReservation(record.switchReservation))
    || typeof record.startedAt !== "string") return null;
  // legacy v1 缺 switchReservation 时不补键，保持既有 record 形状；存在时再校验 phase 一致性。
  const normalized = { ...record, forkSource: "forkSource" in record ? record.forkSource : null } as ProcessOwnerRecord;
  const reservation = reservationOf(normalized);
  if (reservation !== null && !consistentReservation(normalized, reservation)) return null;
  return normalized;
}

function validRecord(value: unknown): value is ProcessOwnerRecord {
  return normalizeRecord(value) !== null;
}

function recordsLocked(store: RegistryStore): ProcessOwnerRecord[] {
  const records: ProcessOwnerRecord[] = [];
  for (const name of readdirSync(store.root)) {
    if (!name.endsWith(".json")) continue;
    const path = join(store.root, name);
    let record: unknown;
    try { record = privateJson(store, path, "owner record"); }
    catch { throw unavailable("owner record is invalid"); }
    const normalized = normalizeRecord(record);
    if (!normalized || name !== `${normalized.ownerId}.json`) throw unavailable("owner record is invalid");
    if (isDead(normalized.pid)) { unlinkSync(path); continue; }
    records.push(normalized);
  }
  return records;
}

function publishLocked(store: RegistryStore, record: ProcessOwnerRecord): string {
  const destination = recordPath(store, record.ownerId);
  const temporary = join(store.root, `.${record.ownerId}.${randomUUID()}.tmp`);
  try { writePrivate(temporary, record); renameSync(temporary, destination); chmodSync(destination, 0o600); }
  finally { try { unlinkSync(temporary); } catch { /* rename 已经消费了临时文件。 */ } }
  return destination;
}

function recordMatches(record: ProcessOwnerRecord, cwd: string, sessionFile: string, sessionId: string | null): boolean {
  return claimsIdentity(record, { cwd, sessionId, sessionFile });
}

// startup 的 `session-id` intent 也必须看见 reserved target 的 cwd/id，不能只有 file 请求才看到 pending。
function reservedTargetMatchesId(record: ProcessOwnerRecord, cwd: string, sessionId: string): boolean {
  const reserved = reservedTargetOf(record);
  return reserved !== null && reserved.cwd === cwd && reserved.sessionId === sessionId;
}

function conflict(records: readonly ProcessOwnerRecord[], reservation: LaunchReservation): ProcessOwnerRecord | undefined {
  if (reservation.kind === "new") return reservation.rejectSelecting ? records.find((record) => record.state === "selecting") : undefined;
  if (reservation.kind === "selecting") return records[0];
  const selecting = records.find((record) => record.state === "selecting");
  if (selecting) return selecting;
  if (reservation.kind === "fork-source") return records.find((record) => recordMatches(record, reservation.source.cwd, reservation.source.sessionFile, reservation.source.sessionId));
  if (reservation.kind === "session") return records.find((record) => recordMatches(record, reservation.cwd, reservation.sessionFile, reservation.sessionId));
  return records.find((record) => (record.cwd === reservation.cwd && record.sessionId === reservation.sessionId)
    || reservedTargetMatchesId(record, reservation.cwd, reservation.sessionId));
}

export async function prepareLaunch(input: PrepareLaunchInput): Promise<PrepareLaunchResult> {
  try {
    return await withGuardAsync(input.store, async () => {
      const reservation = input.resolveReservation ? await input.resolveReservation() : input.reservation;
      if (!reservation) throw unavailable("launch reservation is unavailable");
      const records = recordsLocked(input.store);
      const existing = conflict(records, reservation);
      if (existing) {
        const reason: BlockReason = reservation.kind === "selecting" ? "active-owner-exists"
          : existing.state === "selecting" ? "selector-active"
          : reservation.kind === "session-id" ? "session-id-owned" : "session-owned";
        return { decision: "blocked", reason, conflictingOwnerId: existing.ownerId };
      }
      const cwd = reservation.kind === "session" || reservation.kind === "session-id" || reservation.kind === "fork-source" ? reservation.cwd : canonicalProcessCwd();
      const record: ProcessOwnerRecord = {
        protocol: RECORD_PROTOCOL, ownerId: input.ownerId, pid: input.pid,
        cwd,
        sessionId: reservation.kind === "session" || reservation.kind === "session-id" ? reservation.sessionId : null,
        sessionFile: null, state: reservation.kind === "selecting" ? "selecting" : "pending",
        pendingSessionFile: reservation.kind === "session" ? reservation.sessionFile : null,
        forkSource: reservation.kind === "fork-source" ? reservation.source : null,
        startedAt: input.startedAt,
      };
      return { decision: "allow", record, recordPath: publishLocked(input.store, record) };
    });
  } catch (error) {
    console.error("[session-owner] registry prepare failed:", error);
    return { decision: "blocked", reason: (error as { code?: string }).code === "REGISTRY_BUSY" ? "registry-busy" : "registry-unavailable" };
  }
}

export async function listLiveRecords(store: RegistryStore): Promise<readonly ProcessOwnerRecord[]> {
  return withGuard(store, () => recordsLocked(store));
}

export async function updateOwnRecord(input: OwnUpdate): Promise<ProcessOwnerRecord> {
  return withGuard(input.store, () => {
    const path = recordPath(input.store, input.ownerId);
    const current = privateJson(input.store, path, "owner record");
    const normalized = normalizeRecord(current);
    if (!normalized || normalized.ownerId !== input.ownerId || normalized.pid !== input.pid) throw unavailable("owner record does not belong to this process");
    // 省略字段一律保留：不能再用 ?? null 静默清除 live switch reservation 或 startup pending。
    const pendingSessionFile = input.pendingSessionFile === undefined ? normalized.pendingSessionFile : input.pendingSessionFile;
    const forkSource = input.forkSource === undefined ? normalized.forkSource : input.forkSource;
    // receipt 只能由 reserve/commit/abort 创建或推进；一般 update 只允许在终态 receipt 上显式清 null（new/fork shutdown）。
    if (input.switchReservation !== undefined && input.switchReservation !== null) throw unavailable("switch reservation can only be changed by the switch transaction APIs");
    const updated: ProcessOwnerRecord = input.switchReservation === undefined
      ? { ...normalized, state: input.state, cwd: input.cwd, sessionId: input.sessionId, sessionFile: input.sessionFile, pendingSessionFile, forkSource }
      : { ...normalized, state: input.state, cwd: input.cwd, sessionId: input.sessionId, sessionFile: input.sessionFile, pendingSessionFile, forkSource, switchReservation: null };
    // phase reserved 期间只有专用 commit/abort 能清 pending、替换 source 或改 receipt；一般 update 必须拒绝。
    const reservation = reservationOf(normalized);
    if (reservation !== null && reservation.phase === "reserved"
      && (input.switchReservation !== undefined || pendingSessionFile !== reservation.target.sessionFile
        || !sameIdentity(recordIdentity(updated), reservation.source))) throw unavailable("owner record holds a live switch reservation");
    publishLocked(input.store, updated);
    return updated;
  });
}

export async function releaseOwnRecord(input: OwnRelease): Promise<void> {
  return withGuard(input.store, () => {
    const path = recordPath(input.store, input.ownerId);
    try {
      const current = privateJson(input.store, path, "owner record");
      if (validRecord(current) && current.ownerId === input.ownerId && current.pid === input.pid) unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  });
}

// ---- 受控运行期 session switch 事务（S1g §3–§4）----
// 三个 API 均在一个现有 private guard 内完成 recordsLocked 校验 + 冲突扫描 + publishLocked 原子发布；
// 不使用 listLiveRecords snapshot 做 CAS，不建立第二文件/第二锁，不新增 guard 死锁回收。

type ReservedSwitchResult = Readonly<{ decision: "reserved"; reservationId: string }>;
type CommittedSwitchResult = Readonly<{ decision: "committed"; record: ProcessOwnerRecord }>;
type AbortedSwitchResult = Readonly<{ decision: "aborted"; record: ProcessOwnerRecord }>;
type CommitRequest =
  | Readonly<{ kind: "resume"; store: RegistryStore; ownerId: string; pid: number; source: SwitchIdentity; target: SwitchIdentity; reservationId: string }>
  | Readonly<{ kind: "startup"; store: RegistryStore; ownerId: string; pid: number; source: null; target: SwitchIdentity; reservationId: null }>
  | Readonly<{ kind: "reload"; store: RegistryStore; ownerId: string; pid: number; source: SwitchIdentity; target: SwitchIdentity; reservationId: null }>
  | Readonly<{ kind: "new"; store: RegistryStore; ownerId: string; pid: number; source: SwitchIdentity; target: SwitchIdentity; reservationId: null }>
  | Readonly<{ kind: "fork"; store: RegistryStore; ownerId: string; pid: number; source: SwitchIdentity; target: SwitchIdentity; reservationId: null }>;

function blockedSwitch(reason: SwitchBlockReason): SwitchBlocked {
  return { decision: "blocked", reason };
}

function blockedByRecord(record: ProcessOwnerRecord, reason: "session-owned" | "selector-active"): SwitchBlocked {
  return { decision: "blocked", reason, conflictingOwnerId: record.ownerId };
}

// 只有 ownerId+pid 都匹配才排除自身；另一 owner 复用同一 PID 仍然是冲突方。
function otherRecords(records: readonly ProcessOwnerRecord[], ownerId: string, pid: number): ProcessOwnerRecord[] {
  return records.filter((record) => record.ownerId !== ownerId || record.pid !== pid);
}

function identityConflict(others: readonly ProcessOwnerRecord[], identity: SwitchIdentity): ProcessOwnerRecord | undefined {
  return others.find((record) => claimsIdentity(record, identity));
}

// 权限/解析/发布/guard 错误分别映射为 registry-unavailable / registry-busy；不得吞错后 allow。
function switchFailure(label: string, error: unknown): SwitchBlocked {
  console.error(`[session-owner] ${label}:`, error);
  return { decision: "blocked", reason: (error as { code?: string }).code === "REGISTRY_BUSY" ? "registry-busy" : "registry-unavailable" };
}

function ownRecordBlocked(records: readonly ProcessOwnerRecord[], ownerId: string, pid: number): ProcessOwnerRecord | SwitchBlocked {
  const own = records.find((record) => record.ownerId === ownerId);
  if (!own) return blockedSwitch("owner-mismatch");
  if (own.pid !== pid) return { decision: "blocked", reason: "owner-mismatch", conflictingOwnerId: own.ownerId };
  return own;
}

function isBlocked(result: ProcessOwnerRecord | SwitchBlocked): result is SwitchBlocked {
  return (result as SwitchBlocked).decision === "blocked";
}

// launcher 既有可启动规则：fork-source 只接受同 cwd 的新目的地、pending 只接受精确 file、session-id 只接受同 cwd+id、裸 pending 只接受同 cwd。
function startupTargetAllowed(own: ProcessOwnerRecord, target: SwitchIdentity): boolean {
  if (own.forkSource !== null) return own.forkSource.cwd === target.cwd && target.sessionFile !== own.forkSource.sessionFile;
  if (own.pendingSessionFile !== null) return own.pendingSessionFile === target.sessionFile;
  if (own.sessionId !== null) return own.cwd === target.cwd && own.sessionId === target.sessionId;
  return own.cwd === target.cwd;
}

function commitRequest(input: CommitSwitchTargetInput): CommitRequest {
  if (!input || typeof input !== "object") throw unavailable("switch commit input is invalid");
  const raw = input as unknown as Record<string, unknown>;
  const store = switchStore(raw.store);
  const { ownerId, pid } = switchOwner(raw.ownerId, raw.pid);
  const target = switchIdentity(raw.target, "switch commit target");
  switch (raw.kind) {
    case "startup":
      if (raw.source !== null || raw.reservationId !== null) throw unavailable("switch commit input is invalid");
      return { kind: "startup", store, ownerId, pid, source: null, target, reservationId: null };
    case "resume":
      return { kind: "resume", store, ownerId, pid, source: switchIdentity(raw.source, "switch commit source"), target, reservationId: switchReservationId(raw.reservationId) };
    case "reload":
      if (raw.reservationId !== null) throw unavailable("switch commit input is invalid");
      return { kind: "reload", store, ownerId, pid, source: switchIdentity(raw.source, "switch commit source"), target, reservationId: null };
    case "new":
      if (raw.reservationId !== null) throw unavailable("switch commit input is invalid");
      return { kind: "new", store, ownerId, pid, source: switchIdentity(raw.source, "switch commit source"), target, reservationId: null };
    case "fork":
      if (raw.reservationId !== null) throw unavailable("switch commit input is invalid");
      return { kind: "fork", store, ownerId, pid, source: switchIdentity(raw.source, "switch commit source"), target, reservationId: null };
    default:
      throw unavailable("switch commit input is invalid");
  }
}

export async function reserveSwitchTarget(input: ReserveSwitchTargetInput): Promise<ReservedSwitchResult | SwitchBlocked> {
  try {
    if (!input || typeof input !== "object") throw unavailable("switch reserve input is invalid");
    const raw = input as unknown as Record<string, unknown>;
    const store = switchStore(raw.store);
    const { ownerId, pid } = switchOwner(raw.ownerId, raw.pid);
    const source = switchIdentity(raw.source, "switch reserve source");
    const target = switchTargetIdentity(raw.target, "switch reserve target");
    return withGuard(store, (): ReservedSwitchResult | SwitchBlocked => {
      const records = recordsLocked(store);
      const found = ownRecordBlocked(records, ownerId, pid);
      if (isBlocked(found)) return found;
      const own = found;
      if (own.state !== "active") return blockedSwitch("transition-in-progress");
      if (!sameIdentity(recordIdentity(own), source)) return blockedSwitch("source-mismatch");
      const others = otherRecords(records, ownerId, pid);
      const reservation = reservationOf(own);
      if (reservation !== null && reservation.phase === "reserved") {
        // 同 source+target 重入返回原 nonce，不重新生成；换 source 或换目标一律拒绝，不偷偷替换 pending。
        if (!sameIdentity(reservation.source, source) || !sameIdentity(reservation.target, target)) return blockedSwitch("transition-in-progress");
        const repeated = identityConflict(others, target) ?? identityConflict(others, source);
        return repeated ? blockedByRecord(repeated, "session-owned") : { decision: "reserved", reservationId: reservation.reservationId };
      }
      // 无 live reservation 时，既存 startup pending 不能被静默换成另一个目标。
      if (reservation === null && own.pendingSessionFile !== null && own.pendingSessionFile !== target.sessionFile) return blockedSwitch("transition-in-progress");
      // selector 延续 prepareLaunch 既定规则；不新增 running owner 全局锁。
      const selecting = others.find((record) => record.state === "selecting");
      if (selecting) return blockedByRecord(selecting, "selector-active");
      const targetConflict = identityConflict(others, target);
      if (targetConflict) return blockedByRecord(targetConflict, "session-owned");
      // own source 也必须仍只由自身占用，否则不能把它当作可释放的事务起点。
      const sourceConflict = identityConflict(others, source);
      if (sourceConflict) return blockedByRecord(sourceConflict, "session-owned");
      const reservationId = randomUUID();
      // 顶层继续保留 source，只追加 target pending 与 reserved receipt，同 guard 内原子发布自身单条 record。
      const reserved: ProcessOwnerRecord = { ...own, pendingSessionFile: target.sessionFile, switchReservation: { reservationId, source, target, phase: "reserved" } };
      publishLocked(store, reserved);
      return { decision: "reserved", reservationId };
    });
  } catch (error) { return switchFailure("switch reserve failed", error); }
}

export async function commitSwitchTarget(input: CommitSwitchTargetInput): Promise<CommittedSwitchResult | SwitchBlocked> {
  try {
    const request = commitRequest(input);
    const { store, ownerId, pid, target } = request;
    return withGuard(store, (): CommittedSwitchResult | SwitchBlocked => {
      const records = recordsLocked(store);
      const found = ownRecordBlocked(records, ownerId, pid);
      if (isBlocked(found)) return found;
      const own = found;
      const others = otherRecords(records, ownerId, pid);
      const reservation = reservationOf(own);
      if (request.kind === "resume") {
        const { source, reservationId } = request;
        if (reservation === null || reservation.reservationId !== reservationId || reservation.phase === "aborted") return blockedSwitch("stale-reservation");
        if (!sameIdentity(reservation.source, source)) return blockedSwitch("source-mismatch");
        if (!sameIdentity(reservation.target, target)) return blockedSwitch("target-mismatch");
        if (reservation.phase === "committed") {
          // 同 token 重入只做原子验证；旧 receipt 不再是资源 claim，也不允许覆盖不同 active 身份。
          if (own.state !== "active" || !sameIdentity(recordIdentity(own), target)) return blockedSwitch("stale-reservation");
          const replayed = identityConflict(others, target);
          return replayed ? blockedByRecord(replayed, "session-owned") : { decision: "committed", record: own };
        }
        // resume shutdown 已把 state 改 transitioning；仍 active 说明事务顺序不成立，fail closed。
        if (own.state !== "transitioning") return blockedSwitch("transition-in-progress");
        const conflicting = identityConflict(others, target);
        if (conflicting) return blockedByRecord(conflicting, "session-owned");
        // 旧 source 的释放与 pending 的清除只在这一次原子 publish 内一起发生。
        const committed: ProcessOwnerRecord = {
          ...own, cwd: target.cwd, sessionId: target.sessionId, sessionFile: target.sessionFile,
          state: "active", pendingSessionFile: null, forkSource: null, switchReservation: { ...reservation, phase: "committed" },
        };
        publishLocked(store, committed);
        return { decision: "committed", record: committed };
      }
      if (request.kind === "startup") {
        if (reservation !== null && reservation.phase === "reserved") return blockedSwitch("transition-in-progress");
        if (own.state === "active") {
          if (!sameIdentity(recordIdentity(own), target)) return blockedSwitch("target-mismatch");
          const replayed = identityConflict(others, target);
          return replayed ? blockedByRecord(replayed, "session-owned") : { decision: "committed", record: own };
        }
        if (own.state !== "pending" && own.state !== "selecting") return blockedSwitch("transition-in-progress");
        if (own.state === "pending" && !startupTargetAllowed(own, target)) return blockedSwitch("target-mismatch");
        const conflicting = identityConflict(others, target);
        if (conflicting) return blockedByRecord(conflicting, "session-owned");
        const started: ProcessOwnerRecord = {
          ...own, cwd: target.cwd, sessionId: target.sessionId, sessionFile: target.sessionFile,
          state: "active", pendingSessionFile: null, forkSource: null, switchReservation: null,
        };
        publishLocked(store, started);
        return { decision: "committed", record: started };
      }
      if (request.kind === "reload") {
        const { source } = request;
        if (own.state !== "active") return blockedSwitch("transition-in-progress");
        if (!sameIdentity(recordIdentity(own), source)) return blockedSwitch("source-mismatch");
        if (!sameIdentity(source, target)) return blockedSwitch("target-mismatch");
        const conflicting = identityConflict(others, target);
        if (conflicting) return blockedByRecord(conflicting, "session-owned");
        // reload 只是原子验证：保留 phase reserved 与 pending（可能来自 late cancel / open 失败），不发布、不释放 claim。
        return { decision: "committed", record: own };
      }
      if (request.kind !== "new" && request.kind !== "fork") throw unavailable("switch commit input is invalid");
      const { source } = request;
      if (reservation !== null && reservation.phase === "reserved") return blockedSwitch("transition-in-progress");
      if (own.state === "active") {
        // 重复 session_start 只在当前 active target 完全相等时幂等；不同 active 身份一律拒绝。
        if (!sameIdentity(recordIdentity(own), target)) return blockedSwitch("target-mismatch");
        const replayed = identityConflict(others, target);
        return replayed ? blockedByRecord(replayed, "session-owned") : { decision: "committed", record: own };
      }
      if (own.state !== "transitioning") return blockedSwitch("transition-in-progress");
      if (!sameIdentity(recordIdentity(own), source)) return blockedSwitch("source-mismatch");
      // 新 ID 语义：new/fork 的目的地不能是保留 source 自己。
      if ((target.sessionFile !== null && target.sessionFile === own.sessionFile)
        || (target.sessionId !== null && target.sessionId === own.sessionId)) return blockedSwitch("target-mismatch");
      const conflicting = identityConflict(others, target);
      if (conflicting) return blockedByRecord(conflicting, "session-owned");
      const replaced: ProcessOwnerRecord = {
        ...own, cwd: target.cwd, sessionId: target.sessionId, sessionFile: target.sessionFile,
        state: "active", pendingSessionFile: null, forkSource: null, switchReservation: null,
      };
      publishLocked(store, replaced);
      return { decision: "committed", record: replaced };
    });
  } catch (error) { return switchFailure("switch commit failed", error); }
}

export async function abortSwitchTarget(input: AbortSwitchTargetInput): Promise<AbortedSwitchResult | SwitchBlocked> {
  try {
    if (!input || typeof input !== "object") throw unavailable("switch abort input is invalid");
    const raw = input as unknown as Record<string, unknown>;
    const store = switchStore(raw.store);
    const { ownerId, pid } = switchOwner(raw.ownerId, raw.pid);
    const source = switchIdentity(raw.source, "switch abort source");
    const target = switchTargetIdentity(raw.target, "switch abort target");
    const reservationId = switchReservationId(raw.reservationId);
    return withGuard(store, (): AbortedSwitchResult | SwitchBlocked => {
      const records = recordsLocked(store);
      const found = ownRecordBlocked(records, ownerId, pid);
      if (isBlocked(found)) return found;
      const own = found;
      const reservation = reservationOf(own);
      // 旧 token、已 committed 的 token 一律拒绝；不能把已经打开/替换的 target 当作没发生过。
      if (reservation === null || reservation.reservationId !== reservationId || reservation.phase === "committed") return blockedSwitch("stale-reservation");
      if (!sameIdentity(reservation.source, source)) return blockedSwitch("source-mismatch");
      if (!sameIdentity(reservation.target, target)) return blockedSwitch("target-mismatch");
      // 只有顶层仍是 active source 才可撤销 pending；transitioning 说明 teardown 已经发生。
      if (own.state !== "active") return blockedSwitch("transition-in-progress");
      if (!sameIdentity(recordIdentity(own), source)) return blockedSwitch("source-mismatch");
      if (reservation.phase === "aborted") return { decision: "aborted", record: own };
      const aborted: ProcessOwnerRecord = { ...own, pendingSessionFile: null, switchReservation: { ...reservation, phase: "aborted" } };
      publishLocked(store, aborted);
      return { decision: "aborted", record: aborted };
    });
  } catch (error) { return switchFailure("switch abort failed", error); }
}
