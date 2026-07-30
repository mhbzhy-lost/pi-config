import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createPlanHostRuntime } from "../scripts/lib/plan/plan-host-runtime.mjs";
import { createPlanLauncherExtension } from "../scripts/lib/plan/plan-launcher-extension.mjs";
import { parsePlanDocument } from "../scripts/lib/plan/plan-document.mjs";
import { compilePlanToIR } from "../scripts/lib/plan/ir/index.mjs";
import { createPlanRevisionStore } from "../scripts/lib/plan/plan-revision-store.mjs";

const execFile = promisify(execFileCallback);
const root = path.resolve(import.meta.dirname, "..");
const piBinary = process.env.PI_REAL_BIN;
const provider = path.join(root, "test/fixtures/deterministic-provider.mjs");
const extension = path.join(root, "test/fixtures/plan-harness/plan-runner-extension.ts");
const fixture = path.join(root, "test/fixtures/plan-harness/plans/amendment-success.md");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function git(cwd, ...args) { return (await execFile("git", args, { cwd })).stdout.trim(); }
async function assertRuntimeClean(cwd, allowedPrefixes) {
  assert.equal(await git(cwd, "status", "--porcelain", "--untracked-files=no"), "");
  const untracked = (await git(cwd, "ls-files", "--others", "--exclude-standard", "-z")).split("\0").filter(Boolean);
  const unexpected = untracked.filter((file) => !allowedPrefixes.some((prefix) => file.startsWith(prefix)));
  assert.equal(unexpected.length, 0, `unexpected untracked files: ${unexpected.join(", ")}`);
}
async function sessionEntries(sessionFile) {
  return (await readFile(sessionFile, "utf8")).split("\n").filter(Boolean).map(JSON.parse);
}
async function events(sessionFile) {
  return (await sessionEntries(sessionFile))
    .filter((entry) => entry.customType === "pi-plan-event-v1").map((entry) => entry.data);
}
function assistantToolCalls(entries) {
  return entries.flatMap((entry, entryIndex) => entry.message?.role === "assistant"
    ? (entry.message.content ?? []).flatMap((part) => part?.type === "toolCall"
      ? [{ entryIndex, name: part.name, arguments: part.arguments }]
      : [])
    : []);
}
async function waitFor(read, predicate, timeout = 120000) {
  const until = Date.now() + timeout;
  let value;
  while (Date.now() < until) {
    try { value = await read(); if (predicate(value)) return value; } catch (error) { if (error?.code !== "ENOENT") throw error; }
    await sleep(50);
  }
  throw new Error(`timed out: ${JSON.stringify(value)}`);
}
function revision2(parentPlanHash) {
  return `# Amendment crash recovery\n\n**Goal:** Recover the superseded Executor, record the clarified amended artifact, and perform the dependent repair without recreating the rejected decision.\n\n**Recovery instructions:** Task 2 must wait for Task 1's integrated receipt and repair the amended result as an independently accepted commit.\n\n## Execution Contract\n\n\`\`\`json\n{\n  "schemaVersion": "pi-plan.v3",\n  "revision": 2,\n  "parentPlanHash": "${parentPlanHash}",\n  "verification": [\n    {"id":"plan:amended","command":"test -f amended.txt","cwd":".","timeoutMs":120000},\n    {"id":"plan:repair","command":"test -f repair.txt && ! test -e decision.txt","cwd":".","timeoutMs":120000}\n  ],\n  "requiredGates": ["deterministic", "plan-audit", "external-review", "final-completeness"],\n  "resourceCapacities": {},\n  "executionDefaults": {"agent":"executor","risk":"normal","workflow":{"mode":"inherit-repository"},"timeoutMs":120000},\n  "taskExecution": {"task-1": {}, "task-2": {}},\n  "taskAcceptance": {\n    "task-1": {"strategy":"commands","commandIds":["plan:amended"]},\n    "task-2": {"strategy":"commands","commandIds":["plan:repair"]}\n  }\n}\n\`\`\`\n\n### Task 1: Record the clarified amended decision\n\n**Files:**\n- Create: \`amended.txt\`\n\nCreate amended.txt containing exactly \`amended\`, commit only that approved file, and leave unrelated files untouched.\n\n### Task 2: Repair the amended result\n\n**Deps:** Task 1\n\n**Files:**\n- Create: \`repair.txt\`\n\nAfter Task 1 is integrated, repair the amended result by creating repair.txt containing exactly \`repair\`, commit only that approved repair file, and leave decision.txt absent.\n`;
}

