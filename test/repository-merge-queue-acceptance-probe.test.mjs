import assert from "node:assert/strict";
import { access, mkdtemp, readFile, realpath, writeFile, rm } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { piHostAliases, piHostJitiUrl } from "./helpers/pi-host.mjs";

import acceptanceRootProvider, { installAcceptanceRootBrokerSubscriptions } from "./fixtures/repository-merge-queue-acceptance/root-provider.mjs";
import * as acceptanceProbe from "../scripts/probes/repository-merge-queue-acceptance.ts";
import { preparePublicCodingDispatch } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts";

import {
  ACCEPTANCE_TASKS,
  createAcceptanceBarrier,
  createAcceptanceReceipt,
  buildAcceptanceEnvironment,
  createAcceptanceDispatchPlan,
  createAcceptanceRootRpcArgs,
  dispatchAcceptanceRoots,
  AcceptanceRpcHost,
  parseAcceptanceOptions,
  validateAcceptanceReadyReceipt,
  validateAcceptanceConflictEvidence,
  collectAcceptanceLifecycleCounts,
} from "../scripts/probes/repository-merge-queue-acceptance.ts";

const fixture = join(import.meta.dirname, "fixtures", "repository-merge-queue-acceptance");
const { createJiti } = await import(piHostJitiUrl);
const discoveryJiti = createJiti(import.meta.url, { moduleCache: false, alias: piHostAliases });

async function providerTurn(tasks) {
  let provider;
  acceptanceRootProvider({ registerProvider(_name, value) { provider = value; } });
  const previous = process.env.PI_ACCEPTANCE_TASKS;
  const previousModel = process.env.PI_ACCEPTANCE_MODEL;
  process.env.PI_ACCEPTANCE_TASKS = tasks.join(",");
  try {
    const stream = provider.streamSimple({ api: "fake", provider: "fake", id: "deterministic" }, { messages: [] });
    let done;
    for await (const event of stream) if (event.type === "done") done = event;
    return done.message;
  } finally {
    if (previous === undefined) delete process.env.PI_ACCEPTANCE_TASKS;
    else process.env.PI_ACCEPTANCE_TASKS = previous;
    if (previousModel === undefined) delete process.env.PI_ACCEPTANCE_MODEL;
    else process.env.PI_ACCEPTANCE_MODEL = previousModel;
  }
}

