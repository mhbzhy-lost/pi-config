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
  const commands = new Map();
  const tools = new Map();
  const entries = [];
  const events = new Map();
  const messages = [];
  const pi = {
    registerCommand: (name, command) => commands.set(name, command),
    registerTool: (tool) => tools.set(tool.name, tool),
    on: (name, handler) => events.set(name, handler),
    appendEntry: (customType, data) => entries.push({ customType, data }),
    sendMessage: async (message) => messages.push(message),
  };
  createPlanLauncherExtension(pi, options);
  return { commands, tools, entries, events, messages };
}

function handle(root, overrides = {}) {
  return {
    schemaVersion: "pi-plan-handle.v4",
    planId: "plan-one",
    revision: 1,
    manifestSha256: hashes.manifestSha256,
    sourceBytesSha256: hashes.sourceBytesSha256,
    planHash: hashes.planHash,
    planIrHash: hashes.irHash,
    rootSessionId: "root-session-1",
    planRunnerRunId: "run-1",
    asyncDir: "/async/1",
    worktree: path.join(root, "var", "plan-worktrees", "plan-one"),
    baseCommit: "e".repeat(40),
    ...overrides,
  };
}

async function writeProjection(root, projection) {
  const dir = path.join(root, "var", "plan-runs", "plan-one");
  await (await import("node:fs/promises")).mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "status.json"), JSON.stringify(projection));
  return dir;
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
    assert.deepEqual(calls[1][1], { callerRunId: "plan-runner-run-1", planId: "plan-one", cwd: handle.worktree, originRoot: root, stateRoot: root, role: "plan-runner" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Root B rejects management of Root A's Plan Runner without Root RPC", async () => {
  const { root } = await fixture(); const calls = [];
  try {
    const handle = { schemaVersion: "pi-plan-handle.v4", planId: "plan-one", revision: 1, manifestSha256: hashes.manifestSha256, sourceBytesSha256: hashes.sourceBytesSha256, planHash: hashes.planHash, planIrHash: hashes.irHash, rootSessionId: "root-session-A", planRunnerRunId: "run-A", asyncDir: "/async/A", worktree: path.join(root, "var", "plan-worktrees", "plan-one"), baseCommit: "e".repeat(40) };
    const { commands, tools } = setup(options(root, calls, { rootSessionId: "root-session-B", findHandle: async () => handle }));
    for (const name of ["plan-status", "plan-cancel", "plan-open", "plan-pause", "plan-recover"]) await assert.rejects(commands.get(name).handler("plan-one", {}), /belongs to another Root session/);
    const reply = await tools.get("plan_attention_reply").execute("id", { planId: "plan-one", requestId: "request-1", expectedProjectionVersion: 1, message: "Proceed." }, undefined, undefined, {});
    assert.equal(reply.isError, true);
    assert.deepEqual(calls, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("incomplete spawn binding stops any bound run and rolls back", async () => {
  const { root, planPath } = await fixture(); const calls = [];
  try { const { commands } = setup(options(root, calls, { spawnReply: { details: { runId: "run-1" } } })); await assert.rejects(commands.get("plan-run").handler(planPath, { mode: "tui", hasUI: true, ui: { confirm: async () => true } }), /missing runId or asyncDir/); assert.deepEqual(calls.map(([name]) => name), ["spawn", "stop", "rollback"]); assert.deepEqual(calls[1][1], { runId: "run-1" }); } finally { await rm(root, { recursive: true, force: true }); }
});

test("grant failure stops the spawned runner and rolls back", async () => {
  const { root, planPath } = await fixture(); const calls = [];
  try { const { commands } = setup(options(root, calls, { grantError: new Error("grant denied") })); await assert.rejects(commands.get("plan-run").handler(planPath, { mode: "tui", hasUI: true, ui: { confirm: async () => true } }), /grant denied/); assert.deepEqual(calls.map(([name]) => name), ["spawn", "grant", "stop", "rollback"]); } finally { await rm(root, { recursive: true, force: true }); }
});

test("management uses Root RPC and cancellation records intent first", async () => {
  const { root } = await fixture(); const calls = []; const handle = { schemaVersion: "pi-plan-handle.v4", planId: "plan-one", revision: 1, manifestSha256: hashes.manifestSha256, sourceBytesSha256: hashes.sourceBytesSha256, planHash: hashes.planHash, planIrHash: hashes.irHash, rootSessionId: "root-session-1", planRunnerRunId: "run-1", asyncDir: "/async/1", worktree: path.join(root, "var", "plan-worktrees", "plan-one"), baseCommit: "e".repeat(40) };
  try { const { commands } = setup(options(root, calls, { findHandle: async () => handle, recordCancelIntent: async () => calls.push(["intent"]) })); await commands.get("plan-status").handler("plan-one", {}); await commands.get("plan-pause").handler("plan-one", {}); await commands.get("plan-open").handler("plan-one", {}); await commands.get("plan-recover").handler("plan-one", {}); await commands.get("plan-cancel").handler("plan-one", {}); assert.deepEqual(calls.map(([name]) => name), ["status", "interrupt", "status", "status", "intent", "stop"]); assert.deepEqual(calls.at(-1)[1], { runId: "run-1", dir: "/async/1" }); } finally { await rm(root, { recursive: true, force: true }); }
});

test("plan runner entry remains child-safe and uses the Root-owned adapter", async () => {
  const source = await readFile(new URL("../pi/child-extensions/plan-runner.ts", import.meta.url), "utf8");
  assert.match(source, /installRootOwnedSubagent/); assert.match(source, /installRootSessionOwnerLifecycle/); assert.match(source, /createPlanCapsuleExtension/);
  assert.doesNotMatch(source, /PI_SUBAGENT_CHILD.*return/); assert.doesNotMatch(source, /createSubagentsRpcClient|spawnPiAgent|createMonitor/);
});

test("plan-status returns both Root RPC state and durable Plan projection", async () => {
  const { root } = await fixture(); const calls = [];
  const handle = { schemaVersion: "pi-plan-handle.v4", planId: "plan-one", revision: 1, manifestSha256: hashes.manifestSha256, sourceBytesSha256: hashes.sourceBytesSha256, planHash: hashes.planHash, planIrHash: hashes.irHash, rootSessionId: "root-session-1", planRunnerRunId: "run-1", asyncDir: "/async/1", worktree: path.join(root, "var", "plan-worktrees", "plan-one"), baseCommit: "e".repeat(40) };
  try {
    const dir = path.join(root, "var", "plan-runs", "plan-one");
    await (await import("node:fs/promises")).mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "status.json"), JSON.stringify({ planId: "plan-one", lifecycle: "running", tasks: [] }));
    const { commands } = setup(options(root, calls, { findHandle: async () => handle }));
    assert.deepEqual(await commands.get("plan-status").handler("plan-one", {}), { runner: { state: "running" }, plan: { planId: "plan-one", lifecycle: "running", tasks: [] } });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("noninteractive malformed inputs do not prepare, create a workspace, or spawn", async () => {
  const { root } = await fixture(); const calls = []; let prepared = 0; let workspaces = 0;
  try {
    const { commands } = setup(options(root, calls, { revisionStore: { async prepareRevision() { prepared++; throw new Error("must not prepare"); } }, createWorkspace: async () => { workspaces++; throw new Error("must not create"); } }));
    for (const input of ["", "not json", "null", "[]", "{}", '{"planPath":""}', '{"planPath":"x"}', '{"planPath":"x","allowPlanCommits":false}']) await assert.rejects(commands.get("plan-run").handler(input, {}), /allowPlanCommits/);
    assert.deepEqual({ prepared, workspaces, spawns: calls.filter(([name]) => name === "spawn").length }, { prepared: 0, workspaces: 0, spawns: 0 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("plan_run tool launches through the command launch path", async () => {
  const { root, planPath } = await fixture(); const calls = [];
  try { const { tools } = setup(options(root, calls)); const result = await tools.get("plan_run").execute("id", { planPath }, undefined, undefined, {}); assert.equal(result.isError, undefined); assert.equal(calls.filter(([name]) => name === "spawn").length, 1); } finally { await rm(root, { recursive: true, force: true }); }
});

test("invalid current Root handle fails closed before Root RPC", async () => {
  const { root } = await fixture(); const calls = [];
  try { const { commands } = setup(options(root, calls, { findHandle: async () => ({ planId: "plan-one" }) })); await assert.rejects(commands.get("plan-status").handler("plan-one", {}), /pi-plan-handle.v4/); assert.deepEqual(calls, []); } finally { await rm(root, { recursive: true, force: true }); }
});

test("non-Error tool failures are stringified", async () => {
  const { root, planPath } = await fixture(); const calls = [];
  try { const { tools } = setup(options(root, calls, { createWorkspace: async () => { throw "workspace unavailable"; } })); const result = await tools.get("plan_run").execute("id", { planPath }, undefined, undefined, {}); assert.equal(result.isError, true); assert.equal(result.content[0].text, "workspace unavailable"); } finally { await rm(root, { recursive: true, force: true }); }
});

test("launch fence rejects concurrent same planId requests", async () => {
  const { root, planPath } = await fixture(); const calls = []; let rejectSpawn;
  const pendingSpawn = new Promise((_, reject) => { rejectSpawn = reject; });
  try {
    const delayedBroker = broker(calls);
    delayedBroker.upstream.spawn = async (input) => { calls.push(["spawn", input]); return pendingSpawn; };
    const { commands } = setup(options(root, calls, { rootBroker: delayedBroker }));
    const first = commands.get("plan-run").handler(planPath, { mode: "tui", hasUI: true, ui: { confirm: async () => true } });
    while (!calls.some(([name]) => name === "spawn")) await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(commands.get("plan-run").handler(planPath, { mode: "tui", hasUI: true, ui: { confirm: async () => true } }), /already in progress/);
    const firstFailure = assert.rejects(first, /spawn failed/);
    rejectSpawn(new Error("spawn failed")); await firstFailure;
    assert.equal(calls.filter(([name]) => name === "spawn").length, 1);
    delayedBroker.upstream.spawn = async (input) => {
      calls.push(["spawn", input]);
      return { details: { runId: "run-after-retry", asyncDir: "/async/retry" } };
    };
    await commands.get("plan-run").handler(planPath, { mode: "tui", hasUI: true, ui: { confirm: async () => true } });
    assert.equal(calls.filter(([name]) => name === "spawn").length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("plan-status forwards pending Attention using the Host event contract once", async () => {
  const { root } = await fixture();
  const calls = [];
  try {
    const bodySha256 = "f".repeat(64);
    const dir = await writeProjection(root, { planId: "plan-one", lifecycle: "running", tasks: [{ attempts: [{ status: "waiting-attention", attention: { status: "pending", requestId: "request-1", projectionVersion: 4, evidence: { bodyPath: "attention/request-1.md", bodySha256 } } }] }] });
    await (await import("node:fs/promises")).mkdir(path.join(dir, "attention"), { recursive: true });
    await writeFile(path.join(dir, "attention", "request-1.md"), "Choose the deployment target.");
    const { commands, messages } = setup(options(root, calls, { findHandle: async () => handle(root) }));
    await commands.get("plan-status").handler("plan-one", {});
    await commands.get("plan-status").handler("plan-one", {});
    assert.deepEqual(messages, [{ customType: "pi-plan-attention-v1", content: [`Plan plan-one requires user input for Attention request-1.`, `Read the private Attention body with the read tool at ${path.join(root, "var", "plan-runs", "plan-one", "attention", "request-1.md")}, summarize it to the user, and wait for an explicit decision.`, "After the user decides, call plan_attention_reply with planId=plan-one, requestId=request-1, and expectedProjectionVersion=4.", "Do not infer or submit a decision on the user's behalf."].join("\n"), details: { planId: "plan-one", requestId: "request-1", expectedProjectionVersion: 4, bodyPath: "attention/request-1.md", bodySha256 } }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("plan_attention_reply fences projection and is idempotent", async () => {
  const { root } = await fixture(); const calls = []; const writes = [];
  try {
    await writeProjection(root, { planId: "plan-one", tasks: [{ taskId: "task-1", attempts: [{ attemptId: "attempt-1", runId: "run-1", status: "waiting-attention", attention: { status: "pending", requestId: "request-1", projectionVersion: 4 } }] }] });
    const planControl = { readAttentionReplies: async () => writes, writeAttentionReply: async (reply) => writes.push(reply) };
    const { tools } = setup(options(root, calls, { findHandle: async () => handle(root), planControl }));
    const reply = { planId: "plan-one", requestId: "request-1", expectedProjectionVersion: 4, message: "Proceed." };
    assert.equal((await tools.get("plan_attention_reply").execute("id", reply, undefined, undefined, {})).isError, undefined);
    assert.equal((await tools.get("plan_attention_reply").execute("id", reply, undefined, undefined, {})).isError, undefined);
    assert.equal(writes.length, 1);
    assert.equal((await tools.get("plan_attention_reply").execute("id", { ...reply, expectedProjectionVersion: 3 }, undefined, undefined, {})).isError, true);
    assert.equal((await tools.get("plan_attention_reply").execute("id", { ...reply, message: "Stop." }, undefined, undefined, {})).isError, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("plan-status fails closed when a pending Attention body is missing", async () => {
  const { root } = await fixture(); const calls = [];
  try {
    await writeProjection(root, { planId: "plan-one", tasks: [{ attempts: [{ status: "waiting-attention", attention: { status: "pending", requestId: "request-1", projectionVersion: 4, evidence: { bodyPath: "attention/request-1.md", bodySha256: "f".repeat(64) } } }] }] });
    const { commands } = setup(options(root, calls, { findHandle: async () => handle(root) }));
    await assert.rejects(commands.get("plan-status").handler("plan-one", {}), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("plan-status rejects malformed pending Attention evidence", async () => {
  const { root } = await fixture(); const calls = [];
  try {
    await writeProjection(root, { planId: "plan-one", tasks: [{ attempts: [{ status: "waiting-attention", attention: { status: "pending", requestId: "request-1", projectionVersion: 4, evidence: { bodyPath: "attention/other.md", bodySha256: "not-a-hash" } } }] }] });
    const { commands } = setup(options(root, calls, { findHandle: async () => handle(root) }));
    await assert.rejects(commands.get("plan-status").handler("plan-one", {}), /evidence is invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("launch fails closed when findHandle throws a same-worded ordinary Error", async () => {
  const { root, planPath } = await fixture(); const calls = [];
  try {
    const { commands } = setup(options(root, calls, { findHandle: async () => { throw new Error("Unknown plan: plan-one"); } }));
    await assert.rejects(commands.get("plan-run").handler(planPath, { mode: "tui", hasUI: true, ui: { confirm: async () => true } }), /Unknown plan/);
    assert.equal(calls.some(([name]) => name === "spawn"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("duplicate pending Attention requestId rejects reply without a write", async () => {
  const { root } = await fixture(); const calls = []; const writes = [];
  try {
    await writeProjection(root, { planId: "plan-one", tasks: [{ taskId: "a", attempts: [{ attemptId: "a", runId: "run-a", status: "waiting-attention", attention: { status: "pending", requestId: "request-1", projectionVersion: 4 } }] }, { taskId: "b", attempts: [{ attemptId: "b", runId: "run-b", status: "waiting-attention", attention: { status: "pending", requestId: "request-1", projectionVersion: 4 } }] }] });
    const { tools } = setup(options(root, calls, { findHandle: async () => handle(root), planControl: { readAttentionReplies: async () => writes, writeAttentionReply: async (reply) => writes.push(reply) } }));
    const result = await tools.get("plan_attention_reply").execute("id", { planId: "plan-one", requestId: "request-1", expectedProjectionVersion: 4, message: "Proceed." }, undefined, undefined, {});
    assert.equal(result.isError, true); assert.deepEqual(writes, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("current Root rejects an untrusted worktree before RPC or attention writes", async () => {
  const { root } = await fixture(); const calls = []; const writes = [];
  try {
    await writeProjection(root, { planId: "plan-one", tasks: [{ taskId: "task-1", attempts: [{ attemptId: "attempt-1", runId: "run-1", status: "waiting-attention", attention: { status: "pending", requestId: "request-1", projectionVersion: 4 } }] }] });
    const bad = handle(root, { worktree: path.join(root, "foreign") });
    const { commands, tools } = setup(options(root, calls, { findHandle: async () => bad, planControl: { readAttentionReplies: async () => writes, writeAttentionReply: async (reply) => writes.push(reply) } }));
    await assert.rejects(commands.get("plan-status").handler("plan-one", {}), /worktree is untrusted/);
    const result = await tools.get("plan_attention_reply").execute("id", { planId: "plan-one", requestId: "request-1", expectedProjectionVersion: 4, message: "Proceed." }, undefined, undefined, {});
    assert.equal(result.isError, true); assert.deepEqual(calls, []); assert.deepEqual(writes, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("terminal poller cancels once without stopping the runner", async () => {
  const { root, planPath } = await fixture(); const calls = []; const cancelled = []; let poll;
  try {
    const terminalBroker = broker(calls); terminalBroker.upstream.status = async (input) => { calls.push(["status", input]); return { state: "failed" }; };
    const { commands } = setup(options(root, calls, { rootBroker: terminalBroker, schedule: (callback) => { poll = callback; return "timer-1"; }, cancelSchedule: (timer) => cancelled.push(timer) }));
    await commands.get("plan-run").handler(planPath, { mode: "tui", hasUI: true, ui: { confirm: async () => true } });
    await writeProjection(root, { planId: "plan-one", lifecycle: "running", tasks: [] });
    await poll(); await poll();
    assert.deepEqual(cancelled, ["timer-1"]); assert.equal(calls.some(([name]) => name === "stop"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("session shutdown cancels Attention pollers without stopping Plan Runners", async () => {
  const { root, planPath } = await fixture(); const calls = []; const cancelled = [];
  try {
    const { commands, events } = setup(options(root, calls, { schedule: () => "timer-1", cancelSchedule: (timer) => cancelled.push(timer) }));
    await commands.get("plan-run").handler(planPath, { mode: "tui", hasUI: true, ui: { confirm: async () => true } });
    await events.get("session_shutdown")();
    assert.deepEqual(cancelled, ["timer-1"]);
    assert.equal(calls.some(([name]) => name === "stop"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
