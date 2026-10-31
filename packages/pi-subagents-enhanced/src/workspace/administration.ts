import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, readdirSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";

import { inspectManagedGitWorkspace, listManagedGitRegistrations } from "./git-worktree.ts";
import { canonicalWorkspaceStateRoot } from "./coordinator-registry.ts";
import { createManagedWorkspaceLedger } from "./ledger.ts";
import { createManagedWorkspaceService } from "./service.ts";

type AdministrationOptions = { stateRoot?: string; originRoot?: string };
type CleanupAuthorization = { workspaceId: string; leaseId: string };
type CleanupPlan =
  | { schemaVersion: "managed-workspace-cleanup-plan.v1"; stateRoot: string; actions: CleanupAuthorization[]; planHash: string }
  | { schemaVersion: "managed-workspace-reconcile-plan.v2"; stateRoot: string; actions: CleanupAuthorization[]; planHash: string; requiresExplicitAuthorization: boolean };
type ApplyCleanupInput = { stateRoot?: string; plan?: CleanupPlan; authorizations?: CleanupAuthorization[] };

const LEGACY_LEDGER_SCHEMA_V1 = "managed-workspace-ledger.v1";
const LEGACY_QUARANTINE_PLAN_SCHEMA = "managed-workspace-legacy-quarantine-plan.v1";
const LEGACY_QUARANTINE_RECEIPT_SCHEMA = "managed-workspace-legacy-quarantine-receipt.v1";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;

type LegacyQuarantineAction = {
  action: "archive-record";
  repositoryPartition: string;
  workspaceId: string;
  schemaVersion: "managed-workspace-ledger.v1";
  recordSha256: string;
  recordBytes: number;
  originRootPresent: boolean | null;
};
type LegacyQuarantinePlan = {
  schemaVersion: "managed-workspace-legacy-quarantine-plan.v1";
  stateRoot: string;
  archiveId: string;
  actions: LegacyQuarantineAction[];
  requiresExplicitAuthorization: true;
  planHash: string;
};
type LegacyQuarantineAuthorization = { workspaceId: string; recordSha256: string };
type LegacyQuarantineInput = { stateRoot?: string; plan?: LegacyQuarantinePlan; authorizations?: LegacyQuarantineAuthorization[] };

function readJsonFile(file: string) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; }
}

/** Audit never throws on an unusable recorded root; it falls back to the literal form. */
function canonicalStateRootValue(value: string): string {
  try { return canonicalWorkspaceStateRoot(value); } catch { return path.resolve(value); }
}