async function waitForFile(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await access(path); return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function readDiagnostic(path) {
  await waitForFile(path);
  return JSON.parse(await readFile(path, "utf8"));
}

function settledAudit() {
  const workspaceIds = ACCEPTANCE_TASKS.map((task) => `workspace-${task.name}`);
  return {
    schemaVersion: "managed-workspace-administration.v1",
    coordinator: { status: "observed" },
    inventory: {
      workspaces: workspaceIds.map((workspaceId) => ({ receipt: { workspaceId, state: "released", terminalProof: { state: "observed", conflict: false, proofHash: "c".repeat(64) } }, identity: null, issues: [] })),
      orphanRegistrations: [], legacy: [],
    },
    queue: {
      items: workspaceIds.map((workspaceId, index) => ({
        version: "workspace-integration-queue-item.v1", queueItemId: `queue-${index}`, workspaceId, sequence: index + 1,
        state: "completed", candidateHead: `${String.fromCharCode(97 + index)}${"a".repeat(39)}`, admittedTargetHead: `${String.fromCharCode(96 + index)}${"a".repeat(39)}`, integrationIntentId: `intent-${index}`,
        workspaceDispositionReceiptId: `receipt-${index}`, completedAt: new Date(0).toISOString(),
      })),
    },
    debts: [],
  };
}

test("acceptance fixture has one shared pipeline line and five conflict tasks", async () => {
  assert.deepEqual(ACCEPTANCE_TASKS.map((task) => task.name), ["parse", "validate", "transform", "serialize", "audit"]);
  assert.equal(await readFile(join(fixture, "src", "pipeline.ts"), "utf8"), 'export const PIPELINE=["base"]\n');
  for (const task of ACCEPTANCE_TASKS) {
    assert.equal(task.writePath, "src/pipeline.ts");
    assert.match(task.behaviorAssertion, new RegExp(task.name));
  }
});

test("real agent discovery accepts the executor fixture and resolves its barrier extension", async () => {
  const { discoverAgents } = await discoveryJiti.import("../packages/pi-subagents-enhanced/node_modules/pi-subagents/src/agents/agents.ts");
  const discovered = discoverAgents(fixture, "project");
  const executor = discovered.agents.find((agent) => agent.name === "executor");
  assert.ok(executor, JSON.stringify(discovered.agentDiagnostics ?? []));
  assert.match(executor.description, /acceptance coding executor/i);
  assert.deepEqual(executor.subagentOnlyExtensions, [join(fixture, "acceptance-barrier.mjs")]);
  await access(executor.subagentOnlyExtensions[0]);
});

test("test-only barrier rejects model identity and blocks until five distinct same-base worktrees are ready", async () => {
  const barrier = createAcceptanceBarrier({ expected: ACCEPTANCE_TASKS, baseCommit: "base-commit" });
  const release = barrier.waitForRelease();
  assert.throws(() => barrier.ready({ task: "parse", childId: "child-a", worktree: "/tmp/a", baseCommit: "wrong" }), /base commit/i);
  barrier.ready({ task: "parse", childId: "child-a", worktree: "/tmp/a", baseCommit: "base-commit" });
  barrier.ready({ task: "validate", childId: "child-b", worktree: "/tmp/b", baseCommit: "base-commit" });
  barrier.ready({ task: "transform", childId: "child-c", worktree: "/tmp/c", baseCommit: "base-commit" });
  barrier.ready({ task: "serialize", childId: "child-d", worktree: "/tmp/d", baseCommit: "base-commit" });
  assert.equal(barrier.released, false);
  barrier.ready({ task: "audit", childId: "child-e", worktree: "/tmp/e", baseCommit: "base-commit" });
  assert.equal((await release).released, true);
  assert.equal(barrier.released, true);
  assert.throws(() => barrier.ready({ task: "audit", childId: "child-e", worktree: "/tmp/e2", baseCommit: "base-commit" }), /duplicate|released/i);
});

test("single-child barrier releases with an explicit expected set", async () => {
  const barrier = createAcceptanceBarrier({ expected: [ACCEPTANCE_TASKS[0]], baseCommit: "base-commit" });
  const release = barrier.waitForRelease();
  barrier.ready({ task: "parse", childId: "child-parse", worktree: "/tmp/parse", baseCommit: "base-commit" });
  assert.deepEqual(await release, { released: true, children: [{ task: "parse", childId: "child-parse", worktree: "/tmp/parse", baseCommit: "base-commit" }] });
});

test("receipt and environment contracts separate the config root from temporary state and clear child markers", () => {
  const receipt = createAcceptanceReceipt({ allocations: ACCEPTANCE_TASKS.map((task, i) => ({ task: task.name, childId: `child-${i}`, worktree: `/tmp/${task.name}`, baseCommit: "a".repeat(40) })) });
  assert.equal(receipt.schemaVersion, "repository-merge-queue-acceptance.v1");
  assert.deepEqual(Object.keys(receipt).sort(), ["actual", "allocations", "lifecycle", "recoveries", "requested", "schemaVersion"]);
  assert.equal(JSON.stringify(receipt).includes("prompt"), false);
  assert.equal(JSON.stringify(receipt).includes("session"), false);
  assert.equal(JSON.stringify(receipt).includes("credential"), false);
  const inheritedChildMarkers = {
    PI_SUBAGENT_CHILD: "1",
    PI_SUBAGENT_FANOUT_CHILD: "1",
    PI_SUBAGENT_PARENT_SESSION: "parent-session",
    PI_SUBAGENT_ORCHESTRATOR_SESSION_ID: "orchestrator-session",
    PI_SUBAGENT_RUN_ID: "child-run",
    PI_SUBAGENT_PARENT_DEPTH: "2",
    PI_SUBAGENT_PARENT_RUN_ID: "parent-run",
    PI_SUBAGENT_PARENT_PATH: "/tmp/parent",
    PI_ROOT_SUBAGENT_BROKER_ENABLED: "1",
  };
  const env = buildAcceptanceEnvironment({ HOME: "/home/test", GIT_CONFIG_GLOBAL: "/bad", GIT_CONFIG_NOSYSTEM: "0", ...inheritedChildMarkers }, "/tmp/state", "/readonly/pi-config");
  assert.match(env.GIT_CONFIG_GLOBAL, /empty-global\.gitconfig$/);
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(env.GIT_RERERE_ENABLED, "0");
  assert.equal(env.PI_CODING_WORKSPACE_DIR, "/tmp/state/workspaces");
  assert.equal(env.PI_CODING_AGENT_SESSION_DIR, "/tmp/state/sessions");
  assert.equal(env.PI_CODING_AGENT_DIR, "/readonly/pi-config");
  for (const marker of Object.keys(inheritedChildMarkers)) assert.equal(env[marker], undefined, marker);
  assert.throws(() => buildAcceptanceEnvironment({}, "/tmp/state"), /config root/i);
});

test("barrier ready accepts only trusted run/cwd/HEAD/PID shaped evidence", () => {
  const ready = { schemaVersion: "repository-merge-queue-ready.v1", runId: "run-parse", worktree: "/tmp/worktree", baseCommit: "a".repeat(40), pid: 42 };
  assert.equal(validateAcceptanceReadyReceipt(ready, { runId: "run-parse", baseCommit: ready.baseCommit }), true);
  for (const invalid of [
    { ...ready, runId: "model-claimed" }, { ...ready, pid: 0 }, { ...ready, baseCommit: "not-a-head" },
    { ...ready, schemaVersion: "model-ready" }, { ...ready, worktree: "" },
  ]) assert.throws(() => validateAcceptanceReadyReceipt(invalid, { runId: "run-parse", baseCommit: ready.baseCommit }), /trusted|mismatch|schema/i);
});

test("conflict evidence requires Git-derived non-zero rebase, unmerged entries, sequencer and digest", async () => {
  const evidence = JSON.parse(await readFile(join(fixture, "conflict-evidence.json"), "utf8"));
  assert.equal(validateAcceptanceConflictEvidence(evidence), true);
  for (const mutate of [
    (value) => { value.rebaseExitCode = 0; },
    (value) => { value.unmergedEntries = []; },
    (value) => { delete value.sequencer; },
    (value) => { value.conflictDigest = "bad"; },
    (value) => { value.digestSource = "model"; },
  ]) { const invalid = structuredClone(evidence); mutate(invalid); assert.throws(() => validateAcceptanceConflictEvidence(invalid), /conflict|Git|rebase|unmerged|sequencer/i); }
});

test("lifecycle counters consume public agent receipts and never agent_settled", () => {
  assert.deepEqual(collectAcceptanceLifecycleCounts([
    { type: "agent_start" }, { type: "agent_end" }, { type: "follow-up" }, { type: "agent_start" },
    { type: "agent_settled" }, { type: "agent_end" }, { type: "follow_up" }, { type: "agent_start" },
  ]), { agent_end: 2, follow_up: 2, next_agent_start: 2 });
});

test("dispatch plan uses two real roots with a 3+2 split and executor profile", () => {
  const plan = createAcceptanceDispatchPlan();
  assert.deepEqual(plan.roots.map((root) => root.tasks.length), [3, 2]);
  assert.equal(plan.children.length, 5);
  assert.deepEqual([...new Set(plan.children.map((child) => child.agent))], ["executor"]);
  assert.ok(plan.children.every((child) => child.model === "codex-pool/gpt-5.6-sol" && child.worktree && !Object.hasOwn(child, "async")));
  // 验收 child 的提交必须能过全局 security-gates 的 Conventional Commit + 中文 subject 门禁
  // （真实运行失败根因：英文 message 被 COMMIT_MESSAGE_INVALID 拒绝）。
  assert.ok(plan.children.every((child) => child.requirements.some((requirement) =>
    /Conventional Commit/i.test(requirement) && /[\u4e00-\u9fff]/.test(requirement))));
  // child 的自评 criteria 只能包含 child 可控项；集成结果由 probe 的 public receipts 验收
  // （真实运行失败根因：集成结果进自评导致 child rejected → 集成 guard preserve → 死锁）。
  assert.ok(plan.children.every((child) => child.acceptance.criteria.every((criterion) =>
    !/Auto Integration|publish/i.test(criterion))));
  assert.throws(() => createAcceptanceDispatchPlan({ model: "fake/deterministic" }), /real executor model/i);
});

test("CLI parser rejects unknown and invalid cardinality arguments", () => {
  assert.deepEqual(parseAcceptanceOptions(["--roots", "1", "--subagents", "1", "--require-conflicts", "0"]), {
    roots: 1, subagents: 1, requireConflicts: 0, model: "codex-pool/gpt-5.6-sol",
  });
  assert.deepEqual(parseAcceptanceOptions(["--model", "zai-coding-cn/glm-5.3"]), {
    roots: 2, subagents: 5, requireConflicts: 4, model: "zai-coding-cn/glm-5.3",
  });
  for (const args of [
    ["--unknown", "1"], ["--roots", "x"], ["--roots", "3"],
    ["--subagents", "0"], ["--subagents", "6"], ["--require-conflicts", "5"],
    ["--roots", "1", "--subagents", "1", "--require-conflicts", "1"],
    ["--model", "bare-model"], ["--model", "fake/deterministic"],
  ]) assert.throws(() => parseAcceptanceOptions(args), /unknown|integer|roots|subagents|conflicts|model/i);
});

test("diagnostic plan and receipt use requested cardinality", () => {
  const plan = createAcceptanceDispatchPlan({ roots: 1, subagents: 1 });
  assert.deepEqual(plan.roots.map((root) => root.tasks), [["parse"]]);
  assert.equal(plan.children.length, 1);
  const receipt = createAcceptanceReceipt({ options: { roots: 1, subagents: 1, requireConflicts: 0 }, allocations: [{ task: "parse", childId: "child-parse", worktree: "/tmp/parse", baseCommit: "a".repeat(40) }] });
  assert.deepEqual(receipt.requested, { roots: 1, subagents: 1, conflicts: 0 });
  assert.deepEqual(receipt.actual, { roots: 1, subagents: 1, conflicts: 0 });
});

test("diagnostic dispatch uses one root and only the parse child", async () => {
  const calls = [];
  await dispatchAcceptanceRoots({
    plan: createAcceptanceDispatchPlan({ roots: 1, subagents: 1 }),
    subagentTools: [{ execute: async (taskId) => { calls.push(taskId); } }],
  });
  assert.deepEqual(calls, ["acceptance-parse"]);
});

test("root provider forwards PI_ACCEPTANCE_MODEL to the dispatch contract and defaults to sol", async () => {
  // R12 归因：contract() 曾硬编码 codex-pool/gpt-5.6-sol，probe 的 --model 参数
  // 断链于 root-provider，导致切换模型从未生效（R12c/R12d 实际 child 仍是 codex-pool/sol）。
  process.env.PI_ACCEPTANCE_MODEL = "openai-codex/gpt-5.6-sol";
  let message = await providerTurn(["parse"]);
  let call = message.content.find((part) => part.type === "toolCall");
  assert.equal(call.arguments.model, "openai-codex/gpt-5.6-sol");
  delete process.env.PI_ACCEPTANCE_MODEL;
  message = await providerTurn(["parse"]);
  call = message.content.find((part) => part.type === "toolCall");
  assert.equal(call.arguments.model, "codex-pool/gpt-5.6-sol");
});

test("root provider requests cross the public caller gate and reach the dispatch adapter", async () => {
  const received = [];
  for (const tasks of [["parse", "validate", "transform"], ["serialize", "audit"]]) {
    const message = await providerTurn(tasks);
    const calls = message.content.filter((part) => part.type === "toolCall");
    assert.equal(calls.length, tasks.length);
    for (const call of calls) {
      const prepared = preparePublicCodingDispatch(call.arguments, { cwd: fixture, timeoutMs: 30 * 60 * 1000 });
      received.push({ task: call.arguments.task });
      assert.equal(typeof prepared.taskId, "string");
      assert.deepEqual(call.arguments.writePaths, ["src/pipeline.ts", "test/pipeline.test.mjs"]);
      assert.equal(call.arguments.worktree, true);
      assert.equal(call.arguments.worktree, true);
      assert.ok(/Conventional Commit/i.test(call.arguments.task) && /[\u4e00-\u9fff]/.test(call.arguments.task));
      assert.ok(call.arguments.acceptance.criteria.every((criterion) => !/publish|integration queue/i.test(criterion)));
    }
  }
  assert.equal(received.length, 5);
  assert.ok(received.every(({ task }) => /Modify the shared PIPELINE/.test(task)));
});

test("acceptance root keeps a broker subscription for each managed child through recovery", async () => {
  const listeners = new Map();
  const shutdown = [];
  const pushes = [];
  const disposed = [];
  let attempts = 0;
  const pi = {
    events: { on(type, listener) { listeners.set(type, listener); return () => listeners.delete(type); } },
    on(type, listener) { if (type === "session_shutdown") shutdown.push(listener); },
    sendMessage(message) { pushes.push(message); },
  };
  installAcceptanceRootBrokerSubscriptions(pi, {
    rootSessionId: "root-session",
    retryDelayMs: 0,
    createClient({ rootSessionId, callerRunId, requiredCapability }) {
      assert.deepEqual({ rootSessionId, callerRunId, requiredCapability }, { rootSessionId: "root-session", callerRunId: "child-run", requiredCapability: "root.subscribe" });
      return {
        async subscribe(onPush) {
          attempts += 1;
          if (attempts === 1) throw Object.assign(new Error("grant pending"), { code: "GRANT_NOT_READY" });
          onPush({ type: "recovery.event", data: { recoveryIntentId: "intent-1" } });
          return { dispose() { disposed.push("subscription"); }, closed: new Promise(() => {}) };
        },
        dispose() { disposed.push("client"); },
      };
    },
  });
  await listeners.get("subagent:async-started")({ runId: "child-run" });
  assert.equal(attempts, 2);
  assert.deepEqual(pushes, [{ customType: "pi-root-recovery-event-v1", content: "Recovery event observed by acceptance root.", details: { recoveryIntentId: "intent-1" } }]);
  shutdown[0]();
  assert.deepEqual(disposed.sort(), ["client", "subscription"]);
});

test("root provider emits each 3+2 task once with complete tool-call stream events", async () => {
  let provider;
  acceptanceRootProvider({ registerProvider(_name, value) { provider = value; } });
  for (const tasks of [["parse", "validate", "transform"], ["serialize", "audit"]]) {
    const previous = process.env.PI_ACCEPTANCE_TASKS;
    process.env.PI_ACCEPTANCE_TASKS = tasks.join(",");
    try {
      const events = [];
      for await (const event of provider.streamSimple({ api: "fake", provider: "fake", id: "deterministic" }, { messages: [] })) events.push(event);
      const ended = events.filter((event) => event.type === "toolcall_end");
      assert.deepEqual(ended.map((event) => event.toolCall.id), tasks.map((task) => `acceptance-${task}`));
      assert.deepEqual(events.filter((event) => event.type === "toolcall_start").map((event) => event.contentIndex), tasks.map((_, index) => index));
      assert.deepEqual(events.filter((event) => event.type === "toolcall_delta").map((event) => event.contentIndex), tasks.map((_, index) => index));
      const priorAssistant = events.find((event) => event.type === "done").message;
      const continuation = [];
      for await (const event of provider.streamSimple({ api: "fake", provider: "fake", id: "deterministic" }, { messages: [priorAssistant] })) continuation.push(event);
      assert.equal(continuation.some((event) => event.type.startsWith("toolcall_")), false);
      assert.equal(continuation.find((event) => event.type === "done").message.stopReason, "stop");
    } finally {
      if (previous === undefined) delete process.env.PI_ACCEPTANCE_TASKS;
      else process.env.PI_ACCEPTANCE_TASKS = previous;
    }
  }
});

test("async barrier extension factory blocks child model startup until release", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acceptance-barrier-process-"));
  const barrier = join(root, "barrier");
  const modelStarted = join(root, "model-started");
  await writeFile(join(root, "runner.mjs"), `
    import barrier from ${JSON.stringify(join(fixture, "acceptance-barrier.mjs"))};
    await barrier({});
    await (await import("node:fs/promises")).writeFile(process.env.MODEL_STARTED, "started");
  `);
  execFileSync("git", ["init", "-b", "acceptance-parse"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "acceptance@example.test"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Acceptance"], { cwd: root });
  await writeFile(join(root, "base"), "base\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
  const child = spawn(process.execPath, [join(root, "runner.mjs")], {
    cwd: root,
    env: { ...process.env, PI_SUBAGENT_RUN_ID: "run-parse", PI_ACCEPTANCE_BARRIER_DIR: barrier, PI_ACCEPTANCE_TASKS: ACCEPTANCE_TASKS.map((task) => task.name).join(","), MODEL_STARTED: modelStarted },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGTERM"); return rm(root, { recursive: true, force: true }); });
  await waitForFile(join(barrier, "run-parse.ready.json"));
  await assert.rejects(access(modelStarted));
  const ready = JSON.parse(await readFile(join(barrier, "run-parse.ready.json"), "utf8"));
  assert.deepEqual(Object.keys(ready).sort(), ["baseCommit", "pid", "runId", "schemaVersion", "worktree"]);
  assert.equal(ready.runId, "run-parse");
  assert.equal(ready.worktree, await realpath(root));
  assert.equal(ready.baseCommit, execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim());
  await writeFile(join(barrier, "release.json"), `${JSON.stringify({ children: [ready] })}\n`);
  await waitForFile(modelStarted);
});

test("probe maps typed dispatch receipts to run-named ready files without details.task", async (t) => {
  const barrier = await mkdtemp(join(tmpdir(), "acceptance-ready-map-"));
  t.after(() => rm(barrier, { recursive: true, force: true }));
  const records = [];
  for (const [index, task] of ACCEPTANCE_TASKS.entries()) {
    const runId = `run-${task.name}`;
    const workspaceId = `workspace-${task.name}`;
    records.push({ type: "tool_execution_end", toolName: "subagent", result: { isError: false, details: { taskId: `acceptance-${task.name}`, runId, workspace_id: workspaceId, lease_id: `lease-${task.name}` } } });
    await writeFile(join(barrier, `${runId}.ready.json`), `${JSON.stringify({ schemaVersion: "repository-merge-queue-ready.v1", runId, worktree: `/tmp/worktree-${index}`, baseCommit: "a".repeat(40), pid: 100 + index })}\n`);
  }
  const children = await acceptanceProbe.collectAcceptanceReady(barrier, {
    hosts: [{ records, assertHealthy() {} }], readAudit: async () => ({}), timeoutMs: 100,
  });
  assert.deepEqual(children.map(({ task, runId, workspaceId }) => ({ task, runId, workspaceId })), ACCEPTANCE_TASKS.map((task) => ({ task: task.name, runId: `run-${task.name}`, workspaceId: `workspace-${task.name}` })));
  assert.equal(JSON.stringify(records).includes('"task"'), false);
});

test("public dispatch bindings normalize snake_case host identity against camelCase audit identity", () => {
  const host = {
    records: [{ type: "tool_execution_end", toolName: "subagent", result: { details: {
      taskId: "acceptance-parse", runId: "run-parse", workspace_id: "workspace-parse", lease_id: "lease-parse",
    } } }],
  };
  const audit = { inventory: { workspaces: [{ receipt: {
    owner: { toolCallId: "acceptance-parse" }, run: { runId: "run-parse" },
    workspaceId: "workspace-parse", leaseId: "lease-parse",
  } }] } };
  const bindings = acceptanceProbe.collectPublicDispatchBindings([host], audit);
  assert.deepEqual(bindings.get("parse"), { task: "parse", runId: "run-parse", workspaceId: "workspace-parse", leaseId: "lease-parse" });
  assert.throws(() => acceptanceProbe.collectPublicDispatchBindings([{
    records: [{ ...host.records[0], result: { details: { taskId: "acceptance-parse", runId: "run-parse", workspaceId: "workspace-parse", leaseId: "lease-parse" } } }],
  }], {}), /workspace_id or lease_id/);
});

test("preallocated audit workspace remains unready until the host ends and audit binds its run", async (t) => {
  const barrier = await mkdtemp(join(tmpdir(), "acceptance-transient-binding-"));
  t.after(() => rm(barrier, { recursive: true, force: true }));
  const host = {
    records: [{ type: "tool_execution_start", toolName: "subagent", toolCallId: "acceptance-parse" }],
    assertHealthy() {},
  };
  const preallocated = { inventory: { workspaces: [{ receipt: {
    owner: { toolCallId: "acceptance-parse" }, run: null,
    workspaceId: "workspace-parse", leaseId: "lease-parse",
  } }] } };
  assert.deepEqual([...acceptanceProbe.collectPublicDispatchBindings([host], preallocated)], []);

  await writeFile(join(barrier, "run-parse.ready.json"), `${JSON.stringify({
    schemaVersion: "repository-merge-queue-ready.v1", runId: "run-parse",
    worktree: "/tmp/worktree-parse", baseCommit: "a".repeat(40), pid: 100,
  })}\n`);
  let reads = 0;
  const children = await acceptanceProbe.collectAcceptanceReady(barrier, {
    hosts: [host], expected: [ACCEPTANCE_TASKS[0]], timeoutMs: 500,
    readAudit: async () => {
      reads += 1;
      if (reads === 1) return preallocated;
      host.records.push({ type: "tool_execution_end", toolName: "subagent", result: { isError: false, details: {
        taskId: "acceptance-parse", runId: "run-parse", workspace_id: "workspace-parse", lease_id: "lease-parse",
      } } });
      return { inventory: { workspaces: [{ receipt: {
        owner: { toolCallId: "acceptance-parse" }, run: { runId: "run-parse" },
        workspaceId: "workspace-parse", leaseId: "lease-parse",
      } }] } };
    },
  });
  assert.ok(reads >= 2);
  assert.deepEqual(children.map(({ task, runId, workspaceId }) => ({ task, runId, workspaceId })), [
    { task: "parse", runId: "run-parse", workspaceId: "workspace-parse" },
  ]);
});

test("successful host end waits for a bounded audit run binding and reports it missing on timeout", async () => {
  const host = { records: [{ type: "tool_execution_end", toolName: "subagent", result: { isError: false, details: {
    taskId: "acceptance-parse", runId: "run-parse", workspace_id: "workspace-parse", lease_id: "lease-parse",
  } } }], assertHealthy() {} };
  const preallocated = { inventory: { workspaces: [{ receipt: {
    owner: { toolCallId: "acceptance-parse" }, run: null,
    workspaceId: "workspace-parse", leaseId: "lease-parse",
  } }] } };
  await assert.rejects(
    acceptanceProbe.collectAcceptanceReady("/missing", {
      hosts: [host], expected: [ACCEPTANCE_TASKS[0]], readAudit: async () => preallocated, timeoutMs: 125,
    }),
    /timed out.*binding missing.*parse/i,
  );
});

test("public dispatch bindings fail closed for duplicate task identity mismatches", () => {
  const base = { taskId: "acceptance-parse", runId: "run-parse", workspace_id: "workspace-parse", lease_id: "lease-parse" };
  for (const [field, value] of [["runId", "run-other"], ["workspace_id", "workspace-other"], ["lease_id", "lease-other"]]) {
    const changed = { ...base, [field]: value };
    assert.throws(() => acceptanceProbe.collectPublicDispatchBindings([
      { records: [{ type: "tool_execution_end", toolName: "subagent", result: { details: base } }] },
      { records: [{ type: "tool_execution_end", toolName: "subagent", result: { details: changed } }] },
    ], {}), /duplicate dispatch binding mismatch/);
  }
  assert.throws(() => acceptanceProbe.collectPublicDispatchBindings([{
    records: [{ type: "tool_execution_end", toolName: "subagent", result: { details: base } }],
  }], { inventory: { workspaces: [{ receipt: {
    owner: { toolCallId: "acceptance-parse" }, run: { runId: "run-other" }, workspaceId: "workspace-parse", leaseId: "lease-parse",
  } }] } }), /public dispatch binding mismatch/);
  for (const [field, value] of [["workspaceId", "workspace-other"], ["leaseId", "lease-other"]]) {
    assert.throws(() => acceptanceProbe.collectPublicDispatchBindings([{
      records: [{ type: "tool_execution_end", toolName: "subagent", result: { details: base } }],
    }], { inventory: { workspaces: [{ receipt: {
      owner: { toolCallId: "acceptance-parse" }, run: null,
      workspaceId: "workspace-parse", leaseId: "lease-parse", [field]: value,
    } }] } }), /public dispatch binding mismatch/);
  }
});


test("probe closes Root hosts only after public audit settlement", async () => {
  const order = [];
  let reads = 0;
  const hosts = [0, 1].map((index) => ({
    assertHealthy() { order.push(`health-${index}`); },
    async close() { order.push(`close-${index}`); },
  }));
  const pending = settledAudit();
  pending.queue.items[4] = { ...pending.queue.items[4], state: "prepared", completedAt: undefined };
  const result = await acceptanceProbe.settleAcceptanceHosts({
    hosts,
    expectedCount: 5,
    intervalMs: 1,
    timeoutMs: 1_000,
    readAudit: async () => { reads += 1; order.push(`audit-${reads}`); return reads === 1 ? pending : settledAudit(); },
  });
  assert.equal(reads, 2);
  assert.equal(result.queue.items.every((item) => item.state === "completed"), true);
  assert.ok(order.indexOf("close-0") > order.indexOf("audit-2"));
  assert.ok(order.indexOf("close-1") > order.indexOf("audit-2"));
});

test("legacy shell probe and in-process barrier are absent", async () => {
  const probe = await readFile(new URL("../scripts/probes/repository-merge-queue-acceptance.ts", import.meta.url), "utf8");
  const barrier = await readFile(join(fixture, "acceptance-barrier.mjs"), "utf8");
  assert.doesNotMatch(probe, /--version|pending-/);
  assert.doesNotMatch(barrier, /globalThis|trusted/);
  assert.match(probe, /--mode.*rpc/);
  assert.match(barrier, /process\.cwd\(\)/);
  const args = createAcceptanceRootRpcArgs({ provider: "/fixture/root-provider.mjs", runtime: "/runtime/subagent-runtime.ts" });
  assert.deepEqual(args, [
    "--mode", "rpc", "--no-session", "--no-extensions", "--approve",
    "-e", "/fixture/root-provider.mjs", "-e", "/runtime/subagent-runtime.ts",
    "--provider", "fake", "--model", "fake/deterministic",
  ]);
});

test("deterministic roots issue exactly three plus two typed executor dispatches", async () => {
  const calls = [];
  const tool = (root) => ({ execute: async (_id, input) => { calls.push({ root, input }); return { root }; } });
  await dispatchAcceptanceRoots({ subagentTools: [tool("a"), tool("b")], cwd: "/fixture" });
  assert.deepEqual(calls.map((call) => call.root), ["a", "a", "a", "b", "b"]);
  assert.ok(calls.every(({ input }) => input.agent === "executor" && input.model === "codex-pool/gpt-5.6-sol" && input.worktree === true));
  assert.ok(calls.every(({ input }) => /Auto Integration/.test(input.task)));
  assert.ok(calls.every(({ input }) => !/subagent_integration|enqueue\b|await\b|rebase\b|publish\b/.test(input.task)));
});

test("manual integration mutation traces fail host health before acceptance settlement", async () => {
  const host = { records: [{ type: "tool_execution_start", toolName: "subagent_integration" }], assertHealthy() {} };
  await assert.rejects(acceptanceProbe.collectAcceptanceReady("/missing", { hosts: [host], expected: [ACCEPTANCE_TASKS[0]], timeoutMs: 1, readAudit: async () => ({}) }), /manual integration mutation/);
});

test("settled audit requires Auto Integration FIFO, admission chain, lifecycle proof, and clean release", () => {
  const audit = settledAudit();
  audit.queue.items = audit.queue.items.map((item, index) => ({ ...item, sequence: index + 1, admittedTargetHead: index ? audit.queue.items[index - 1].candidateHead : "b".repeat(40) }));
  audit.inventory.workspaces = audit.inventory.workspaces.map((entry) => ({ ...entry, receipt: { ...entry.receipt, terminalProof: { state: "observed", conflict: false, proofHash: "c".repeat(64) }, intent: { action: "publish" } } }));
  assert.equal(acceptanceProbe.isAcceptanceAuditSettled(audit), true);
  for (const mutate of [
    (value) => { value.queue.items[2].sequence = value.queue.items[1].sequence; },
    (value) => { value.queue.items[2].admittedTargetHead = "d".repeat(40); },
    (value) => { value.queue.items[1].state = "prepared"; },
    (value) => { value.inventory.legacy.push({ state: "legacy" }); },
  ]) { const invalid = structuredClone(audit); mutate(invalid); assert.equal(acceptanceProbe.isAcceptanceAuditSettled(invalid), false); }
});

test("a normal idle-exited coordinator with its singleton debt still settles", () => {
  // daemon 正常 idle-exit 后 metadata 保留为 stale，并必然伴随 coordinator-singleton dead debt；
  // settlement 的证据主体是磁盘真相，活 daemon 不是前提（R12h 真实现场）。
  const audit = settledAudit();
  audit.coordinator = { status: "stale", protocol: "repository-workspace-coordinator.v1", instanceId: "i", repositoryId: "r", stateRoot: "s" };
  audit.debts = [{ kind: "coordinator-singleton", status: "dead" }];
  assert.equal(acceptanceProbe.isAcceptanceAuditSettled(audit), true);
  for (const extra of [
    [{ kind: "coordinator-singleton", status: "dead" }, { kind: "cleanup", workspaceId: "w", status: "unresolved" }],
    [{ kind: "state-root-split-brain", status: "migration-debt" }],
  ]) {
    const invalid = structuredClone(audit);
    invalid.debts = structuredClone(extra);
    assert.equal(acceptanceProbe.isAcceptanceAuditSettled(invalid), false);
  }
});

test("RPC hosts write one prompt, dispatch 3+2 calls, and remain alive until settlement", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acceptance-rpc-host-"));
  const fake = join(root, "rpc.mjs");
  await writeFile(fake, `
    import { stdin } from "node:process";
    let input = ""; stdin.setEncoding("utf8");
    stdin.on("data", (chunk) => { input += chunk; if (!input.includes("\\n")) return; const request = JSON.parse(input.trim()); const count = Number(process.env.COUNT); process.stdout.write(JSON.stringify({ type: "prompt_received", message: request.message }) + "\\n"); for (let i = 0; i < count; i++) process.stdout.write(JSON.stringify({ type: "tool_execution_end", toolName: "subagent", result: { details: { task: "task-" + i } } }) + "\\n"); });
  `);
  t.after(() => rm(root, { recursive: true, force: true }));
  const plan = createAcceptanceDispatchPlan();
  const hosts = [3, 2].map((count, index) => new AcceptanceRpcHost(process.execPath, [fake], { env: { ...process.env, COUNT: String(count) }, prompt: JSON.stringify({ agent: "executor", task: `acceptance-root-${index}` }) }).start());
  const records = await Promise.all(hosts.map((host, index) => host.settle({ terminal: (events) => events.filter((event) => event.type === "tool_execution_end").length === [3, 2][index] })));
  assert.deepEqual(records.map((events) => events.filter((event) => event.type === "tool_execution_end").length), [3, 2]);
  assert.ok(hosts.every((host) => !host.child.killed), "hosts must remain alive after dispatch settlement");
  await Promise.all(hosts.map((host) => host.close()));
  assert.equal(plan.children.filter((child) => child.agent === "executor").length, 5);
});

test("RPC host fails fast before first tool and persists redacted diagnostics", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acceptance-rpc-timeout-"));
  const fake = join(root, "rpc.mjs");
  const diagnosticsDir = join(root, "diagnostics");
  await writeFile(fake, `process.stderr.write("diagnostic stderr marker\\n"); setInterval(() => {}, 1000);`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = new AcceptanceRpcHost(process.execPath, [fake], {
    env: process.env,
    prompt: JSON.stringify({ prompt: "private prompt" }),
    startupTimeoutMs: 30,
    firstToolTimeoutMs: 100,
    diagnosticsDir,
  }).start();
  await assert.rejects(host.settle({ timeoutMs: 500 }), /startup timed out|first-tool timed out/);
  await host.close();
  const diagnostic = JSON.parse(await readFile(join(diagnosticsDir, "diagnostic.json"), "utf8"));
  assert.equal(JSON.stringify(diagnostic).includes("private prompt"), false);
  assert.equal(JSON.stringify(diagnostic).includes("session secret"), false);
  await access(join(diagnosticsDir, "root-stderr.log"));
});

test("extension_error listen EINVAL aborts the acceptance barrier with an atomic redacted diagnostic", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acceptance-extension-error-"));
  const fake = join(root, "rpc.mjs");
  const diagnosticsDir = join(root, "diagnostics");
  await writeFile(fake, `
    process.stdin.once("data", () => {
      process.stderr.write("listen failed; authorization=secret-token\\n");
      process.stdout.write(JSON.stringify({ type: "extension_error", error: "listen EINVAL", prompt: "private prompt", sessionId: "private-session" }) + "\\n");
    });
    setInterval(() => {}, 1000);
  `);
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = new AcceptanceRpcHost(process.execPath, [fake], {
    env: process.env, prompt: "private prompt", rootLabel: "root-a", tempPath: root,
    diagnosticsDir, startupTimeoutMs: 1_000, firstToolTimeoutMs: 1_000,
  }).start();
  const started = Date.now();
  await assert.rejects(
    acceptanceProbe.collectAcceptanceReady(join(root, "barrier"), { hosts: [host], readAudit: async () => new Promise(() => {}), timeoutMs: 5_000 }),
    /extension_error.*EINVAL|listen EINVAL/i,
  );
  assert.ok(Date.now() - started < 1_000, "host failure must interrupt an in-flight audit read");
  await host.close();
  const diagnosticPath = join(diagnosticsDir, "diagnostic.json");
  const diagnostic = await readDiagnostic(diagnosticPath);
  assert.equal(diagnostic.rootLabel, "root-a");
  assert.equal(diagnostic.tempPath, root);
  assert.equal(diagnostic.error.code, "EINVAL");
  assert.match(diagnostic.error.message, /listen EINVAL/);
  assert.deepEqual(diagnostic.recentEvents.at(-1), { type: "extension_error", toolName: null, isError: true });
  const serialized = JSON.stringify(diagnostic);
  assert.doesNotMatch(serialized, /private prompt|private-session|secret-token/);
  assert.doesNotMatch(await readFile(join(diagnosticsDir, "root-records.jsonl"), "utf8"), /private prompt|private-session/);
  assert.doesNotMatch(await readFile(join(diagnosticsDir, "root-stderr.log"), "utf8"), /secret-token/);
  assert.equal((await readFile(diagnosticPath, "utf8")).endsWith("\n"), true);
});

test("five failed subagent tool ends abort public audit settlement before its timeout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acceptance-tool-errors-"));
  const fake = join(root, "rpc.mjs");
  const diagnosticsDir = join(root, "diagnostics");
  await writeFile(fake, `
    process.stdin.once("data", () => {
      for (let index = 0; index < 5; index++) process.stdout.write(JSON.stringify({
        type: "tool_execution_end", toolName: "subagent", isError: true,
        result: { isError: true, error: { code: "CHILD_FAILED", message: "child " + index + " failed" }, details: { arguments: { apiKey: "credential" } } },
      }) + "\\n");
    });
    setInterval(() => {}, 1000);
  `);
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = new AcceptanceRpcHost(process.execPath, [fake], {
    env: process.env, prompt: "private", rootLabel: "root-b", tempPath: root, diagnosticsDir,
  }).start();
  const started = Date.now();
  await assert.rejects(
    acceptanceProbe.waitForAcceptanceAudit({ hosts: [host], readAudit: async () => new Promise(() => {}), timeoutMs: 5_000 }),
    /tool_execution_end.*subagent|child 0 failed/i,
  );
  assert.ok(Date.now() - started < 1_000, "host failure must interrupt public audit settlement");
  await host.close();
  const diagnostic = await readDiagnostic(join(diagnosticsDir, "diagnostic.json"));
  assert.equal(diagnostic.rootLabel, "root-b");
  assert.deepEqual(diagnostic.recentEvents.at(-1), {
    type: "tool_execution_end", toolName: "subagent", isError: true,
    detailsCode: "CHILD_FAILED", errorCode: "CHILD_FAILED", errorText: "child 4 failed",
  });
  assert.ok(diagnostic.recentEvents.at(-1).errorText.length <= 500);
  assert.doesNotMatch(JSON.stringify(diagnostic), /apiKey|credential|arguments/);
});

