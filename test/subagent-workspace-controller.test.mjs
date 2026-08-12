import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTemporaryArenaSync } from "./helpers/temporary-arena.mjs";

const arena = createTemporaryArenaSync("subagent-controller-");
test.after(() => arena.disposeSync());
const controller = await import("../scripts/lib/subagent-dispatch/workspace-controller.mjs");
const ledger = await import("../scripts/lib/subagent-dispatch/workspace-ledger.mjs");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
function repo() { const root = arena.mkdtempSync("repo-"); git(root, "init"); git(root, "config", "user.email", "t@e.test"); git(root, "config", "user.name", "T"); mkdirSync(join(root, "src")); writeFileSync(join(root, "src", "a.txt"), "base\n"); git(root, "add", "."); git(root, "commit", "-m", "base"); return root; }
function input(root, id, kind = "coding") { return { workspaceId: id, kind, originRoot: root, rootSessionId: "s", toolCallId: "t", requestedCwd: root, writePaths: kind === "coding" ? ["src/**"] : null }; }
const proof = { state: "observed", conflict: false, proofHash: "official-proof" };

test("controller rejects a nested Git worktree source before writing an intent", () => {
  const root = repo(); const nested = join(root, "src");
  assert.throws(() => controller.allocateManagedSubagentWorkspace(input(nested, "nested")), (error) => error?.code === "WORKTREE_SOURCE_INVALID");
  assert.equal(existsSync(join(nested, ".state/subagent-dispatch/workspaces/nested.json")), false);
});

test("controller durably records intent before managed creation and reloads create failure", () => {
  const root = repo();
  const workspace = controller.allocateManagedSubagentWorkspace(input(root, "bad"));
  const raw = JSON.parse(readFileSync(join(root, ".state/subagent-dispatch/workspaces/bad.json"), "utf8"));
  assert.equal(raw.state, "active");
  assert.equal(controller.statusManagedSubagentWorkspace({ originRoot: root, workspaceId: "bad", terminalProof: proof }).workspaceId, "bad");
  controller.disposeManagedSubagentWorkspace({ originRoot: root, workspaceId: "bad", terminalProof: proof, disposition: "discard", actionToken: controller.statusManagedSubagentWorkspace({ originRoot: root, workspaceId: "bad", terminalProof: proof }).actionToken });
  assert.equal(existsSync(workspace.workspacePath), false);
});

test("controller preserves pending, discards observed clean, and consumes a snapshot-bound token", () => {
  const root = repo();
  const pending = controller.allocateManagedSubagentWorkspace(input(root, "pending", "generic"));
  const p = controller.statusManagedSubagentWorkspace({ originRoot: root, workspaceId: pending.workspaceId, terminalProof: { state: "pending" } });
  assert.deepEqual(p.allowedDispositions, ["preserve"]);
  assert.equal(controller.disposeManagedSubagentWorkspace({ originRoot: root, workspaceId: pending.workspaceId, terminalProof: { state: "pending" }, disposition: "preserve", actionToken: p.actionToken }).state, "preserved");
  const clean = controller.allocateManagedSubagentWorkspace(input(root, "clean", "generic"));
  const s = controller.statusManagedSubagentWorkspace({ originRoot: root, workspaceId: clean.workspaceId, terminalProof: proof });
  assert.ok(s.allowedDispositions.includes("discard"));
  const disposed = controller.disposeManagedSubagentWorkspace({ originRoot: root, workspaceId: clean.workspaceId, terminalProof: proof, disposition: "discard", actionToken: s.actionToken });
  assert.equal(disposed.state, "released"); assert.equal(existsSync(clean.workspacePath), false);
  assert.throws(() => controller.disposeManagedSubagentWorkspace({ originRoot: root, workspaceId: clean.workspaceId, terminalProof: proof, disposition: "discard", actionToken: s.actionToken }), /used|token|state|missing/i);
  assert.equal(JSON.stringify(disposed).includes("ownerToken"), false);
});

test("controller recovers an authorized integration after an integration crash without a second commit", () => {
  const root = repo(); const coding = controller.allocateManagedSubagentWorkspace(input(root, "crash"));
  writeFileSync(join(coding.workspacePath, "src", "done.txt"), "done\n"); git(coding.workspacePath, "add", "."); git(coding.workspacePath, "commit", "-m", "done");
  const status = controller.statusManagedSubagentWorkspace({ originRoot: root, workspaceId: "crash", terminalProof: proof });
  const crashing = controller.createWorkspaceController({ fault: (point) => { if (point === "after-integrate") throw new Error("crash"); } });
  assert.throws(() => crashing.disposeManagedSubagentWorkspace({ originRoot: root, workspaceId: "crash", terminalProof: proof, disposition: "integrate", actionToken: status.actionToken }), /crash/);
  assert.equal(ledger.recoverPrivateWorkspaceLease({ originRoot: root, workspaceId: "crash" }).record.pendingDisposition.disposition, "integrate");
  const recovered = controller.statusManagedSubagentWorkspace({ originRoot: root, workspaceId: "crash", terminalProof: proof });
  assert.equal(recovered.state, "released"); assert.equal(existsSync(coding.workspacePath), false); assert.equal(git(root, "log", "--oneline", "HEAD", "--", "src/done.txt").split("\n").length, 1);
});