/** Read-only operational view. It deliberately never starts a coordinator or mutates a ledger. */
export function auditManagedWorkspaces({ stateRoot = process.env.PI_CODING_WORKSPACE_DIR, originRoot }: AdministrationOptions = {}) {
  const inventory = inventoryManagedWorkspaces({ stateRoot, originRoot });
  const coordinator = { status: "missing", protocol: null, instanceId: null, repositoryId: null, stateRoot: null };
  const debts = [];
  if (originRoot) {
    const common = path.join(realpathSync(originRoot), ".git", ".pi-coordinator", "coordinator.json");
    const metadata = readJsonFile(common);
    if (pathExists(common) && !metadata) debts.push({ kind: "coordinator-metadata", status: "unknown-schema" });
    if (metadata) {
      coordinator.status = "observed";
      coordinator.protocol = metadata.protocol ?? null;
      coordinator.instanceId = metadata.instanceId ?? null;
      coordinator.repositoryId = metadata.repositoryId ?? null;
      coordinator.stateRoot = metadata.canonicalStateRoot ?? null;
      if (metadata.protocol !== "repository-workspace-coordinator.v1") debts.push({ kind: "coordinator-protocol", status: "unknown-schema" });
      if (metadata.canonicalStateRoot && canonicalStateRootValue(metadata.canonicalStateRoot) !== inventory.stateRoot) debts.push({ kind: "state-root-split-brain", status: "migration-debt" });
      // A dead-owner takeover replaces the metadata but must not erase the
      // abandoned partition: the superseded canonical state roots stay visible
      // as migration debt until a human resolves them.
      for (const superseded of Array.isArray(metadata.supersededStateRoots) ? metadata.supersededStateRoots : []) {
        if (typeof superseded !== "string") continue;
        const value = canonicalStateRootValue(superseded);
        if (value === inventory.stateRoot) continue;
        debts.push({ kind: "state-root-split-brain", status: "migration-debt", supersededStateRoot: value });
      }
      if (typeof metadata.pid === "number") {
        try { process.kill(metadata.pid, 0); } catch { coordinator.status = "stale"; debts.push({ kind: "coordinator-singleton", status: "dead" }); }
      }
    }
  }
  const queue = [];
  const recoveryIntents = [];
  const resumeIntents = [];
  const repositoriesRoot = path.join(inventory.stateRoot, "repositories");
  let repositoryPartitions: string[] = [];
  try { repositoryPartitions = readdirSync(repositoriesRoot); }
  catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") debts.push({ kind: "queue-schema", path: repositoriesRoot, status: "unknown-schema" }); }
  for (const repositoryId of repositoryPartitions) {
    const queueRoot = path.join(repositoriesRoot, repositoryId, "integration-queue");
    // A ledger-only partition legitimately has no queue directory. Skipping it
    // must never discard the queue items of the remaining partitions, and any
    // other read failure stays observable instead of being swallowed.
    let names: string[];
    try { names = readdirSync(queueRoot); }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") debts.push({ kind: "queue-schema", path: queueRoot, status: "unknown-schema" });
      continue;
    }
    for (const name of names.filter((entry) => entry.endsWith(".json") && entry !== "queue-meta.json" && entry !== "queue-index.json"
        && entry !== "recovery-intent-index.json" && entry !== "resume-intent-index.json"
        && !entry.startsWith("recovery-") && !entry.startsWith("resume-"))) {
      const item = readJsonFile(path.join(queueRoot, name));
      if (!item) { debts.push({ kind: "queue-schema", path: path.join(queueRoot, name), status: "unknown-schema" }); continue; }
      queue.push(item);
      if (item.version !== "workspace-integration-queue-item.v1") debts.push({ kind: "queue-schema", queueItemId: item.queueItemId, status: "unknown-schema" });
    }
    // durable recovery/resume intent 文件是独立的公共证据（acceptance receipt
    // 的 recoveries[] 与 settlement 判定消费）：分类呈现，不误判为 queue item 债。
    for (const name of names.filter((entry) => entry.startsWith("recovery-") && entry.endsWith(".json") && entry !== "recovery-intent-index.json")) {
      const intent = readJsonFile(path.join(queueRoot, name));
      if (intent?.version === "recovery-intent.v1") recoveryIntents.push(intent);
      else debts.push({ kind: "queue-schema", path: path.join(queueRoot, name), status: "unknown-schema" });
    }
    for (const name of names.filter((entry) => entry.startsWith("resume-") && entry.endsWith(".json") && entry !== "resume-intent-index.json")) {
      const intent = readJsonFile(path.join(queueRoot, name));
      if (intent?.version === "integration-resume-intent.v1") resumeIntents.push(intent);
      else debts.push({ kind: "queue-schema", path: path.join(queueRoot, name), status: "unknown-schema" });
    }
  }
  for (const entry of inventory.workspaces) {
    if (entry.receipt.state === "cleanup-debt") debts.push({ kind: "cleanup", workspaceId: entry.receipt.workspaceId, status: "unresolved" });
    if (entry.receipt.state === "active" && entry.receipt.terminalProof?.state !== "observed") debts.push({ kind: "proof", workspaceId: entry.receipt.workspaceId, status: "unresolved" });
    if (entry.receipt.publishedArtifact && !entry.receipt.application) debts.push({ kind: "delivery", workspaceId: entry.receipt.workspaceId, status: "unresolved" });
  }
  // 全 state root 的 invalid record 债务：不因 originRoot 投影而丢失 originRoot
  // 已删除的历史遗留记录；投影只含 partition/workspaceId/schema/error code 等
  // 安全字段，不携带 token 或私有原始路径。
  for (const diagnostic of inventory.invalidRecords) {
    debts.push({
      kind: diagnostic.kind === "ledger-record" ? "invalid-record" : "ledger-storage",
      repositoryPartition: diagnostic.repositoryPartition ?? undefined,
      workspaceId: diagnostic.workspaceId ?? undefined,
      schemaVersion: diagnostic.schemaVersion ?? undefined,
      errorCode: diagnostic.errorCode,
      status: diagnostic.legacyV1 ? "legacy-v1" : "invalid",
      ownerScope: diagnostic.ownerScope ?? undefined,
      originRootPresent: diagnostic.originRootPresent ?? undefined,
    });
  }
  // 公共审计投影必须确定性：queue items 按 sequence 排序（readdir 顺序任意，
  // settlement 的 FIFO 递增检查不得依赖目录顺序）。
  queue.sort((left, right) => (Number.isSafeInteger(left?.sequence) && Number.isSafeInteger(right?.sequence) ? left.sequence - right.sequence : 0));
  // A declared state root that does not resolve to the ledger's canonical
  // partition is real migration debt. The repository origin root is a
  // different concept and must never be compared against it.
  const declaredStateRoot = typeof stateRoot === "string" ? canonicalStateRootValue(stateRoot) : undefined;
  debts.push(...(declaredStateRoot !== undefined && declaredStateRoot !== inventory.stateRoot ? [{ kind: "state-root", status: "migration-debt" }] : []));
  return Object.freeze({ schemaVersion: "managed-workspace-administration.v1", inventory, coordinator, queue: { schemaVersion: "workspace-integration-queue-item.v1", items: queue, recoveryIntents, resumeIntents }, debts });
}