test("failed subagent tool diagnostics retain only nested safe RPC detail fields", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acceptance-nested-rpc-error-"));
  const fake = join(root, "rpc.mjs");
  const diagnosticsDir = join(root, "diagnostics");
  await writeFile(fake, `
    process.stdin.once("data", () => {
      process.stdout.write(JSON.stringify({
        type: "tool_execution_end", toolName: "subagent", isError: true,
        result: { isError: true, details: {
          code: "SUBAGENT_RPC_FAILED",
          detail: {
            taskId: "task-rpc", toolCallId: "call-rpc", stage: "dispatch",
            rpcOperation: "start", causeCode: "ECONNRESET",
            causeMessage: "RPC transport failed", secret: "x",
          },
        } },
      }) + "\\n");
    });
    setInterval(() => {}, 1000);
  `);
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = new AcceptanceRpcHost(process.execPath, [fake], {
    env: process.env, prompt: "private", diagnosticsDir,
  }).start();
  await assert.rejects(host.settle({ timeoutMs: 2_000 }), /tool_execution_end.*subagent/i);
  await host.close();
  const diagnostic = await readDiagnostic(join(diagnosticsDir, "diagnostic.json"));
  assert.deepEqual(diagnostic.recentEvents.at(-1), {
    type: "tool_execution_end", toolName: "subagent", isError: true,
    detailsCode: "SUBAGENT_RPC_FAILED",
    taskId: "task-rpc", toolCallId: "call-rpc", stage: "dispatch",
    rpcOperation: "start", causeCode: "ECONNRESET",
    causeMessage: "RPC transport failed", errorText: "RPC transport failed",
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /secret|"x"/);
});

