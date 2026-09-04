import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

import { inspectManagedGitWorkspace, listManagedGitRegistrations } from "./git-worktree.ts";
import { createManagedWorkspaceLedger, managedWorkspaceReceiptFromRecord } from "./ledger.ts";
import { createManagedWorkspaceService } from "./service.ts";

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

export function inventoryManagedWorkspaces({ stateRoot = process.env.PI_CODING_WORKSPACE_DIR, originRoot } = {}) {
  const ledger = createManagedWorkspaceLedger({ stateRoot });
  const records = ledger.list({ originRoot });
  const workspaces = records.map((record) => {
    let identity = null;
    const issues = [];
    if (record.state === "active" || record.state === "preserved" || record.state === "disposing") {
      try { inspectManagedGitWorkspace(record); identity = true; }
      catch (error) { identity = false; issues.push(error?.code ?? "MANAGED_WORKSPACE_IDENTITY"); }
    }
    if (record.state === "cleanup-debt") issues.push("cleanup-debt");
    return { receipt: managedWorkspaceReceiptFromRecord(record), identity, issues };
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
  return Object.freeze({ schemaVersion: "managed-workspace-inventory.v1", stateRoot: ledger.stateRoot, workspaces, orphanRegistrations, legacy });
}

export function planManagedWorkspaceCleanup({ stateRoot = process.env.PI_CODING_WORKSPACE_DIR, originRoot } = {}) {
  const inventory = inventoryManagedWorkspaces({ stateRoot, originRoot });
  const actions = inventory.workspaces
    .filter((entry) => entry.receipt.state === "preserved" && entry.identity === true)
    .map((entry) => ({ workspaceId: entry.receipt.workspaceId, leaseId: entry.receipt.leaseId, action: "release" }));
  const body = { schemaVersion: "managed-workspace-cleanup-plan.v1", stateRoot: inventory.stateRoot, actions };
  return Object.freeze({ ...body, planHash: planHash(body) });
}

export function applyManagedWorkspaceCleanup({ stateRoot = process.env.PI_CODING_WORKSPACE_DIR, plan, authorizations } = {}) {
  const ledger = createManagedWorkspaceLedger({ stateRoot });
  const body = { schemaVersion: plan?.schemaVersion, stateRoot: plan?.stateRoot, actions: plan?.actions };
  if (!plan || plan.schemaVersion !== "managed-workspace-cleanup-plan.v1" || plan.stateRoot !== ledger.stateRoot
      || !Array.isArray(plan.actions) || plan.planHash !== planHash(body)) {
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
  const current = planManagedWorkspaceCleanup({ stateRoot: ledger.stateRoot });
  if (current.planHash !== plan.planHash) throw new Error("managed workspace cleanup plan changed or is stale");
  for (const action of plan.actions) {
    if (authorized.get(action.workspaceId) !== action.leaseId) throw new Error(`workspace cleanup is not authorized: ${action.workspaceId}`);
  }
  const service = createManagedWorkspaceService({ stateRoot: ledger.stateRoot });
  return plan.actions.map((action) => service.release({ workspaceId: action.workspaceId }));
}