export function assertAuthorizedManagedWorkspaceReconcile(authorization: unknown) {
  if (!authorization || typeof authorization !== "object" || (authorization as any).authorized !== true || typeof (authorization as any).leaseId !== "string") {
    throw new Error("explicit public lease authorization is required for reconcile");
  }
  return true;
}

function pathExists(value) {
  try { lstatSync(value); return true; }
  catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EACCES") return false;
    throw error;
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function planHash(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function inventoryManagedWorkspaces({ stateRoot = process.env.PI_CODING_WORKSPACE_DIR, originRoot }: AdministrationOptions = {}) {
  const ledger = createManagedWorkspaceLedger({ stateRoot });
  // 全 state root 只读扫描：即使 inventory 按 originRoot 投影，invalid record 债
  // （含 originRoot 已删除的 v1 legacy record）仍然完整可见。
  const invalidRecords = ledger.scanInvalidRecords();
  const records = ledger.list({ originRoot, onInvalid: () => undefined });
  const workspaces = records.map((record) => {
    let identity = null;
    const issues = [];
    if (record.state === "active" || record.state === "preserved" || record.state === "disposing" || record.state === "cleanup-debt") {
      try { inspectManagedGitWorkspace(record); identity = true; }
      catch (error) { identity = false; issues.push(error?.code ?? "MANAGED_WORKSPACE_IDENTITY"); }
    }
    if (record.state === "cleanup-debt") issues.push("cleanup-debt");
    const receipt = {
      schemaVersion: "managed-workspace.v2",
      workspaceId: record.workspaceId,
      leaseId: record.leaseId,
      owner: record.request.owner,
      originRoot: record.request.originRoot,
      requestedCwd: record.request.requestedCwd,
      originRef: record.request.originRef,
      baseCommit: record.request.baseCommit,
      path: record.path,
      dispatchCwd: record.dispatchCwd,
      branchRef: record.branchRef,
      state: record.state,
      run: record.run,
      policy: record.request.policy,
      publishedArtifact: record.publishedArtifact ?? null,
      application: record.application ?? null,
      terminalProof: record.terminalProof ?? null,
    };
    return {
      receipt,
      ledgerVersion: record.schemaVersion,
      ledgerGeneration: record.revision,
      intent: { action: record.v2Action, disposition: record.pendingAction },
      identity,
      issues,
    };
  });

  const origins = [...new Set(records.map((record) => record.request.originRoot))];
  if (originRoot) origins.push(realpathSync(originRoot));
  const knownPaths = new Set(records.map((record) => record.path));
  const orphanRegistrations = [];
  for (const origin of new Set(origins)) {
    for (const registration of listManagedGitRegistrations(origin)) {
      if (registration.path !== origin && !knownPaths.has(registration.path)) orphanRegistrations.push({ originRoot: origin, ...registration });
    }
  }

  const legacy = [];
  if (originRoot) {
    const origin = realpathSync(originRoot);
    for (const relative of [".pi-subagents", ".state/subagent-dispatch", ".state/worktree-lifecycle"]) {
      const candidate = path.join(origin, relative);
      if (pathExists(candidate)) legacy.push({ path: candidate, status: "untrusted-legacy" });
    }
  }
  return Object.freeze({ schemaVersion: "managed-workspace-inventory.v2", stateRoot: ledger.stateRoot, workspaces, orphanRegistrations, legacy, invalidRecords });
}

export function planManagedWorkspaceCleanup({ stateRoot = process.env.PI_CODING_WORKSPACE_DIR, originRoot }: AdministrationOptions = {}) {
  const inventory = inventoryManagedWorkspaces({ stateRoot, originRoot });
  const actions = inventory.workspaces
    .filter((entry) => (entry.receipt.state === "preserved" || entry.receipt.state === "cleanup-debt") && entry.identity === true)
    .map((entry) => ({ workspaceId: entry.receipt.workspaceId, leaseId: entry.receipt.leaseId, action: "release" }));
  const body = { schemaVersion: "managed-workspace-reconcile-plan.v2", stateRoot: inventory.stateRoot, actions, requiresExplicitAuthorization: true };
  return Object.freeze({ ...body, planHash: planHash(body) });
}

export function applyManagedWorkspaceCleanup({ stateRoot = process.env.PI_CODING_WORKSPACE_DIR, plan, authorizations }: ApplyCleanupInput = {}) {
  const ledger = createManagedWorkspaceLedger({ stateRoot });
  const body = {
    schemaVersion: plan?.schemaVersion,
    stateRoot: plan?.stateRoot,
    actions: plan?.actions,
    ...(plan?.schemaVersion === "managed-workspace-reconcile-plan.v2" ? { requiresExplicitAuthorization: plan?.requiresExplicitAuthorization } : {}),
  };
  if (!plan || !["managed-workspace-reconcile-plan.v2", "managed-workspace-cleanup-plan.v1"].includes(plan.schemaVersion)
      || plan.stateRoot !== ledger.stateRoot || !Array.isArray(plan.actions) || plan.planHash !== planHash(body)) {
    throw new Error("managed workspace cleanup plan is invalid or stale");
  }
  if (!Array.isArray(authorizations)) throw new Error("explicit workspace cleanup authorizations are required");
  const authorized = new Map();
  for (const value of authorizations) {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).length !== 2 || !Object.hasOwn(value, "workspaceId") || !Object.hasOwn(value, "leaseId")) {
      throw new Error("workspace cleanup authorization is invalid");
    }
    authorized.set(value.workspaceId, value.leaseId);
  }
  const originRoots = [...new Set(plan.actions.map((action) =>
    ledger.load(action.workspaceId).record.request.originRoot
  ))];
  const currentActions = originRoots.flatMap((originRoot) =>
    planManagedWorkspaceCleanup({ stateRoot: ledger.stateRoot, originRoot }).actions
  );
  if (JSON.stringify(canonical(currentActions)) !== JSON.stringify(canonical(plan.actions))) {
    throw new Error("managed workspace cleanup plan changed or is stale");
  }
  for (const action of plan.actions) {
    if (authorized.get(action.workspaceId) !== action.leaseId) throw new Error(`workspace cleanup is not authorized: ${action.workspaceId}`);
  }
  const service = createManagedWorkspaceService({ stateRoot: ledger.stateRoot });
  return plan.actions.map((action) => {
    const lease = ledger.load(action.workspaceId);
    const proof = lease.record.run ? { state: "observed", conflict: false, proofId: "0".repeat(64), runId: lease.record.run.runId, rootSessionId: lease.record.request.owner.rootSessionId, asyncDir: lease.record.run.asyncDir, processInstance: "reconcile" } : { state: "pending" };
    const authorization = service.issueRelease({ workspaceId: action.workspaceId, terminalProof: proof });
    return service.release({ workspaceId: action.workspaceId, terminalProof: authorization.terminalProof, actionToken: authorization.actionToken });
  });
}