for (const scenario of [
  { name: "non-zero Root exit", body: `process.stderr.write("root failed\\n"); process.exit(7);`, match: /exited.*7/i },
  { name: "unexpected zero Root exit", body: `process.stderr.write("stderr-only failure\\n"); process.exit(0);`, match: /exited.*0/i },
  { name: "invalid JSON", body: `process.stdout.write("not-json\\n"); setInterval(() => {}, 1000);`, match: /invalid Pi RPC JSON/i },
  { name: "first-tool timeout", body: `process.stdout.write(JSON.stringify({ type: "agent_start", message: "session secret" }) + "\\n"); setInterval(() => {}, 1000);`, match: /first-tool timed out/i, firstToolTimeoutMs: 30 },
]) {
  test(`${scenario.name} writes a redacted diagnostic before terminating the Root`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "acceptance-root-failure-"));
    const fake = join(root, "rpc.mjs");
    const diagnosticsDir = join(root, "diagnostics");
    await writeFile(fake, scenario.body);
    t.after(() => rm(root, { recursive: true, force: true }));
    const host = new AcceptanceRpcHost(process.execPath, [fake], {
      env: process.env, prompt: "private prompt", rootLabel: "root-fixture", tempPath: root,
      diagnosticsDir, startupTimeoutMs: 500, firstToolTimeoutMs: scenario.firstToolTimeoutMs ?? 500,
    }).start();
    await assert.rejects(host.settle({ timeoutMs: 2_000 }), scenario.match);
    const diagnostic = await readDiagnostic(join(diagnosticsDir, "diagnostic.json"));
    assert.equal(diagnostic.rootLabel, "root-fixture");
    assert.equal(diagnostic.tempPath, root);
    assert.match(diagnostic.error.message, scenario.match);
    assert.doesNotMatch(JSON.stringify(diagnostic), /private prompt|session secret/);
    await host.close();
  });
}

