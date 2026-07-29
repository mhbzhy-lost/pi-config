import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPlanLauncherExtension } from "../scripts/lib/plan/plan-launcher-extension.mjs";

const planSource = "# Approved plan\n\n### Task 1: Ship it\n";
const hashes = { manifestSha256: "a".repeat(64), sourceBytesSha256: "b".repeat(64), planHash: "c".repeat(64), irHash: "d".repeat(64) };

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-plan-launcher-v4-"));
  const planPath = path.join(root, "approved-plan.md");
  await writeFile(planPath, planSource);
  return { root, planPath };
}

function setup(options = {}) {
  const commands = new Map(); const tools = new Map(); const entries = [];
  const pi = { registerCommand: (name, command) => commands.set(name, command), registerTool: (tool) => tools.set(tool.name, tool), on() {}, appendEntry: (customType, data) => entries.push({ customType, data }) };
  createPlanLauncherExtension(pi, options);
  return { commands, tools, entries };
}

function broker(calls, overrides = {}) {
  return { rootSessionId: "root-session-1", upstream: {
    async spawn(input) { calls.push(["spawn", input]); return overrides.spawnReply ?? { details: { runId: "plan-runner-run-1", asyncDir: "/async/plan-runner-run-1" } }; },
    async status(input) { calls.push(["status", input]); return { state: "running" }; },
    async interrupt(input) { calls.push(["interrupt", input]); }, async stop(input) { calls.push(["stop", input]); },
  }, async grantCaller(input) { calls.push(["grant", input]); if (overrides.grantError) throw overrides.grantError; }, ...overrides };
}

function options(root, calls, extra = {}) {
  return { originRoot: root, stateRoot: root, rootBroker: broker(calls, extra), id: () => "plan-one", readBaseCommit: async () => "e".repeat(40), createWorkspace: async ({ planId }) => ({ planId, workspacePath: path.join(root, "var", "plan-worktrees", planId), baseCommit: "e".repeat(40) }), rollbackWorkspace: async () => calls.push(["rollback"]), revisionStore: { async prepareRevision() { return { revision: 1, manifestSha256: hashes.manifestSha256, manifest: { sourceBytesSha256: hashes.sourceBytesSha256, planHash: hashes.planHash, irHash: hashes.irHash } }; } }, ...extra };
}

