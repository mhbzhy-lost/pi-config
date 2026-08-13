import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { createManagedWorktree, preserveManagedWorktree, releaseManagedWorktree } from "../worktree-lifecycle/managed-worktree.mjs";
import { markDisposition } from "../worktree-lifecycle/registry.mjs";
import { assertWorkspaceChangesWithinPaths, inspectExecutorWorkspace, inspectOriginIntegrationBaseline, integrateExecutorWorkspace, isExecutorWorkspaceIntegrated } from "../goal-engine/workspace.mjs";

const OWNER_KIND = "typed-subagent-workspace";
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function git(cwd, ...args) { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function tryGit(cwd, ...args) { try { return git(cwd, ...args); } catch { return null; } }
function runtime(pathname) { return pathname === ".state" || pathname.startsWith(".state/") || pathname === ".pi-subagents" || pathname.startsWith(".pi-subagents/"); }
function clean(cwd) {
  const output = git(cwd, "status", "--porcelain=v1", "-z");
  const fields = output.split("\0").filter(Boolean);
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i]; const status = record.slice(0, 2); const names = [record.slice(3)];
    if (/[RC]/.test(status)) names.push(fields[++i] ?? "");
    if (!names.every(runtime)) return false;
  }
  return true;
}
function attached(cwd) { const ref = tryGit(cwd, "symbolic-ref", "--quiet", "HEAD"); if (!ref) fail("WORKTREE_SOURCE_DETACHED", "source HEAD must be attached"); return ref; }
function requireLease(lease) {
  if (!lease || typeof lease !== "object" || !ID.test(lease.workspaceId ?? "")) fail("WORKTREE_IDENTITY_INVALID", "invalid workspace lease");
  if (!path.isAbsolute(lease.originRoot ?? "") || !path.isAbsolute(lease.path ?? "")) fail("WORKTREE_IDENTITY_INVALID", "workspace paths must be absolute");
  if (lease.owner?.kind !== OWNER_KIND || lease.owner?.id !== lease.workspaceId || typeof lease.ownerToken !== "string") fail("WORKTREE_OWNER_INVALID", "workspace owner receipt is invalid");
  return lease;
}
function goalLease(lease) {
  return { ...lease, branch: lease.branchRef.slice("refs/heads/".length), goalId: "subagent", taskId: lease.workspaceId, attempt: 1 };
}
function inspection(lease) {
  requireLease(lease);
  try {
    const inspected = inspectExecutorWorkspace(goalLease(lease));
    return { ...inspected, originRef: attached(lease.originRoot), originHead: git(lease.originRoot, "rev-parse", "HEAD"), originClean: clean(lease.originRoot) };
  } catch (error) {
    fail("WORKTREE_IDENTITY_INVALID", error instanceof Error ? error.message : "workspace identity drifted");
  }
}
function terminal(proof) { return proof && proof.state === "observed" && proof.conflict !== true && typeof proof.proofHash === "string" && proof.proofHash.length > 0; }
function snapshotValue(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

export function createSubagentWorkspace(input) {
  if (!input || !ID.test(input.workspaceId ?? "") || !["coding", "generic"].includes(input.kind)) fail("WORKTREE_INPUT_INVALID", "invalid workspace allocation");
  const originRoot = realpathSync(input.originRoot);
  // A linked worktree is never a safe allocation source (including Goal workspaces).
  if (!lstatSync(path.join(originRoot, ".git")).isDirectory()) fail("WORKTREE_NESTED", "workspace allocation source must be the primary worktree");
  const originRef = attached(originRoot);
  if (!clean(originRoot)) fail("WORKTREE_SOURCE_DIRTY", "workspace allocation source must be clean");
  const baseCommit = git(originRoot, "rev-parse", "HEAD");
  if (input.baseCommit && git(originRoot, "rev-parse", input.baseCommit) !== baseCommit) fail("WORKTREE_IDENTITY_DRIFT", "allocation base drifted");
  if (input.originRef && input.originRef !== originRef) fail("WORKTREE_IDENTITY_DRIFT", "allocation ref drifted");
  if (input.originHeadAtAllocation && input.originHeadAtAllocation !== baseCommit) fail("WORKTREE_IDENTITY_DRIFT", "allocation HEAD drifted");
  const requested = realpathSync(input.requestedCwd ?? originRoot);
  if (requested !== originRoot && !requested.startsWith(`${originRoot}${path.sep}`)) fail("WORKTREE_CWD_OUTSIDE_ORIGIN", "requested cwd is outside origin");
  const relative = path.relative(originRoot, requested);
  const workspacePath = path.join(originRoot, ".state", "subagent-dispatch", "worktrees", input.workspaceId);
  const branch = input.branch ?? `subagent/${input.workspaceId}`;
  const managed = createManagedWorktree({ originRoot, id: input.workspaceId, branch, baseCommit, path: workspacePath, owner: { kind: OWNER_KIND, id: input.workspaceId } });
  const dispatchCwd = path.join(managed.path, relative);
  if (!existsSync(dispatchCwd)) fail("WORKTREE_CWD_MISSING", "requested cwd does not exist in workspace");
  return { ...input, workspaceId: input.workspaceId, originRoot, originRef, originHeadAtAllocation: baseCommit, baseCommit, path: managed.path, branchRef: managed.branchRef, owner: { kind: OWNER_KIND, id: input.workspaceId }, ownerToken: managed.ownerToken, dispatchCwd };
}
export function inspectSubagentWorkspace(lease) { return inspection(lease); }
export function snapshotSubagentWorkspace({ lease, terminalProof }) {
  if (!terminalProof || typeof terminalProof.state !== "string") fail("WORKTREE_SNAPSHOT_INVALID", "terminal proof is invalid");
  const inspected = inspection(lease);
  const terminalState = { state: terminalProof.state, conflict: terminalProof.conflict === true, proofHash: terminalProof.proofHash ?? null };
  const value = { workspaceId: lease.workspaceId, terminal: terminalState, ...inspected };
  return { ...value, snapshotHash: snapshotValue(value) };
}
function assertSnapshot(lease, snapshot, { destructive = false } = {}) {
  if (!snapshot || snapshot.workspaceId !== lease.workspaceId || typeof snapshot.snapshotHash !== "string" || !snapshot.terminal) fail("WORKTREE_SNAPSHOT_INVALID", "workspace snapshot is invalid");
  const now = inspection(lease); const value = { workspaceId: lease.workspaceId, terminal: snapshot.terminal, ...now };
  if (snapshot.snapshotHash !== snapshotValue(value)) fail("WORKTREE_SNAPSHOT_STALE", "workspace snapshot changed");
  if (destructive && !terminal(snapshot.terminal)) fail("WORKTREE_TERMINAL_UNOBSERVED", "terminal proof is not observed and unambiguous");
  return now;
}
export function integrateSubagentWorkspace({ lease, snapshot, strategy = "cherry-pick" }) {
  if (lease?.kind !== "coding") fail("WORKTREE_INTEGRATE_FORBIDDEN", "generic workspaces cannot integrate");
  const state = assertSnapshot(lease, snapshot, { destructive: true });
  if (!state.clean || !state.hasCommits || !state.descendant) fail("WORKTREE_INTEGRATE_UNSAFE", "workspace must be a clean descendant with commits");
  assertWorkspaceChangesWithinPaths({ changedFiles: state.changedFiles }, lease.writePaths);
  if (state.originRef !== lease.originRef || !clean(lease.originRoot)) fail("WORKTREE_ORIGIN_DRIFT", "origin changed before integration");
  if (!["cherry-pick", "merge"].includes(strategy)) fail("WORKTREE_INTEGRATE_FORBIDDEN", "unknown integration strategy");
  let result;
  try {
    const baseline = inspectOriginIntegrationBaseline(goalLease(lease), { originRef: lease.originRef, originHeadBefore: lease.originHeadAtAllocation, allowForwardAdvance: true });
    result = integrateExecutorWorkspace(goalLease(lease), { strategy, executorHead: state.headCommit, originRef: lease.originRef, originHeadBefore: baseline.currentHead });
  }
  catch (error) { fail("WORKTREE_INTEGRATE_CONFLICT", "integration failed; workspace preserved"); }
  try { markDisposition({ originRoot: lease.originRoot, id: lease.workspaceId, ownerToken: lease.ownerToken, disposition: "reclaimable" }); }
  catch (error) { error.phase = "managed-reclaimable"; throw error; }
  return { integrated: true, strategy, executorHead: state.headCommit, headCommit: result.newHead, preserved: true };
}
export function isSubagentWorkspaceIntegrated({ lease, strategy, executorHead }) { return isExecutorWorkspaceIntegrated(goalLease(lease), { strategy, executorHead }); }
export function reclaimSubagentWorkspace({ lease }) { return markDisposition({ originRoot: lease.originRoot, id: lease.workspaceId, ownerToken: lease.ownerToken, disposition: "reclaimable" }); }
export function releaseReclaimableSubagentWorkspace({ lease }) { return releaseManagedWorktree({ originRoot: lease.originRoot, id: lease.workspaceId, ownerToken: lease.ownerToken }); }
export function releasePreservedSubagentWorkspace({ lease }) {
  markDisposition({ originRoot: lease.originRoot, id: lease.workspaceId, ownerToken: lease.ownerToken, disposition: "reclaimable" });
  return releaseManagedWorktree({ originRoot: lease.originRoot, id: lease.workspaceId, ownerToken: lease.ownerToken });
}
export function preserveSubagentWorkspace({ lease, snapshot, reason = "subagent workspace preserved" }) { assertSnapshot(lease, snapshot); preserveManagedWorktree({ originRoot: lease.originRoot, id: lease.workspaceId, ownerToken: lease.ownerToken, reason }); return { preserved: true, released: false }; }
export function discardSubagentWorkspace({ lease, snapshot }) { const state = assertSnapshot(lease, snapshot, { destructive: true }); if (!state.clean) fail("WORKTREE_DISCARD_UNSAFE", "workspace must be clean before discard"); reclaimSubagentWorkspace({ lease }); releaseReclaimableSubagentWorkspace({ lease }); return { preserved: false, released: true }; }