test("barrier and audit waits honor AbortSignal without waiting for their configured timeout", async () => {
  for (const wait of [
    (signal) => acceptanceProbe.collectAcceptanceReady("/missing", { signal, timeoutMs: 5_000, readAudit: async () => new Promise(() => {}) }),
    (signal) => acceptanceProbe.waitForAcceptanceAudit({ hosts: [], signal, timeoutMs: 5_000, readAudit: async () => new Promise(() => {}) }),
  ]) {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("acceptance overall timed out")), 20);
    const started = Date.now();
    await assert.rejects(wait(controller.signal), /acceptance overall timed out/);
    assert.ok(Date.now() - started < 500);
  }
});

function resumeIntentFixture(overrides = {}) {
  return {
    version: "integration-resume-intent.v1", resumeIntentId: "intent-1", queueItemId: "queue-1", workspaceId: "workspace-parse",
    leaseId: "a".repeat(64), ownerScope: { kind: "standalone-subagent", rootSessionId: "root-a" },
    sourceRunId: "run-source-1", sourceAsyncDir: "/var/tmp/async/source-1", sourceProofId: "1".repeat(64),
    attempt: 1, generation: 0, queueRevision: 3, queueState: "queued", conflictDigest: null,
    progressFingerprint: "f".repeat(64), noProgressCount: 0, requiredAction: "resume-child",
    state: "completed", resumedRun: { runId: "run-resumed-1", asyncDir: "/var/tmp/async/resumed-1", sessionId: "s", pid: 1, agentProfile: "executor" },
    delivery: { state: "delivered", attempts: 1 }, createdAt: "2026-09-16T00:00:00.000Z", updatedAt: "2026-09-16T00:00:00.000Z",
    ...overrides,
  };
}

