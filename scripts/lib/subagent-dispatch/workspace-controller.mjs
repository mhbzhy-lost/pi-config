import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { allocateWorkspaceIntent, activateWorkspace, bindWorkspaceRun, consumeWorkspaceAction, finalizeWorkspaceDisposition, issueWorkspaceAction, loadWorkspace, markWorkspaceState, publicWorkspace, recoverPrivateWorkspaceLease } from "./workspace-ledger.mjs";
import { assertWorkspaceChangesWithinPaths } from "../goal-engine/workspace.mjs";
import { createSubagentWorkspace, discardSubagentWorkspace, integrateSubagentWorkspace, isSubagentWorkspaceIntegrated, preserveSubagentWorkspace, reclaimSubagentWorkspace, releasePreservedSubagentWorkspace, releaseReclaimableSubagentWorkspace, snapshotSubagentWorkspace } from "./workspace.mjs";

const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function clean(cwd) { return git(cwd, "status", "--porcelain=v1", "-z").split("\0").filter(Boolean).every((x) => { const p = x.slice(3); return p === ".state" || p.startsWith(".state/") || p === ".pi-subagents" || p.startsWith(".pi-subagents/"); }); }
function plan(input) {
  const originRoot = realpathSync(input.originRoot);
  if (git(originRoot, "rev-parse", "--show-toplevel") !== originRoot || !statSync(join(originRoot, ".git")).isDirectory()) fail("WORKTREE_SOURCE_INVALID", "workspace allocation source must be a primary Git top-level");
  const originRef = git(originRoot, "symbolic-ref", "--quiet", "HEAD"); const baseCommit = git(originRoot, "rev-parse", "HEAD");
  if (!clean(originRoot)) fail("WORKTREE_SOURCE_DIRTY", "workspace allocation source must be clean");
  const requestedCwd = realpathSync(input.requestedCwd ?? originRoot); const rel = relative(originRoot, requestedCwd);
  if (rel.startsWith("..") || rel === "") { if (rel.startsWith("..")) fail("WORKTREE_CWD_OUTSIDE_ORIGIN", "requested cwd is outside origin"); }
  const workspacePath = join(originRoot, ".state", "subagent-dispatch", "worktrees", input.workspaceId);
  return { ...input, originRoot, originRef, originHeadAtAllocation: baseCommit, baseCommit, requestedCwd, workspacePath, dispatchCwd: join(workspacePath, rel), branchRef: `refs/heads/${input.branch ?? `subagent/${input.workspaceId}`}` };
}
function privateLease(record) { return { workspaceId: record.workspaceId, originRoot: record.originRoot, ownerToken: record.ownerToken, kind: record.kind, path: record.workspacePath, workspacePath: record.workspacePath, dispatchCwd: record.dispatchCwd, branchRef: record.branchRef, baseCommit: record.baseCommit, originRef: record.originRef, originHeadAtAllocation: record.originHeadAtAllocation, writePaths: record.writePaths, owner: { kind: "typed-subagent-workspace", id: record.workspaceId } }; }
function result(record, extra = {}) { return { ...publicWorkspace(record), ...extra }; }
export function allocateManagedSubagentWorkspace(input) {
  const frozen = plan(input); let ledger = allocateWorkspaceIntent(frozen);
  try { faultAt(input.fault, "before-managed-create"); const managed = createSubagentWorkspace({ ...frozen, branch: frozen.branchRef.slice("refs/heads/".length) }); ledger = activateWorkspace(ledger, { workspacePath: managed.path, dispatchCwd: managed.dispatchCwd, branchRef: managed.branchRef, baseCommit: managed.baseCommit, ownerToken: managed.ownerToken }); return result(ledger.record); }
  catch (error) { if (error && typeof error === "object") error.detail = { workspaceId: ledger.record.workspaceId, state: ledger.record.state, originRoot: ledger.record.originRoot }; throw error; }
}
export function bindManagedSubagentWorkspaceRun(context, binding) { const lease = recoverPrivateWorkspaceLease({ originRoot: context.originRoot, workspaceId: context.workspaceId }); return result(bindWorkspaceRun({ lease, runId: binding.runId, asyncDir: binding.asyncDir }).record); }
export function statusManagedSubagentWorkspace({ originRoot, workspaceId, terminalProof }) {
  let lease = recoverPrivateWorkspaceLease({ originRoot, workspaceId });
  if (lease.record.pendingDisposition) return recoverManagedSubagentWorkspace({ originRoot, workspaceId, terminalProof });
  if (lease.record.state !== "active") return result(lease.record, { allowedDispositions: [], integrateBlockedReasons: [] });
  const workspaceLease = privateLease(lease.record); const snapshot = snapshotSubagentWorkspace({ lease: workspaceLease, terminalProof }); const allowed = ["preserve"];
  const integrateBlockedReasons = [];
  if (terminalProof?.state !== "observed" || terminalProof.conflict === true) integrateBlockedReasons.push("terminal-unobserved");
  if (lease.record.kind !== "coding") integrateBlockedReasons.push("generic-cannot-integrate");
  if (!snapshot.clean) integrateBlockedReasons.push("workspace-dirty");
  if (!snapshot.hasCommits) integrateBlockedReasons.push("no-commits");
  if (!snapshot.descendant) integrateBlockedReasons.push("not-descendant");
  if (snapshot.originRef !== lease.record.originRef) integrateBlockedReasons.push("origin-ref-drift");
  if (!snapshot.originClean) integrateBlockedReasons.push("origin-dirty");
  if (snapshot.originHead !== lease.record.originHeadAtAllocation) {
    try { git(lease.record.originRoot, "merge-base", "--is-ancestor", lease.record.originHeadAtAllocation, snapshot.originHead); }
    catch (error) { if (error?.status === 1) integrateBlockedReasons.push("origin-advanced-nonlinear"); else throw error; }
  }
  try { assertWorkspaceChangesWithinPaths({ changedFiles: snapshot.changedFiles }, lease.record.writePaths); }
  catch { integrateBlockedReasons.push("writePaths-out-of-scope"); }
  if (terminalProof?.state === "observed" && terminalProof.conflict !== true && snapshot.clean) {
    allowed.push("discard");
    if (integrateBlockedReasons.length === 0) allowed.push("integrate");
  }
  const issued = issueWorkspaceAction({ lease, snapshotHash: snapshot.snapshotHash, allowed }); return result(issued.lease.record, { allowedDispositions: allowed, actionToken: issued.actionToken, integrateBlockedReasons });
}
function faultAt(fault, point) { if (fault) fault(point); }
function finalize(lease, state) { return result(finalizeWorkspaceDisposition({ lease, state }).record); }
function currentProofMatches(pending, terminalProof) { return terminalProof?.state === "observed" && terminalProof.conflict !== true && typeof terminalProof.proofHash === "string" && terminalProof.proofHash === pending.proofHash; }
function releaseOrContinue(lease, workspaceLease) {
  try { releaseReclaimableSubagentWorkspace({ lease: workspaceLease }); return true; }
  catch (error) { if (error?.code !== "WORKTREE_LIFECYCLE_NOT_RECLAIMABLE" || !existsSync(lease.record.workspacePath)) throw error; return false; }
}
export function recoverManagedSubagentWorkspace({ originRoot, workspaceId, terminalProof, fault }) {
  const lease = recoverPrivateWorkspaceLease({ originRoot, workspaceId }); const pending = lease.record.pendingDisposition;
  if (!pending) return result(lease.record, { allowedDispositions: [] });
  const workspaceLease = privateLease(lease.record);
  if (pending.disposition === "preserve") { const snapshot = snapshotSubagentWorkspace({ lease: workspaceLease, terminalProof }); preserveSubagentWorkspace({ lease: workspaceLease, snapshot }); faultAt(fault, "before-ledger-final"); return finalize(lease, "preserved"); }
  if (!currentProofMatches(pending, terminalProof)) fail("WORKSPACE_RECOVERY_REVIEW", "pending proof changed; workspace retained");
  if (releaseOrContinue(lease, workspaceLease)) { faultAt(fault, "after-managed-release"); faultAt(fault, "before-ledger-final"); return finalize(lease, "released"); }
  const snapshot = snapshotSubagentWorkspace({ lease: workspaceLease, terminalProof });
  if (snapshot.snapshotHash !== pending.snapshotHash) fail("WORKSPACE_RECOVERY_REVIEW", "pending snapshot changed; workspace retained");
  if (pending.disposition === "integrate") {
    let integrated = false;
    try { integrated = isSubagentWorkspaceIntegrated({ lease: workspaceLease, strategy: pending.strategy, executorHead: pending.executorHead }); } catch {}
    if (!integrated) { integrateSubagentWorkspace({ lease: workspaceLease, snapshot, strategy: pending.strategy }); faultAt(fault, "after-integrate"); }
  }
  reclaimSubagentWorkspace({ lease: workspaceLease }); faultAt(fault, "after-managed-reclaimable");
  releaseReclaimableSubagentWorkspace({ lease: workspaceLease }); faultAt(fault, "after-managed-release"); faultAt(fault, "before-ledger-final"); return finalize(lease, "released");
}
export function disposeManagedSubagentWorkspace({ originRoot, workspaceId, terminalProof, disposition, strategy = "cherry-pick", actionToken, fault }) {
  let lease = recoverPrivateWorkspaceLease({ originRoot, workspaceId });
  if (lease.record.pendingDisposition) return recoverManagedSubagentWorkspace({ originRoot, workspaceId, terminalProof, fault });
  const workspaceLease = privateLease(lease.record); const snapshot = snapshotSubagentWorkspace({ lease: workspaceLease, terminalProof });
  const executorHead = disposition === "integrate" ? snapshot.headCommit : null;
  lease = consumeWorkspaceAction({ lease, actionToken, snapshotHash: snapshot.snapshotHash, disposition, strategy: disposition === "integrate" ? strategy : null, proofHash: terminalProof?.proofHash ?? null, executorHead }); faultAt(fault, "after-consume");
  return recoverManagedSubagentWorkspace({ originRoot, workspaceId, terminalProof, fault });
}
export function releaseManagedSubagentWorkspace({ originRoot, workspaceId }) {
  const lease = recoverPrivateWorkspaceLease({ originRoot, workspaceId });
  if (lease.record.state !== "preserved") fail("WORKSPACE_LEDGER_STATE", "workspace is not preserved");
  releasePreservedSubagentWorkspace({ lease: privateLease(lease.record) });
  return result(markWorkspaceState({ lease, state: "released" }).record);
}
export function loadManagedSubagentWorkspace({ originRoot, workspaceId }) { return loadWorkspace({ originRoot, workspaceId }); }
export function createWorkspaceController({ fault } = {}) { return { allocateManagedSubagentWorkspace: (input) => allocateManagedSubagentWorkspace({ ...input, fault: input.fault ?? fault }), bindManagedSubagentWorkspaceRun, loadManagedSubagentWorkspace, statusManagedSubagentWorkspace, disposeManagedSubagentWorkspace: (input) => disposeManagedSubagentWorkspace({ ...input, fault: input.fault ?? fault }), recoverManagedSubagentWorkspace: (input) => recoverManagedSubagentWorkspace({ ...input, fault: input.fault ?? fault }), releaseManagedSubagentWorkspace }; }