// 读取待归档 record 的原始字节：只接受 regular file 且拒绝 symlink，任何读取
// 失败都以 MANAGED_WORKSPACE_RECORD 编码暴露，不静默。
function readLegacyRecordBytes(recordPath: string): Buffer {
  let info;
  try { info = lstatSync(recordPath); }
  catch (cause) { throw Object.assign(new Error("legacy workspace record is unavailable"), { code: "MANAGED_WORKSPACE_RECORD", cause }); }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw Object.assign(new Error("legacy workspace record is not a regular file"), { code: "MANAGED_WORKSPACE_RECORD" });
  }
  try { return readFileSync(recordPath); }
  catch (cause) { throw Object.assign(new Error("legacy workspace record is unreadable"), { code: "MANAGED_WORKSPACE_RECORD", cause }); }
}

function parseLegacyRecordJson(bytes: Buffer) {
  try { return JSON.parse(bytes.toString("utf8")); } catch { return undefined; }
}

function legacyRecordPath(stateRoot: string, action: { repositoryPartition: string; workspaceId: string }) {
  if (!SHA256_HEX.test(action.repositoryPartition) || typeof action.workspaceId !== "string" || !SAFE_ID.test(action.workspaceId) || action.workspaceId.includes("..")) {
    throw new Error("managed workspace legacy quarantine plan is invalid or stale");
  }
  return path.join(stateRoot, "repositories", action.repositoryPartition, "records", `${action.workspaceId}.json`);
}