test("recovery 公共证据：无恢复的 settled audit 产出空 recoveries 且 lifecycle 计数为零", () => {
  const audit = settledAudit();
  assert.equal(acceptanceProbe.isAcceptanceAuditSettled(audit), true);
  const evidence = acceptanceProbe.collectAcceptanceRecoveryEvidence(audit);
  assert.deepEqual(evidence.recoveries, []);
  assert.deepEqual(evidence.counts, { resumed_child_start: 0, resume_activation: 0 });
  const receipt = createAcceptanceReceipt({ allocations: [ACCEPTANCE_TASKS[0]].map((task) => ({ task: task.name, childId: "child-1", worktree: "/tmp/w", baseCommit: "a".repeat(40) })), audit });
  assert.deepEqual(receipt.recoveries, []);
  assert.deepEqual(receipt.lifecycle, { agent_end: 0, follow_up: 0, next_agent_start: 0, resumed_child_start: 0, resume_activation: 0 });
  assert.equal(JSON.stringify(receipt).includes("session"), false);
});

test("recovery 公共证据：一次成功恢复映射为 recoveries 与 lifecycle 计数", () => {
  const audit = settledAudit();
  audit.queue.resumeIntents = [resumeIntentFixture()];
  assert.equal(acceptanceProbe.isAcceptanceAuditSettled(audit), true);
  const receipt = createAcceptanceReceipt({ allocations: [ACCEPTANCE_TASKS[0]].map((task) => ({ task: task.name, childId: "child-1", worktree: "/tmp/w", baseCommit: "a".repeat(40) })), audit });
  assert.deepEqual(receipt.recoveries, [{
    resumeIntentId: "intent-1", sourceRunId: "run-source-1", resumedRunId: "run-resumed-1",
    workspaceId: "workspace-parse", queueItemId: "queue-1", attempt: 1, generation: 0, state: "completed",
  }]);
  assert.deepEqual(receipt.lifecycle, { agent_end: 0, follow_up: 0, next_agent_start: 0, resumed_child_start: 1, resume_activation: 1 });
  assert.equal(JSON.stringify(receipt).includes("session"), false);
});

