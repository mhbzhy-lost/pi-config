import { canonicalizeCwd, normalizeSessionPath } from "./contract.ts";
import type { ProcessOwnerRecord, RegistryStore } from "./registry.ts";
import { listLiveRecords, releaseOwnRecord, updateOwnRecord } from "./registry.ts";

export type SessionIdentity = Readonly<{ cwd: string; sessionId: string | null; sessionFile: string | null }>;
export type SessionOwnerLifecycleDeps = Readonly<{
  store: RegistryStore; ownerId: string; pid: number;
  listLiveRecords?: typeof listLiveRecords; updateOwnRecord?: typeof updateOwnRecord; releaseOwnRecord?: typeof releaseOwnRecord;
}>;

function owns(record: ProcessOwnerRecord, deps: SessionOwnerLifecycleDeps): boolean { return record.ownerId === deps.ownerId && record.pid === deps.pid; }
function canonical(identity: SessionIdentity): SessionIdentity {
  const cwd = canonicalizeCwd(identity.cwd);
  return { cwd, sessionId: identity.sessionId, sessionFile: identity.sessionFile === null ? null : normalizeSessionPath(identity.sessionFile, cwd) };
}
function matches(record: ProcessOwnerRecord, identity: SessionIdentity): boolean {
  return (identity.sessionFile !== null && (record.sessionFile === identity.sessionFile || record.pendingSessionFile === identity.sessionFile))
    || (identity.sessionId !== null && record.cwd === identity.cwd && record.sessionId === identity.sessionId)
    || (record.forkSource !== null && ((identity.sessionFile !== null && record.forkSource.sessionFile === identity.sessionFile)
      || (identity.sessionId !== null && record.forkSource.cwd === identity.cwd && record.forkSource.sessionId === identity.sessionId)));
}
function canStart(own: ProcessOwnerRecord, identity: SessionIdentity, records: readonly ProcessOwnerRecord[], deps: SessionOwnerLifecycleDeps): boolean {
  if (own.state === "active") return own.cwd === identity.cwd && own.sessionId === identity.sessionId && own.sessionFile === identity.sessionFile;
  if (own.state === "transitioning") return !records.some((record) => !owns(record, deps) && matches(record, identity));
  if (own.state === "selecting") return !records.some((record) => !owns(record, deps) && matches(record, identity));
  if (own.forkSource !== null) return own.cwd === identity.cwd && identity.sessionFile !== own.forkSource.sessionFile
    && !records.some((record) => !owns(record, deps) && matches(record, identity));
  if (own.pendingSessionFile !== null) return own.pendingSessionFile === identity.sessionFile;
  if (own.sessionId !== null) return own.cwd === identity.cwd && own.sessionId === identity.sessionId;
  return own.cwd === identity.cwd;
}

export function createSessionOwnerLifecycle(deps: SessionOwnerLifecycleDeps) {
  const list = deps.listLiveRecords ?? listLiveRecords;
  const update = deps.updateOwnRecord ?? updateOwnRecord;
  const release = deps.releaseOwnRecord ?? releaseOwnRecord;

  async function start(value: SessionIdentity): Promise<void> {
    const identity = canonical(value);
    const records = await list(deps.store);
    const own = records.find((record) => owns(record, deps));
    if (!own || !canStart(own, identity, records, deps)) throw new Error("session owner reservation does not match startup identity");
    if (own.state === "active") return;
    await update({ ...deps, state: "active", ...identity, pendingSessionFile: null, forkSource: null });
  }
  async function sourceIsUnavailable(value: SessionIdentity): Promise<boolean> {
    try {
      const identity = canonical(value);
      const own = (await list(deps.store)).find((record) => owns(record, deps));
      return !own || own.state !== "active" || !matches(own, identity);
    } catch { return true; }
  }
  async function beforeSwitch(reason: "new" | "resume", targetSessionFile: string | undefined, value: SessionIdentity): Promise<boolean> {
    if (await sourceIsUnavailable(value)) return true;
    if (reason === "new") return false;
    if (!targetSessionFile) return true;
    try {
      const source = canonical(value);
      const target = canonical({ ...source, sessionId: null, sessionFile: targetSessionFile });
      return (await list(deps.store)).some((record) => !owns(record, deps) && matches(record, target));
    } catch { return true; }
  }
  async function beforeFork(value: SessionIdentity): Promise<boolean> {
    if (await sourceIsUnavailable(value)) return true;
    try {
      const identity = canonical(value);
      return (await list(deps.store)).some((record) => !owns(record, deps) && matches(record, identity));
    } catch { return true; }
  }
  async function shutdown(reason: "quit" | "reload" | "new" | "resume" | "fork", value: SessionIdentity): Promise<void> {
    if (reason === "reload") return;
    if (reason === "quit") return release({ store: deps.store, ownerId: deps.ownerId, pid: deps.pid });
    await update({ ...deps, state: "transitioning", ...canonical(value), pendingSessionFile: null });
  }
  return Object.freeze({ start, beforeSwitch, beforeFork, shutdown });
}
