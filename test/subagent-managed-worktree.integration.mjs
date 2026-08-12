import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createWorkspaceController } from "../scripts/lib/subagent-dispatch/workspace-controller.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const observed = (hash = "proof") => ({ state: "observed", conflict: false, proofHash: hash });
const rejected = (fn, code) => assert.throws(fn, (error) => error?.code === code, code);

async function arena() {
  const root = await mkdtemp(join(tmpdir(), "subagent-managed-worktree-"));
  git(root, "init", "-q"); git(root, "config", "user.email", "test@example.invalid"); git(root, "config", "user.name", "Test");
  await writeFile(join(root, "allowed.txt"), "base\n");
  git(root, "add", "allowed.txt"); git(root, "commit", "-qm", "base");
  return root;
}
function input(root, id, kind = "coding") { return { originRoot: root, requestedCwd: root, workspaceId: id, kind, rootSessionId: "root", toolCallId: `call-${id}`, contractHash: "contract", ...(kind === "coding" ? { writePaths: ["allowed.txt"] } : {}) }; }
function ledger(root, id) { return JSON.parse(execFileSync("cat", [join(root, ".state/subagent-dispatch/workspaces", `${id}.json`)], { encoding: "utf8" })); }
function allocateAndBind(controller, root, id, kind = "coding") { const workspace = controller.allocateManagedSubagentWorkspace(input(root, id, kind)); controller.bindManagedSubagentWorkspaceRun({ originRoot: root, workspaceId: id }, { runId: `run-${id}`, asyncDir: join(root, `async-${id}`) }); return workspace; }
async function commit(workspace, text = "changed\n") { await writeFile(join(workspace.dispatchCwd, "allowed.txt"), text); git(workspace.dispatchCwd, "add", "allowed.txt"); git(workspace.dispatchCwd, "commit", "-qm", "child change"); }

test("managed coding real Git lifecycle allocates before child cwd, binds leaf, proves, integrates, and releases", async () => {
  const root = await arena(); const controller = createWorkspaceController();
  try {
    const workspace = allocateAndBind(controller, root, "coding-ok");
    assert.equal(existsSync(workspace.dispatchCwd), true);
    assert.equal(ledger(root, "coding-ok").runId, "run-coding-ok");
    await commit(workspace);
    const status = controller.statusManagedSubagentWorkspace({ originRoot: root, workspaceId: "coding-ok", terminalProof: observed("ok") });
    assert.deepEqual(status.allowedDispositions.sort(), ["discard", "integrate", "preserve"]);
    assert.equal(typeof status.actionToken, "string");
    controller.disposeManagedSubagentWorkspace({ originRoot: root, workspaceId: "coding-ok", terminalProof: observed("ok"), disposition: "integrate", strategy: "cherry-pick", actionToken: status.actionToken });
    assert.equal(git(root, "show", "HEAD:allowed.txt"), "changed");
    assert.equal(existsSync(workspace.workspacePath), false);
    assert.equal(ledger(root, "coding-ok").state, "released");
    assert.equal(git(root, "show", "refs/heads/subagent/coding-ok:allowed.txt"), "changed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("generic cannot integrate; preserve retains dirty workspace; observed discard releases without merge", async () => {
  const root = await arena(); const controller = createWorkspaceController();
  try {
    const generic = allocateAndBind(controller, root, "generic", "generic");
    const genericStatus = controller.statusManagedSubagentWorkspace({ originRoot: root, workspaceId: "generic", terminalProof: observed("g") });
    assert.equal(genericStatus.allowedDispositions.includes("integrate"), false);
    rejected(() => controller.disposeManagedSubagentWorkspace({ originRoot: root, workspaceId: "generic", terminalProof: observed("g"), disposition: "integrate", actionToken: genericStatus.actionToken }), "WORKSPACE_LEDGER_ACTION");
    await writeFile(join(generic.dispatchCwd, "dirty.txt"), "dirty\n");
    const preserve = controller.statusManagedSubagentWorkspace({ originRoot: root, workspaceId: "generic", terminalProof: { state: "pending" } });
    controller.disposeManagedSubagentWorkspace({ originRoot: root, workspaceId: "generic", terminalProof: { state: "pending" }, disposition: "preserve", actionToken: preserve.actionToken });
    assert.equal(existsSync(generic.workspacePath), true); assert.equal(ledger(root, "generic").state, "preserved");
    // A separate clean observed workspace is disposable and never changes origin.
    const discard = allocateAndBind(controller, root, "discard", "generic");
    const discardStatus = controller.statusManagedSubagentWorkspace({ originRoot: root, workspaceId: "discard", terminalProof: observed("d") });
    controller.disposeManagedSubagentWorkspace({ originRoot: root, workspaceId: "discard", terminalProof: observed("d"), disposition: "discard", actionToken: discardStatus.actionToken });
    assert.equal(existsSync(discard.workspacePath), false); assert.equal(git(root, "show", "HEAD:allowed.txt"), "base");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unknown proof, dirty source, crash recovery, reload, and replay all fail closed", async () => {
  const root = await arena(); const controller = createWorkspaceController();
  try {
    const workspace = allocateAndBind(controller, root, "closed"); await commit(workspace, "safe\n");
    const pending = controller.statusManagedSubagentWorkspace({ originRoot: root, workspaceId: "closed", terminalProof: { state: "pending" } });
    assert.deepEqual(pending.allowedDispositions, ["preserve"]);
    rejected(() => controller.disposeManagedSubagentWorkspace({ originRoot: root, workspaceId: "closed", terminalProof: { state: "pending" }, disposition: "discard", actionToken: pending.actionToken }), "WORKSPACE_LEDGER_ACTION");
    const good = controller.statusManagedSubagentWorkspace({ originRoot: root, workspaceId: "closed", terminalProof: observed("one") });
    rejected(() => controller.disposeManagedSubagentWorkspace({ originRoot: root, workspaceId: "closed", terminalProof: observed("two"), disposition: "integrate", actionToken: good.actionToken }), "WORKSPACE_LEDGER_ACTION");
    assert.equal(existsSync(workspace.workspacePath), true);
    const fresh = createWorkspaceController(); assert.equal(fresh.loadManagedSubagentWorkspace({ originRoot: root, workspaceId: "closed" }).state, "active");
    const status = fresh.statusManagedSubagentWorkspace({ originRoot: root, workspaceId: "closed", terminalProof: observed("one") });
    rejected(() => fresh.disposeManagedSubagentWorkspace({ originRoot: root, workspaceId: "closed", terminalProof: observed("one"), disposition: "integrate", actionToken: "replayed" }), "WORKSPACE_LEDGER_ACTION");
    fresh.disposeManagedSubagentWorkspace({ originRoot: root, workspaceId: "closed", terminalProof: observed("one"), disposition: "integrate", actionToken: status.actionToken });
    assert.throws(() => fresh.disposeManagedSubagentWorkspace({ originRoot: root, workspaceId: "closed", terminalProof: observed("one"), disposition: "integrate", actionToken: status.actionToken }));
    await writeFile(join(root, "origin-dirty.txt"), "x\n");
    rejected(() => fresh.allocateManagedSubagentWorkspace(input(root, "dirty")), "WORKTREE_SOURCE_DIRTY");
    git(root, "clean", "-fd");
    const crashing = createWorkspaceController({ fault(point) { if (point === "before-managed-create") throw new Error("crash"); } });
    assert.throws(() => crashing.allocateManagedSubagentWorkspace(input(root, "crash")));
    assert.equal(ledger(root, "crash").state, "allocating");
  } finally { await rm(root, { recursive: true, force: true }); }
});
