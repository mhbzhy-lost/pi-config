import { createHash } from "node:crypto";
import { lstatSync, realpathSync, readdirSync, readFileSync } from "node:fs";
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
  const records = ledger.list({ originRoot });
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
  return Object.freeze({ schemaVersion: "managed-workspace-inventory.v2", stateRoot: ledger.stateRoot, workspaces, orphanRegistrations, legacy });
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
