import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

import { inspectManagedGitWorkspace, listManagedGitRegistrations } from "./git-worktree.ts";
import { createManagedWorkspaceLedger, managedWorkspaceReceiptFromRecord } from "./ledger.ts";
import { createManagedWorkspaceService } from "./service.ts";

type AdministrationOptions = { stateRoot?: string; originRoot?: string };
type CleanupAuthorization = { workspaceId: string; leaseId: string };
type CleanupPlan =
  | { schemaVersion: "managed-workspace-cleanup-plan.v1"; stateRoot: string; actions: CleanupAuthorization[]; planHash: string }
  | { schemaVersion: "managed-workspace-reconcile-plan.v2"; stateRoot: string; actions: CleanupAuthorization[]; planHash: string; requiresExplicitAuthorization: boolean };
type ApplyCleanupInput = { stateRoot?: string; plan?: CleanupPlan; authorizations?: CleanupAuthorization[] };

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
    const receipt = record.schemaVersion === "managed-workspace-ledger.v2"
      ? {
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
      }
      : managedWorkspaceReceiptFromRecord(record);
    return {
      receipt,
      ledgerVersion: record.schemaVersion,
      ledgerGeneration: record.revision,
      intent: record.schemaVersion === "managed-workspace-ledger.v2"
        ? { action: record.v2Action, disposition: record.pendingAction }
        : { action: null, disposition: record.pendingAction },
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
  return plan.actions.map((action) => service.release({ workspaceId: action.workspaceId }));
}
