import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const DISPATCH_HEAD = "1".repeat(40);
const RUNTIME_HEAD = "2".repeat(40);
const EXECUTOR_HEAD = "3".repeat(40);
const terminal = { status: "passed", code: 0, signal: null, output: "terminal output", outputBytes: 15, truncated: false, terminal: true, pid: 17, pidBirthIdentity: "a".repeat(64), processGroupTerminalProof: "b".repeat(64), workspaceClean: true };

async function host(options = {}) {
  const { createProductionGoalRuntimeHost } = await import("../scripts/lib/goal-engine/production-runtime-host.mjs");
  return createProductionGoalRuntimeHost({ registerTool() {}, on() {} }, options);
}
function workspaceRequest(overrides = {}) {
  return { stateRoot: "/state", goalId: "goal", taskId: "task", attempt: 1, runId: "run", leaseId: hash("owner-token"), workspacePath: "/workspace", headAtDispatch: DISPATCH_HEAD, baseHead: RUNTIME_HEAD, executionRevision: 1, contractHash: hash("contract"), sessionId: "session", ...overrides };
}
function lease(baseCommit = DISPATCH_HEAD) { return { goalId: "goal", taskId: "task", attempt: 1, stateRoot: "/state", path: "/workspace", baseCommit, ownerToken: "owner-token" }; }
const inspection = { headCommit: EXECUTOR_HEAD, path: "/workspace", clean: true };

// RED: artifact input is the durable TERMINAL_KEYS result, not a lossy four-field projection.
test("artifactRefForRun accepts exactly the real managed 11-field terminal and materializes only output", async () => {
  const root = mkdtempSync(join(tmpdir(), "goal-artifact-full-terminal-"));
  const result = await (await host()).artifactRefForRun({ stateRoot: root, goalId: "goal", runId: "run", managedTerminal: terminal });
  assert.equal(readFileSync(result.path, "utf8"), terminal.output);
  for (const field of Object.keys(terminal)) assert.equal(field in result, false, field);
  const h = await host();
  for (const malformed of [Object.fromEntries(Object.entries(terminal).filter(([key]) => key !== "workspaceClean")), { ...terminal, extra: true }]) await assert.rejects(() => h.artifactRefForRun({ stateRoot: root, goalId: "goal", runId: "run", managedTerminal: malformed }));
});

test("artifactRefForRun rejects a symlink stateRoot before writing through it", async () => {
  const parent = mkdtempSync(join(tmpdir(), "goal-artifact-root-link-"));
  const backing = join(parent, "backing"), linked = join(parent, "linked"); mkdirSync(backing); symlinkSync(backing, linked);
  await assert.rejects(() => host().then((value) => value.artifactRefForRun({ stateRoot: linked, goalId: "goal", runId: "run", managedTerminal: terminal })));
  assert.equal(existsSync(join(backing, "artifacts", hash(terminal.output))), false);
});

test("artifactRefForRun rejects symlinked artifact directories and target links", async () => {
  const root = mkdtempSync(join(tmpdir(), "goal-artifact-linked-target-")), outside = mkdtempSync(join(tmpdir(), "goal-artifact-outside-")), target = join(root, "artifacts", hash(terminal.output));
  symlinkSync(outside, join(root, "artifacts"));
  await assert.rejects(() => host().then((value) => value.artifactRefForRun({ stateRoot: root, goalId: "goal", runId: "run", managedTerminal: terminal })));
  rmSync(join(root, "artifacts")); mkdirSync(join(root, "artifacts")); chmodSync(join(root, "artifacts"), 0o700);
  symlinkSync(join(outside, "target"), target);
  await assert.rejects(() => host().then((value) => value.artifactRefForRun({ stateRoot: root, goalId: "goal", runId: "run", managedTerminal: terminal })));
  rmSync(target); writeFileSync(join(root, "source"), terminal.output, { mode: 0o600 }); linkSync(join(root, "source"), target);
  await assert.rejects(() => host().then((value) => value.artifactRefForRun({ stateRoot: root, goalId: "goal", runId: "run", managedTerminal: terminal })));
});

test("quarantineWorkspace binds the lease baseCommit to headAtDispatch, not runtime baseHead", async () => {
  let releases = 0;
  const value = await (await host({ loadExecutorWorkspaceLease() { return lease(DISPATCH_HEAD); }, inspectExecutorWorkspace() { return inspection; }, releaseExecutorWorkspace() { releases++; return { preserved: true, disposition: "preserved" }; } })).quarantineWorkspace(workspaceRequest());
  assert.equal(value.disposition, "preserved"); assert.equal(releases, 1);
});

test("quarantineWorkspace rejects non-40hex headAtDispatch before touching a lease", async () => {
  let loads = 0;
  const h = await host({ loadExecutorWorkspaceLease() { loads++; return lease(); }, inspectExecutorWorkspace() { return inspection; } });
  await assert.rejects(() => h.quarantineWorkspace(workspaceRequest({ headAtDispatch: "drift" })));
  assert.equal(loads, 0);
});

test("quarantineResource exactly validates every owner request field before loading a lease", async () => {
  const request = { stateRoot: "/state", goalId: "goal", ownerKind: "executor", ownerId: "run", taskId: "task", attempt: 1, leaseId: hash("owner-token"), executionRevision: 1, contractHash: hash("contract"), sessionId: "session" };
  for (const bad of [{ ...request, stateRoot: "relative" }, { ...request, goalId: "" }, { ...request, ownerId: "" }, { ...request, taskId: "" }, { ...request, sessionId: "" }, { ...request, attempt: 0 }, { ...request, executionRevision: 0 }, { ...request, leaseId: "x".repeat(64) }, { ...request, contractHash: "x".repeat(64) }, { ...request, extra: true }]) {
    let loads = 0; const h = await host({ loadExecutorWorkspaceLease() { loads++; return lease(RUNTIME_HEAD); } });
    await assert.rejects(() => h.quarantineResource(bad)); assert.equal(loads, 0);
  }
});