test("plan-run launches a session-local Root Plan Runner and never persists a handle", async () => {
  const { root, planPath } = await fixture(); const calls = [];
  try {
    const { commands, entries } = setup(options(root, calls));
    const handle = await commands.get("plan-run").handler(planPath, { mode: "tui", hasUI: true, ui: { confirm: async () => true } });
    assert.deepEqual(handle, { schemaVersion: "pi-plan-handle.v4", planId: "plan-one", revision: 1, manifestSha256: hashes.manifestSha256, sourceBytesSha256: hashes.sourceBytesSha256, planHash: hashes.planHash, planIrHash: hashes.irHash, rootSessionId: "root-session-1", planRunnerRunId: "plan-runner-run-1", asyncDir: "/async/plan-runner-run-1", worktree: path.join(root, "var", "plan-worktrees", "plan-one"), baseCommit: "e".repeat(40) });
    assert.equal(entries[0].customType, "pi-plan-launch-handle-v4");
    await assert.rejects(stat(path.join(root, "var", "plan-runs", "plan-one", "host-handle.json")));
    assert.deepEqual(calls.map(([name]) => name), ["spawn", "grant"]);
    const spawn = calls[0][1];
    assert.deepEqual(Object.keys(spawn).sort(), ["agent", "artifacts", "async", "clarify", "context", "cwd", "output", "task", "timeoutMs", "title"]);
    assert.equal(spawn.agent, "plan-runner"); assert.equal(spawn.title, "Plan plan-one"); assert.equal(spawn.cwd, handle.worktree); assert.equal(spawn.context, "fresh"); assert.equal(spawn.async, true); assert.equal(spawn.clarify, false); assert.equal(spawn.artifacts, true); assert.equal(spawn.output, false); assert.ok(Number.isInteger(spawn.timeoutMs) && spawn.timeoutMs > 0);
    assert.deepEqual(calls[1][1], { callerRunId: "plan-runner-run-1", planId: "plan-one", cwd: handle.worktree, role: "plan-runner" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Root B rejects management of Root A's Plan Runner without Root RPC", async () => {
  const { root } = await fixture(); const calls = [];
  try {
    const handle = { schemaVersion: "pi-plan-handle.v4", planId: "plan-one", revision: 1, manifestSha256: hashes.manifestSha256, sourceBytesSha256: hashes.sourceBytesSha256, planHash: hashes.planHash, planIrHash: hashes.irHash, rootSessionId: "root-session-A", planRunnerRunId: "run-A", asyncDir: "/async/A", worktree: "/worktree", baseCommit: "e".repeat(40) };
    const { commands } = setup(options(root, calls, { rootSessionId: "root-session-B", findHandle: async () => handle }));
    for (const name of ["plan-status", "plan-cancel", "plan-open", "plan-pause", "plan-recover"]) await assert.rejects(commands.get(name).handler("plan-one", {}), /belongs to another Root session/);
    assert.deepEqual(calls, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("incomplete spawn binding stops any bound run and rolls back", async () => {
  const { root, planPath } = await fixture(); const calls = [];
  try { const { commands } = setup(options(root, calls, { spawnReply: { details: { runId: "run-1" } } })); await assert.rejects(commands.get("plan-run").handler(planPath, { mode: "tui", hasUI: true, ui: { confirm: async () => true } }), /missing runId or asyncDir/); assert.deepEqual(calls.map(([name]) => name), ["spawn", "stop", "rollback"]); } finally { await rm(root, { recursive: true, force: true }); }
});

test("grant failure stops the spawned runner and rolls back", async () => {
  const { root, planPath } = await fixture(); const calls = [];
  try { const { commands } = setup(options(root, calls, { grantError: new Error("grant denied") })); await assert.rejects(commands.get("plan-run").handler(planPath, { mode: "tui", hasUI: true, ui: { confirm: async () => true } }), /grant denied/); assert.deepEqual(calls.map(([name]) => name), ["spawn", "grant", "stop", "rollback"]); } finally { await rm(root, { recursive: true, force: true }); }
});

test("management uses Root RPC and cancellation records intent first", async () => {
  const { root } = await fixture(); const calls = []; const handle = { schemaVersion: "pi-plan-handle.v4", planId: "plan-one", revision: 1, manifestSha256: hashes.manifestSha256, sourceBytesSha256: hashes.sourceBytesSha256, planHash: hashes.planHash, planIrHash: hashes.irHash, rootSessionId: "root-session-1", planRunnerRunId: "run-1", asyncDir: "/async/1", worktree: "/worktree", baseCommit: "e".repeat(40) };
  try { const { commands } = setup(options(root, calls, { findHandle: async () => handle, recordCancelIntent: async () => calls.push(["intent"]) })); await commands.get("plan-status").handler("plan-one", {}); await commands.get("plan-pause").handler("plan-one", {}); await commands.get("plan-open").handler("plan-one", {}); await commands.get("plan-recover").handler("plan-one", {}); await commands.get("plan-cancel").handler("plan-one", {}); assert.deepEqual(calls.map(([name]) => name), ["status", "interrupt", "status", "status", "intent", "stop"]); assert.deepEqual(calls.at(-1)[1], { runId: "run-1", dir: "/async/1" }); } finally { await rm(root, { recursive: true, force: true }); }
});

test("plan runner entry remains child-safe and uses the Root-owned adapter", async () => {
  const source = await readFile(new URL("../pi/child-extensions/plan-runner.ts", import.meta.url), "utf8");
  assert.match(source, /installRootOwnedSubagent/); assert.match(source, /installRootSessionOwnerLifecycle/); assert.match(source, /createPlanCapsuleExtension/);
  assert.doesNotMatch(source, /PI_SUBAGENT_CHILD.*return/); assert.doesNotMatch(source, /createSubagentsRpcClient|spawnPiAgent|createMonitor/);
});