test("amendment crash restart Harness uses durable events for exact-once recovery", { timeout: 480000 }, async (t) => {
  assert.ok(piBinary, "PI_REAL_BIN is required");
  const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-plan-amendment-harness-"));
  const source = path.join(tmp, "source"); const superproject = path.join(tmp, "super"); const origin = path.join(superproject, "plugins/fixture");
  const planId = "amendment-crash"; const hostRunId = "amendment-durable-host"; const barrier = path.join(tmp, "barrier");
  let first; let second; let host; let passed = false;
  try {
    await mkdir(path.join(source, "docs"), { recursive: true }); await mkdir(path.join(source, ".pi/agents"), { recursive: true }); await mkdir(superproject, { recursive: true });
    await git(source, "init"); await git(source, "config", "user.email", "harness@example.com"); await git(source, "config", "user.name", "Harness");
    await writeFile(path.join(source, "README.md"), "base\n"); await copyFile(fixture, path.join(source, "docs/plan.md"));
    await writeFile(path.join(source, ".pi/agents/executor.md"), `---\nname: executor\ndescription: deterministic amendment executor\nmodel: fake/deterministic\nthinking: off\ntemperature: 0\ntools: bash,read,contact_supervisor\nsubagentOnlyExtensions: ${provider}\n---\nExecute only the approved task and commit the result.\n`);
    await git(source, "add", "."); await git(source, "commit", "-m", "harness base");
    await git(superproject, "init"); await git(superproject, "config", "user.email", "harness@example.com"); await git(superproject, "config", "user.name", "Harness"); await git(superproject, "-c", "protocol.file.allow=always", "submodule", "add", source, "plugins/fixture"); await git(superproject, "commit", "-am", "submodule");
    const baseCommit = await git(origin, "rev-parse", "HEAD");
    const r1 = await readFile(path.join(origin, "docs/plan.md")); const r2 = revision2(parsePlanDocument(r1.toString(), "plan.md").sha256);
    const revision2Ir = compilePlanToIR(parsePlanDocument(r2, "amendment-revision-2.md"));
    const tools = new Map(); const handlers = new Map(); const attention = [];
    const makeHost = (withBarrier) => createPlanHostRuntime({ model: "fake/deterministic", noExtensions: true, extraExtensions: [provider, path.join(root, "pi/npm/node_modules/pi-subagents")], promptMarker: "PI_PLAN_HARNESS_STANDALONE", id: () => hostRunId, env: { ...process.env, PI_PLAN_HARNESS_AMENDMENT: "1", PI_PLAN_HARNESS_AMENDMENT_SOURCE: r2, ...(withBarrier ? { PI_PLAN_HARNESS_SUPERSEDE_BARRIER: barrier } : {}) }, emitAttention: async (entry) => attention.push(entry) });
    host = makeHost(true);
    const pi = { registerTool: (tool) => tools.set(tool.name, tool), registerCommand() {}, on: (name, handler) => handlers.set(name, handler), appendEntry() {}, sendMessage() {} };
    createPlanLauncherExtension(pi, { originRoot: origin, stateRoot: origin, hostRuntime: host, planRunnerEntry: extension, attentionPollIntervalMs: 20, id: () => planId });
    const launch = await tools.get("plan_run").execute("launch", { planPath: path.join(origin, "docs/plan.md") }, undefined, undefined, {});
    assert.equal(launch.isError, undefined, launch.content[0].text); first = JSON.parse(launch.content[0].text);
    const statusPath = path.join(origin, "var/plan-runs", planId, "status.json");
    const pending = await waitFor(async () => JSON.parse(await readFile(statusPath, "utf8")), (status) => status.tasks?.[0]?.attempts?.[0]?.attention?.status === "pending");
    const old = pending.tasks[0].attempts[0];
    await waitFor(async () => attention.length, (count) => count === 1);
    const reply = await tools.get("plan_attention_reply").execute("reply", { planId, requestId: old.attention.requestId, expectedProjectionVersion: old.attention.projectionVersion, message: "APPROVED" }, undefined, undefined, {});
    assert.equal(reply.isError, undefined, reply.content[0].text);
    await waitFor(async () => access(path.join(barrier, "entered")).then(() => true), Boolean);
    const before = await events(first.sessionFile); const amended = before.filter((event) => event.type === "plan.amended");
    assert.equal(amended.length, 1); assert.equal(before.filter((event) => event.type === "attempt.superseded").length, 0); assert.equal(before.filter((event) => event.type === "attempt.workspace-released").length, 0);
    const oldDispatch = before.find((event) => event.type === "attempt.dispatch-requested");
    assert.ok(oldDispatch); assert.equal(oldDispatch.data.tool.task.includes("decision.txt"), true);
    const revisionStore = createPlanRevisionStore({ stateRoot: origin }); const stored1 = await revisionStore.readRevision(planId, 1); const currentAtBarrier = await revisionStore.readCurrent(planId);
    assert.ok(stored1 && currentAtBarrier); assert.equal(currentAtBarrier.revision, 1); assert.equal(currentAtBarrier.manifestSha256, stored1.manifestSha256); assert.equal(currentAtBarrier.manifest.irHash, stored1.manifest.irHash);
    await host.stop(first); await unlink(path.join(origin, "var/plan-runs", planId, "current.json"));
    host = makeHost(false);
    second = await host.spawnPlanRunner({ planId, revision: 2, manifestSha256: amended[0].data.manifestSha256, sourceBytesSha256: amended[0].data.sourceBytesSha256, planHash: amended[0].data.planHash, planIrHash: amended[0].data.irHash, baseCommit, originRoot: origin, stateRoot: origin, cwd: first.worktree, extension, runDir: first.runDir, statusPath: first.statusPath });
    for (const field of ["hostRunId", "sessionFile", "runDir", "worktree", "statusPath"]) assert.equal(second[field], first[field], `restart must preserve ${field}`);
    const final = await waitFor(async () => JSON.parse(await readFile(statusPath, "utf8")), (status) => status.lifecycle === "validated", 240000);
    const after = await events(second.sessionFile); assert.equal(new Set(after.map((event) => event.eventId)).size, after.length); assert.equal(after.filter((event) => event.type === "plan.amended").length, 1); assert.equal(after.filter((event) => event.type === "attempt.superseded").length, 1); assert.equal(after.filter((event) => event.type === "attempt.workspace-released").length, 3);
    const entries = await sessionEntries(second.sessionFile);
    const calls = assistantToolCalls(entries);
    const amendmentCalls = calls.filter((call) => call.name === "plan_amend"); const continueCalls = calls.filter((call) => call.name === "plan_continue"); const verifyCalls = calls.filter((call) => call.name === "plan_verify");
    assert.equal(amendmentCalls.length, 1); assert.deepEqual(continueCalls.map((call) => call.arguments.reason), ["harness", "amendment-recovery", "integrate", "integrate"]); assert.equal(verifyCalls.length, 1);
    const recoveryIndex = calls.findIndex((call) => call.name === "plan_continue" && call.arguments.reason === "amendment-recovery");
    assert.ok(recoveryIndex >= 0, "missing amendment-recovery plan_continue");
    const revision2Controls = calls.slice(recoveryIndex).filter((call) => ["plan_continue", "subagent_wait", "plan_status", "plan_verify"].includes(call.name));
    const revision2Statuses = revision2Controls.filter((call) => call.name === "plan_status"); const revision2Verifies = revision2Controls.filter((call) => call.name === "plan_verify");
    for (let index = 0; index < revision2Controls.length; index += 1) {
      const current = revision2Controls[index]; const next = revision2Controls[index + 1];
      if (["plan_continue", "subagent_wait"].includes(current.name)) {
        assert.ok(next, `expected fresh plan_status after ${current.name} at entry ${current.entryIndex}; next missing at entry end`);
        assert.equal(next.name, "plan_status", `expected fresh plan_status after ${current.name} at entry ${current.entryIndex}; next ${next.name} at entry ${next.entryIndex}`);
      }
    }
    assert.ok(revision2Statuses.length >= 4, "revision 2 must read plan_status at least four times"); assert.equal(revision2Verifies.length, 1);
    const lastContinue = revision2Controls.reduce((last, call, index) => call.name === "plan_continue" ? index : last, -1); const verifyControlIndex = revision2Controls.findIndex((call) => call.name === "plan_verify");
    assert.ok(lastContinue < verifyControlIndex, `plan_verify at entry ${revision2Controls[verifyControlIndex].entryIndex} must follow all plan_continue calls`);
    const dispatches = after.filter((event) => event.type === "attempt.dispatch-requested"); const oldAttemptId = oldDispatch.data.attemptId;
    assert.equal(dispatches.filter((event) => event.data.attemptId === oldAttemptId).length, 1);
    const task1Dispatch = dispatches.find((event) => event.data.attemptId !== oldAttemptId && event.data.taskId === "task-1"); const task2Dispatch = dispatches.find((event) => event.data.taskId === "task-2"); assert.ok(task1Dispatch && task2Dispatch);
    const oldBound = after.find((event) => event.type === "attempt.bound" && event.data.attemptId === oldAttemptId); assert.ok(oldBound);
    const superseded = after.find((event) => event.type === "attempt.superseded" && event.data.attemptId === oldAttemptId); assert.ok(superseded);
    assert.equal(superseded.data.evidence.kind, "terminal"); assert.equal(superseded.data.evidence.dispatchId, oldDispatch.data.dispatchId); assert.equal(superseded.data.evidence.runId, oldBound.data.runId); assert.equal(superseded.data.evidence.asyncDir, oldBound.data.asyncDir);
    const releases = after.filter((event) => event.type === "attempt.workspace-released");
    assert.equal(releases.filter((event) => event.data.attemptId === oldAttemptId && event.data.disposition === "superseded-preserve").length, 1);
    assert.equal(releases.filter((event) => event.data.attemptId === task1Dispatch.data.attemptId && event.data.disposition === "integrated-cleanup").length, 1);
    assert.equal(releases.filter((event) => event.data.attemptId === task2Dispatch.data.attemptId && event.data.disposition === "integrated-cleanup").length, 1);
    for (const dispatch of dispatches) assert.equal(releases.filter((event) => event.data.attemptId === dispatch.data.attemptId).length, 1, `workspace release count for ${dispatch.data.attemptId}`);
    const continuedIndex = entries.findIndex((entry) => entry.customType === "pi-plan-event-v1" && entry.data.type === "attempt.dispatch-requested" && entry.data.data.attemptId === task1Dispatch.data.attemptId);
    const verifyIndex = entries.findIndex((entry) => entry.message?.role === "assistant" && entry.message.content?.some((part) => part?.type === "toolCall" && part?.name === "plan_verify"));
    assert.ok(continuedIndex >= 0 && verifyIndex >= 0); assert.ok(continuedIndex < verifyIndex);
    const amendedIndex = after.findIndex((event) => event.type === "plan.amended"); const supersededIndex = after.findIndex((event) => event === superseded); const releasedIndex = after.findIndex((event) => event.data.attemptId === oldAttemptId && event.type === "attempt.workspace-released");
    assert.ok(amendedIndex < supersededIndex && supersededIndex < releasedIndex); assert.ok(after.findIndex((event) => event === task1Dispatch) > releasedIndex);
    const task1 = revision2Ir.nodes.find((entry) => entry.id === "task-1"); const task2 = revision2Ir.nodes.find((entry) => entry.id === "task-2"); assert.ok(task1 && task2);
    assert.equal(task1Dispatch.data.planIrHash, revision2Ir.hash); assert.equal(task1Dispatch.data.taskHash, task1.hashes.effective); assert.equal(task1Dispatch.data.schedulingHash, task1.hashes.scheduling);
    assert.equal(task2Dispatch.data.planIrHash, revision2Ir.hash); assert.equal(task2Dispatch.data.taskHash, task2.hashes.effective); assert.equal(task2Dispatch.data.schedulingHash, task2.hashes.scheduling);
    assert.notEqual(oldDispatch.data.taskHash, task1Dispatch.data.taskHash); assert.equal(dispatches.filter((event) => event.data.taskHash === oldDispatch.data.taskHash).length, 1);
    const revision2Plan = parsePlanDocument(r2, "amendment-revision-2.md");
    for (const [dispatch, task] of [[task1Dispatch, task1], [task2Dispatch, task2]]) {
      const prompt = dispatch.data.tool.task;
      assert.equal(prompt.includes(`Plan instructions:\n${revision2Plan.instructions}`), true);
      assert.equal(prompt.includes(`Task: ${task.id} ${task.title}`), true); assert.equal(prompt.includes(`Task body:\n${task.body}`), true);
      assert.equal(prompt.includes(`Execution: ${JSON.stringify(task.execution)}`), true); assert.equal(prompt.includes(`Acceptance: commands\n${JSON.stringify(task.acceptance)}`), true);
      assert.equal(prompt.includes(`Result contract: ${revision2Ir.executionPolicy.resultContract}`), true); assert.equal(prompt.includes(`Allowed paths: ${task.allowedPaths.join(", ")}`), true);
    }
    const stored2 = await revisionStore.readRevision(planId, 2); const current = await revisionStore.readCurrent(planId);
    assert.ok(stored1 && stored2 && current); assert.deepEqual(stored1.sourceBytes, r1); assert.deepEqual(stored2.sourceBytes, Buffer.from(r2)); assert.deepEqual((await revisionStore.readRevision(planId, 1)).sourceBytes, r1); assert.equal(current.revision, 2); assert.equal(current.manifestSha256, stored2.manifestSha256);
    const oldFinal = final.tasks[0].attempts.find((attempt) => attempt.attemptId === oldAttemptId); const task1Final = final.tasks.find((task) => task.taskId === "task-1").attempts.find((attempt) => attempt.attemptId === task1Dispatch.data.attemptId); const task2Final = final.tasks.find((task) => task.taskId === "task-2").attempts.find((attempt) => attempt.attemptId === task2Dispatch.data.attemptId);
    assert.equal(oldFinal.status, "superseded"); assert.equal(oldFinal.workspaceReleased, true); assert.equal(oldFinal.workspaceDisposition, "superseded-preserve"); await access(oldFinal.workspace.path); await assertRuntimeClean(oldFinal.workspace.path, [".pi-subagents/"]); assert.ok(["integrated", "accepted"].includes(task1Final.status)); assert.ok(["integrated", "accepted"].includes(task2Final.status));
    assert.equal(final.revision.number, 2); assert.equal(final.validatedHead, final.headCommit); assert.equal(await readFile(path.join(first.worktree, "amended.txt"), "utf8"), "amended\n"); assert.equal(await readFile(path.join(first.worktree, "repair.txt"), "utf8"), "repair\n"); await assert.rejects(access(path.join(first.worktree, "decision.txt"))); await assertRuntimeClean(first.worktree, [".pi-subagents/", "attempts/"]); assert.equal(await git(first.worktree, "rev-list", "--count", `${baseCommit}..HEAD`), "2");
    passed = true; t.diagnostic(`plan=${planId} amended=${amended[0].eventId} lifecycle=${final.lifecycle}`);
  } finally { try { await handlers?.get?.("session_shutdown")?.(); } catch {} try { if (host && (second ?? first)) await host.stop(second ?? first); } catch {} if (passed && process.env.PLAN_HARNESS_PRESERVE !== "1") await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); else t.diagnostic(`preserved=${tmp}`); }
});