/** 只读 dry-run：从全 state root invalid 扫描中挑出原始 schemaVersion 明确为
 * v1 legacy 的 record，绑定原始字节 hash 生成归档计划。不修改任何文件。 */
export function planManagedWorkspaceLegacyQuarantine({ stateRoot = process.env.PI_CODING_WORKSPACE_DIR }: { stateRoot?: string } = {}) {
  const ledger = createManagedWorkspaceLedger({ stateRoot });
  const actions = ledger.scanInvalidRecords()
    .filter((diagnostic) => diagnostic.kind === "ledger-record" && diagnostic.legacyV1 && typeof diagnostic.workspaceId === "string")
    .map((diagnostic) => {
      const recordPath = legacyRecordPath(ledger.stateRoot, { repositoryPartition: diagnostic.repositoryPartition ?? "", workspaceId: diagnostic.workspaceId ?? "" });
      const bytes = readLegacyRecordBytes(recordPath);
      if (parseLegacyRecordJson(bytes)?.schemaVersion !== LEGACY_LEDGER_SCHEMA_V1) {
        throw Object.assign(new Error("legacy workspace record content changed"), { code: "MANAGED_WORKSPACE_RECORD" });
      }
      return {
        action: "archive-record",
        repositoryPartition: diagnostic.repositoryPartition,
        workspaceId: diagnostic.workspaceId,
        schemaVersion: LEGACY_LEDGER_SCHEMA_V1,
        recordSha256: createHash("sha256").update(bytes).digest("hex"),
        recordBytes: bytes.byteLength,
        originRootPresent: diagnostic.originRootPresent,
      };
    })
    .sort((left, right) => `${left.repositoryPartition}/${left.workspaceId}`.localeCompare(`${right.repositoryPartition}/${right.workspaceId}`));
  const body = { schemaVersion: LEGACY_QUARANTINE_PLAN_SCHEMA, stateRoot: ledger.stateRoot, archiveId: randomUUID(), actions, requiresExplicitAuthorization: true };
  return Object.freeze({ ...body, planHash: planHash(body) }) as LegacyQuarantinePlan;
}

/** 按计划把明确的 v1 legacy record 移动到 state root 下的 quarantine 目录。
 * 必须通过 plan hash、record bytes hash、schemaVersion、regular file、计划外
 * 变化和逐 record 显式授权的全部检查；只移动计划内 record，不删除 worktree、
 * queue、proof outbox 或任何未知记录。 */
