import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

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

type OwnUpdate = Readonly<{ store: RegistryStore; ownerId: string; pid: number; state: "active" | "transitioning"; cwd: string; sessionId: string | null; sessionFile: string | null; pendingSessionFile?: string | null; forkSource?: ForkSource | null }>;
type OwnRelease = Readonly<{ store: RegistryStore; ownerId: string; pid: number }>;
type Guard = Readonly<{ pid: number; token: string }>;

const RECORD_PROTOCOL = "pi-session-owner.v1";
const GUARD_PROTOCOL = "pi-session-owner.guard.v1";
const OWNER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,159}$/;

export function createRegistryStore(root = join(process.env.XDG_RUNTIME_DIR ?? process.env.TMPDIR ?? "/tmp", `pi-session-owner-${process.getuid?.() ?? 0}`), guardTimeoutMs = 250): RegistryStore {
  return Object.freeze({ root: resolve(root), guardTimeoutMs });
}

function unavailable(message: string): Error {
  const error = new Error(message) as Error & { code?: string };
  error.code = "REGISTRY_UNAVAILABLE";
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
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || checkedUid(store, path, opened.uid) !== callerUid(store)) throw unavailable(`${label} changed while opening`);
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

function acquireGuard(store: RegistryStore): Guard {
  ensureRoot(store);
  const guard = { protocol: GUARD_PROTOCOL, pid: process.pid, token: randomUUID() };
  const deadline = Date.now() + store.guardTimeoutMs;
  for (;;) {
    try { writePrivate(guardPath(store), guard); return { pid: guard.pid, token: guard.token }; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw unavailable("cannot create registry guard");
    }
    let observed: any;
    try { observed = privateJson(store, guardPath(store), "registry guard"); }
    catch { throw unavailable("registry guard is invalid"); }
    // 共享 guard 陈旧或损坏时只能人工确认后恢复，当前进程绝不能删除它。
    if (Date.now() >= deadline) throw busy("registry guard is held; inspect and remove .guard manually after verifying its owner");
  }
}

function releaseGuard(store: RegistryStore, guard: Guard): void {
  try {
    const observed: any = privateJson(store, guardPath(store), "registry guard");
    if (observed?.protocol === GUARD_PROTOCOL && observed.pid === guard.pid && observed.token === guard.token) unlinkSync(guardPath(store));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw unavailable("cannot release registry guard");
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
    || typeof record.startedAt !== "string") return null;
  return { ...record, forkSource: "forkSource" in record ? record.forkSource : null } as ProcessOwnerRecord;
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
  return record.sessionFile === sessionFile || record.pendingSessionFile === sessionFile
    || (sessionId !== null && record.cwd === cwd && record.sessionId === sessionId)
    || (record.forkSource !== null && (record.forkSource.sessionFile === sessionFile || (record.forkSource.cwd === cwd && record.forkSource.sessionId === sessionId)));
}

function conflict(records: readonly ProcessOwnerRecord[], reservation: LaunchReservation): ProcessOwnerRecord | undefined {
  if (reservation.kind === "new") return reservation.rejectSelecting ? records.find((record) => record.state === "selecting") : undefined;
  if (reservation.kind === "selecting") return records[0];
  const selecting = records.find((record) => record.state === "selecting");
  if (selecting) return selecting;
  if (reservation.kind === "fork-source") return records.find((record) => recordMatches(record, reservation.source.cwd, reservation.source.sessionFile, reservation.source.sessionId));
  if (reservation.kind === "session") return records.find((record) => recordMatches(record, reservation.cwd, reservation.sessionFile, reservation.sessionId));
  return records.find((record) => record.cwd === reservation.cwd && record.sessionId === reservation.sessionId);
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
    const updated: ProcessOwnerRecord = { ...normalized, state: input.state, cwd: input.cwd, sessionId: input.sessionId, sessionFile: input.sessionFile, pendingSessionFile: input.pendingSessionFile ?? null, forkSource: input.forkSource ?? null };
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