test("recovery 公共证据：多 attempt 串行恢复中历史 failed 不阻塞，最新 intent 必须 completed", () => {
  const audit = settledAudit();
  audit.queue.resumeIntents = [
    resumeIntentFixture({ resumeIntentId: "intent-1", attempt: 1, state: "failed", resumedRun: { runId: "run-resumed-1", asyncDir: "/var/tmp/a", sessionId: "s", pid: 1, agentProfile: "executor" } }),
    resumeIntentFixture({ resumeIntentId: "intent-2", attempt: 2, state: "completed", resumedRun: { runId: "run-resumed-2", asyncDir: "/var/tmp/a", sessionId: "s", pid: 2, agentProfile: "executor" } }),
  ];
  assert.equal(acceptanceProbe.isAcceptanceAuditSettled(audit), true);
  const receipt = createAcceptanceReceipt({ allocations: [ACCEPTANCE_TASKS[0]].map((task) => ({ task: task.name, childId: "child-1", worktree: "/tmp/w", baseCommit: "a".repeat(40) })), audit });
  assert.equal(receipt.recoveries.length, 2);
  assert.deepEqual(receipt.lifecycle, { agent_end: 0, follow_up: 0, next_agent_start: 0, resumed_child_start: 2, resume_activation: 1 }, "failed intent 不得计入 resume_activation（activation 未被证明完成）");
});