export function applyManagedWorkspaceLegacyQuarantine({ stateRoot = process.env.PI_CODING_WORKSPACE_DIR, plan, authorizations }: LegacyQuarantineInput = {}) {
  const ledger = createManagedWorkspaceLedger({ stateRoot });
  const body = plan ? {
    schemaVersion: plan.schemaVersion,
    stateRoot: plan.stateRoot,
    archiveId: plan.archiveId,
    actions: plan.actions,
    requiresExplicitAuthorization: plan.requiresExplicitAuthorization,
  } : undefined;
  if (!plan || plan.schemaVersion !== LEGACY_QUARANTINE_PLAN_SCHEMA
      || plan.stateRoot !== ledger.stateRoot || plan.requiresExplicitAuthorization !== true
      || typeof plan.archiveId !== "string" || !SAFE_ID.test(plan.archiveId) || plan.archiveId.includes("..")
      || !Array.isArray(plan.actions) || plan.planHash !== planHash(body)) {
    throw new Error("managed workspace legacy quarantine plan is invalid or stale");
  }
  for (const action of plan.actions) {
    if (!action || typeof action !== "object" || Array.isArray(action)
        || Object.keys(action).length !== 7 || action.action !== "archive-record"
        || action.schemaVersion !== LEGACY_LEDGER_SCHEMA_V1
        || !SHA256_HEX.test(action.recordSha256 ?? "")
        || !Number.isSafeInteger(action.recordBytes) || action.recordBytes < 0
        || (action.originRootPresent !== null && typeof action.originRootPresent !== "boolean")) {
      throw new Error("managed workspace legacy quarantine plan is invalid or stale");
    }
    legacyRecordPath(ledger.stateRoot, action);
  }
  // 计划变更检测：重新扫描并重算计划内容，任何 record 增减/字节变化/origin
  // 存在性翻转都拒绝；archiveId 每次规划新生成，仅作目录名不参与比较。
  const current = planManagedWorkspaceLegacyQuarantine({ stateRoot: ledger.stateRoot });
  if (JSON.stringify(canonical(current.actions)) !== JSON.stringify(canonical(plan.actions))) {
    throw new Error("managed workspace legacy quarantine plan changed or is stale");
  }
  if (!Array.isArray(authorizations)) throw new Error("explicit legacy quarantine authorizations are required");
  const authorized = new Map();
  for (const value of authorizations) {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).length !== 2 || !Object.hasOwn(value, "workspaceId") || !Object.hasOwn(value, "recordSha256")
        || typeof value.workspaceId !== "string" || !SHA256_HEX.test(value.recordSha256)) {
      throw new Error("legacy quarantine authorization is invalid");
    }
    if (authorized.has(value.workspaceId)) throw new Error("legacy quarantine authorization is duplicated");
    authorized.set(value.workspaceId, value.recordSha256);
  }
  if (authorized.size !== plan.actions.length) throw new Error("legacy quarantine authorizations do not match the plan");
  for (const action of plan.actions) {
    if (authorized.get(action.workspaceId) !== action.recordSha256) throw new Error(`legacy quarantine is not authorized: ${action.workspaceId}`);
  }
  const archived = [];
  for (const action of plan.actions) {
    const recordPath = legacyRecordPath(ledger.stateRoot, action);
    const bytes = readLegacyRecordBytes(recordPath);
    if (createHash("sha256").update(bytes).digest("hex") !== action.recordSha256
        || bytes.byteLength !== action.recordBytes
        || parseLegacyRecordJson(bytes)?.schemaVersion !== LEGACY_LEDGER_SCHEMA_V1) {
      throw Object.assign(new Error(`legacy workspace record changed before quarantine: ${action.workspaceId}`), { code: "MANAGED_WORKSPACE_RECORD" });
    }
    const archiveDir = path.join(ledger.stateRoot, "quarantine", "legacy", plan.archiveId, action.repositoryPartition);
    mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
    chmodSync(archiveDir, 0o700);
    const quarantinePath = path.join(archiveDir, `${action.workspaceId}.json`);
    if (existsSync(quarantinePath)) {
      throw Object.assign(new Error(`legacy quarantine target already exists: ${action.workspaceId}`), { code: "MANAGED_WORKSPACE_RECORD" });
    }
    // 归档是原子移动原始 record（保留字节/权限/分区/workspaceId），不是删除。
    renameSync(recordPath, quarantinePath);
    if (existsSync(recordPath)) {
      throw Object.assign(new Error(`legacy workspace record did not move: ${action.workspaceId}`), { code: "MANAGED_WORKSPACE_RECORD" });
    }
    if (createHash("sha256").update(readLegacyRecordBytes(quarantinePath)).digest("hex") !== action.recordSha256) {
      throw Object.assign(new Error(`legacy workspace record bytes changed in quarantine: ${action.workspaceId}`), { code: "MANAGED_WORKSPACE_RECORD" });
    }
    archived.push({
      action: "archive-record",
      repositoryPartition: action.repositoryPartition,
      workspaceId: action.workspaceId,
      schemaVersion: action.schemaVersion,
      recordSha256: action.recordSha256,
      quarantineRelativePath: path.join("quarantine", "legacy", plan.archiveId, action.repositoryPartition, `${action.workspaceId}.json`),
    });
  }
  return Object.freeze({ schemaVersion: LEGACY_QUARANTINE_RECEIPT_SCHEMA, stateRoot: ledger.stateRoot, archiveId: plan.archiveId, planHash: plan.planHash, archived });
}