test("controller recovers every pending fault with a fresh controller", () => {
  for (const disposition of ["integrate", "discard"]) for (const point of ["after-consume", "after-integrate", "after-managed-reclaimable", "after-managed-release", "before-ledger-final"]) {
    if (disposition === "discard" && point === "after-integrate") continue;
    const root = repo(); const id = `${disposition}-${point}`.replaceAll("_", "-");
    const workspace = controller.allocateManagedSubagentWorkspace(input(root, id, disposition === "integrate" ? "coding" : "generic"));
    if (disposition === "integrate") { writeFileSync(join(workspace.workspacePath, "src", "done.txt"), "done\n"); git(workspace.workspacePath, "add", "."); git(workspace.workspacePath, "commit", "-m", "done"); }
    const status = controller.statusManagedSubagentWorkspace({ originRoot: root, workspaceId: id, terminalProof: proof });
    const crashing = controller.createWorkspaceController({ fault: (at) => { if (at === point) throw new Error(`fault:${point}`); } });
    assert.throws(() => crashing.disposeManagedSubagentWorkspace({ originRoot: root, workspaceId: id, terminalProof: proof, disposition, actionToken: status.actionToken }), /fault:/);
    const recovered = controller.createWorkspaceController().statusManagedSubagentWorkspace({ originRoot: root, workspaceId: id, terminalProof: proof });
    assert.equal(recovered.state, "released", `${disposition}/${point}`);
    assert.equal(existsSync(workspace.workspacePath), false, `${disposition}/${point}`);
    assert.doesNotThrow(() => git(root, "show-ref", "--verify", "--quiet", workspace.branchRef), `${disposition}/${point}`);
    if (disposition === "integrate") assert.equal(git(root, "log", "--oneline", "HEAD", "--", "src/done.txt").split("\n").length, 1);
  }
});

test("controller does not destructively recover a pending disposition after official proof changes", () => {
  const root = repo(); const workspace = controller.allocateManagedSubagentWorkspace(input(root, "proof-change"));
  writeFileSync(join(workspace.workspacePath, "src", "done.txt"), "done\n"); git(workspace.workspacePath, "add", "."); git(workspace.workspacePath, "commit", "-m", "done");
  const status = controller.statusManagedSubagentWorkspace({ originRoot: root, workspaceId: workspace.workspaceId, terminalProof: proof });
  const crashing = controller.createWorkspaceController({ fault: (point) => { if (point === "after-integrate") throw new Error("crash"); } });
  assert.throws(() => crashing.disposeManagedSubagentWorkspace({ originRoot: root, workspaceId: workspace.workspaceId, terminalProof: proof, disposition: "integrate", actionToken: status.actionToken }), /crash/);
  assert.throws(() => controller.statusManagedSubagentWorkspace({ originRoot: root, workspaceId: workspace.workspaceId, terminalProof: { ...proof, proofHash: "changed" } }), (error) => error?.code === "WORKSPACE_RECOVERY_REVIEW");
  assert.equal(existsSync(workspace.workspacePath), true);
  assert.equal(ledger.recoverPrivateWorkspaceLease({ originRoot: root, workspaceId: workspace.workspaceId }).record.pendingDisposition.disposition, "integrate");
});

test("controller injects allocation fault only after durable intent without exposing secrets", () => {
  const root = repo(); const crashing = controller.createWorkspaceController({ fault: (point) => { if (point === "before-managed-create") throw new Error("create crash"); } });
  let error; try { crashing.allocateManagedSubagentWorkspace(input(root, "allocate-fault")); } catch (caught) { error = caught; }
  assert.match(error?.message ?? "", /create crash/); assert.deepEqual(Object.keys(error.detail).sort(), ["originRoot", "state", "workspaceId"]);
  assert.equal(JSON.stringify(error.detail).match(/owner|token|pending|[a-f0-9]{40}/i), null);
  const record = ledger.recoverPrivateWorkspaceLease({ originRoot: root, workspaceId: "allocate-fault" }).record;
  assert.equal(record.state, "allocating"); assert.equal(existsSync(record.workspacePath), false);
  assert.throws(() => git(root, "show-ref", "--verify", "--quiet", record.branchRef));
});

test("controller integrates coding workspace and rejects generic integration", () => {
  const root = repo(); const coding = controller.allocateManagedSubagentWorkspace(input(root, "coding"));
  writeFileSync(join(coding.workspacePath, "src", "done.txt"), "done\n"); git(coding.workspacePath, "add", "."); git(coding.workspacePath, "commit", "-m", "done");
  const status = controller.statusManagedSubagentWorkspace({ originRoot: root, workspaceId: "coding", terminalProof: proof });
  assert.ok(status.allowedDispositions.includes("integrate"));
  assert.equal(controller.disposeManagedSubagentWorkspace({ originRoot: root, workspaceId: "coding", terminalProof: proof, disposition: "integrate", strategy: "cherry-pick", actionToken: status.actionToken }).state, "released");
  assert.equal(git(root, "show", "HEAD:src/done.txt"), "done");
  assert.equal(existsSync(coding.workspacePath), false);
  assert.equal(git(root, "show-ref", "--verify", "--quiet", coding.branchRef), "");
  const generic = controller.allocateManagedSubagentWorkspace(input(root, "generic", "generic"));
  const gs = controller.statusManagedSubagentWorkspace({ originRoot: root, workspaceId: "generic", terminalProof: proof });
  assert.equal(gs.allowedDispositions.includes("integrate"), false);
  assert.throws(() => controller.disposeManagedSubagentWorkspace({ originRoot: root, workspaceId: "generic", terminalProof: proof, disposition: "integrate", actionToken: gs.actionToken }), /allowed|forbidden/i);
});