test("settlement：最新 resume intent 非 completed（preserved/failed/pending/waiting-head/starting/activated）即判定失败并保留现场", () => {
  for (const state of ["preserved", "failed", "pending", "waiting-head", "starting", "activated"]) {
    const audit = settledAudit();
    audit.queue.resumeIntents = [resumeIntentFixture({ state })];
    assert.equal(acceptanceProbe.isAcceptanceAuditSettled(audit), false, `state=${state} 不得 settled`);
  }
  // 同一 queue item 的旧 attempt preserved 但最新 completed 时仍可 settled。
  const recovered = settledAudit();
  recovered.queue.resumeIntents = [
    resumeIntentFixture({ resumeIntentId: "intent-1", attempt: 1, state: "preserved" }),
    resumeIntentFixture({ resumeIntentId: "intent-2", attempt: 2, state: "completed" }),
  ];
  assert.equal(acceptanceProbe.isAcceptanceAuditSettled(recovered), true);
});

test("recovery 公共证据：audit 是磁盘真相，跨 root 的 intent 均可呈现（双 Host 语义）", () => {
  const audit = settledAudit();
  audit.queue.resumeIntents = [
    resumeIntentFixture({ resumeIntentId: "intent-a", ownerScope: { kind: "standalone-subagent", rootSessionId: "root-a" }, queueItemId: "queue-1" }),
    resumeIntentFixture({ resumeIntentId: "intent-b", ownerScope: { kind: "standalone-subagent", rootSessionId: "root-b" }, queueItemId: "queue-2" }),
  ];
  const evidence = acceptanceProbe.collectAcceptanceRecoveryEvidence(audit);
  assert.equal(evidence.recoveries.length, 2);
  assert.deepEqual(evidence.recoveries.map((entry) => entry.resumeIntentId).sort(), ["intent-a", "intent-b"]);
});
