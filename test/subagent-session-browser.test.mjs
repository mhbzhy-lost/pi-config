import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadPiTestRuntime } from "./helpers/pi-runtime.mjs";

const { jiti } = await loadPiTestRuntime(import.meta.url);
const { SubagentSessionBrowserState, projectSessionStatus } = await jiti.import("../packages/pi-subagents-enhanced/src/tui/session-browser.ts");

// 真实 0.71 ping capability envelope，来源：pi-subagents/src/extension/rpc.js:313-316。
const negotiated71 = {
  enabled: { status: true, fleetStatus: true },
  capabilities: {
    statusProjection: { version: 1, untargeted: "in-memory-when-ready", targeted: "executor" },
    fleetStatus: { version: 1 },
    asyncStatusSnapshot: { kind: "pi-subagents.async-status-snapshot", version: 1 },
  },
};

test("projects legacy and 0.71 status schema without rewriting raw status", () => {
  const cases = [
    ["active", "active"], ["queued", "active"], ["running", "active"], ["pending", "active"],
    ["terminal", "terminal"], ["complete", "terminal"], ["completed", "terminal"], ["failed", "terminal"],
    ["rejected", "terminal"], ["detached", "terminal"], ["timed-out", "terminal"],
    ["retained", "active"], ["paused", "terminal"], ["stopped", "terminal"], ["terminal-proof", "terminal"],
  ];
  for (const [status, classification] of cases) {
    const projected = projectSessionStatus(negotiated71, { status });
    assert.equal(projected.classification, classification, status);
    assert.deepEqual(projected.raw, { status });
    assert.equal(projected.status, status);
  }
});

test("projects missing and unknown status as awaiting disposition and preserves raw value", () => {
  for (const raw of [undefined, {}, { state: "future-status", detail: 42 }]) {
    const projected = projectSessionStatus(negotiated71, raw);
    assert.equal(projected.classification, "awaiting-disposition");
    assert.deepEqual(projected.raw, raw);
  }
});

test("uses negotiated status projection and keeps unavailable non-terminal", () => {
  const negotiated = {
    enabled: { status: false, fleetStatus: false },
    capabilities: { statusProjection: false },
  };
  const projected = projectSessionStatus(negotiated, { state: "unavailable" });
  assert.equal(projected.classification, "awaiting-disposition");
  assert.equal(projected.status, "unavailable");
  assert.deepEqual(projected.raw, { state: "unavailable" });

  const minimal = projectSessionStatus(null, { state: "complete" });
  assert.equal(minimal.classification, "terminal");
  assert.equal(minimal.status, "complete");
});

function startRun(state, id, agents = ["executor", "reviewer"]) {
  state.trackStarted({
    id,
    asyncDir: `/tmp/${id}`,
    cwd: "/repo",
    sessionId: "parent-1",
    agents,
  });
}

test("reconciles lifecycle roster with stable child keys", () => {
  const state = new SubagentSessionBrowserState();
  startRun(state, "run-1");

  state.reconcileRun("run-1", {
    state: "running",
    steps: [
      { agent: "executor", status: "complete", transcriptPath: "/repo/.pi-subagents/artifacts/executor.jsonl" },
      { agent: "reviewer", status: "running", transcriptPath: "/repo/.pi-subagents/artifacts/reviewer.jsonl" },
    ],
  });

  assert.deepEqual(
    state.snapshot().children.map(({ key, agent, state: childState }) => ({ key, agent, state: childState })),
    [
      { key: "run-1:0", agent: "executor", state: "complete" },
      { key: "run-1:1", agent: "reviewer", state: "running" },
    ],
  );
});

test("enters, wraps selection, and exits the browser", () => {
  const state = new SubagentSessionBrowserState();
  startRun(state, "run-1");

  assert.equal(state.enter(), true);
  assert.equal(state.snapshot().active, true);
  assert.equal(state.snapshot().selectedKey, "run-1:0");

  state.move(1);
  assert.equal(state.snapshot().selectedKey, "run-1:1");
  state.move(1);
  assert.equal(state.snapshot().selectedKey, "run-1:0");
  state.move(-1);
  assert.equal(state.snapshot().selectedKey, "run-1:1");

  state.exit();
  assert.equal(state.snapshot().active, false);
  assert.equal(state.snapshot().selectedKey, undefined);
});

test("does not enter when no children exist", () => {
  assert.equal(new SubagentSessionBrowserState().enter(), false);
});

test("serializes plain roster data and hydrates it into a fresh inactive state", () => {
  const original = new SubagentSessionBrowserState();
  startRun(original, "persisted", ["executor"]);
  original.reconcileRun("persisted", {
    state: "running",
    steps: [{ agent: "executor", status: "running", label: "Persist me", tokens: { total: 42 } }],
  });

  const plain = original.serialize();
  assert.equal(Object.getPrototypeOf(plain), Object.prototype);
  assert.deepEqual(plain, { version: 1, children: original.snapshot().children });

  const restored = SubagentSessionBrowserState.hydrate(plain);
  assert.notEqual(restored, original);
  assert.equal(restored.snapshot().active, false);
  assert.deepEqual(restored.snapshot().children, original.snapshot().children);
});

test("round-trips active and terminal display order with the same default selection", () => {
  const original = new SubagentSessionBrowserState();
  startRun(original, "terminal-old", ["old"]);
  original.trackCompleted({ runId: "terminal-old", state: "complete" });
  startRun(original, "active", ["active"]);
  startRun(original, "terminal-middle", ["middle"]);
  original.trackCompleted({ runId: "terminal-middle", state: "complete" });
  startRun(original, "terminal-new", ["new"]);
  original.trackCompleted({ runId: "terminal-new", state: "complete" });

  const before = original.snapshot();
  const restored = SubagentSessionBrowserState.hydrate(original.serialize());
  const after = restored.snapshot();

  assert.deepEqual(after.activeChildren, before.activeChildren);
  assert.deepEqual(after.recentChildren, before.recentChildren);
  assert.deepEqual(after.children, before.children);

  const terminalOnly = new SubagentSessionBrowserState();
  for (const runId of ["terminal-old", "terminal-middle", "terminal-new"]) {
    startRun(terminalOnly, runId, [runId]);
    terminalOnly.trackCompleted({ runId, state: "complete" });
  }
  const restoredTerminalOnly = SubagentSessionBrowserState.hydrate(terminalOnly.serialize());
  assert.equal(terminalOnly.enter(), true);
  assert.equal(restoredTerminalOnly.enter(), true);
  assert.equal(restoredTerminalOnly.snapshot().selectedKey, terminalOnly.snapshot().selectedKey);
});

test("hydrates a child session id into its run for later appended steps", () => {
  const restored = SubagentSessionBrowserState.hydrate({
    version: 1,
    children: [{
      key: "persisted:0", runId: "persisted", index: 0, agent: "executor", state: "running",
      asyncDir: "/tmp/persisted", cwd: "/repo", sessionId: "parent-persisted",
    }],
  });

  restored.reconcileRun("persisted", {
    state: "running",
    steps: [
      { agent: "executor", status: "running" },
      { agent: "reviewer", status: "running" },
    ],
  });

  assert.equal(restored.snapshot().children[1].sessionId, "parent-persisted");
});
test("completion retains children and updates their state", () => {
  const state = new SubagentSessionBrowserState();
  startRun(state, "run-1", ["executor"]);

  state.trackCompleted({ runId: "run-1", state: "complete" });

  assert.deepEqual(state.snapshot().children.map(({ key, state: childState }) => ({ key, state: childState })), [
    { key: "run-1:0", state: "complete" },
  ]);
});

test("keeps active runs and evicts the oldest unselected terminal recent run", () => {
  const state = new SubagentSessionBrowserState();
  for (let index = 0; index < 20; index += 1) {
    startRun(state, `terminal-${index}`, ["executor"]);
    state.trackCompleted({ runId: `terminal-${index}`, state: "complete" });
  }
  assert.equal(state.enter(), true);
  assert.equal(state.snapshot().selectedKey, "terminal-19:0");
  startRun(state, "terminal-20", ["executor"]);
  state.trackCompleted({ runId: "terminal-20", state: "complete" });

  for (let index = 0; index < 21; index += 1) startRun(state, `active-${index}`, ["executor"]);

  const children = state.snapshot().children;
  assert.equal(children.some((child) => child.runId === "terminal-19"), true);
  assert.equal(children.some((child) => child.runId === "terminal-0"), false);
  assert.equal(children.filter((child) => child.runId.startsWith("active-")).length, 21);
  assert.equal(state.snapshot().selectedKey, "terminal-19:0");
});

test("exits when reconciliation removes the selected child", () => {
  const state = new SubagentSessionBrowserState();
  startRun(state, "run-1", ["executor"]);
  assert.equal(state.enter(), true);

  state.reconcileRun("run-1", { state: "complete", steps: [] });

  assert.equal(state.snapshot().active, false);
  assert.equal(state.snapshot().selectedKey, undefined);
});

test("preserves a tracked running child when status has no steps", () => {
  const state = new SubagentSessionBrowserState();
  startRun(state, "empty-running", ["executor"]);
  assert.equal(state.enter(), true);

  state.reconcileRun("empty-running", { state: "running", steps: [] });

  assert.equal(state.snapshot().children.length, 1);
  assert.equal(state.snapshot().activeChildren.length, 1);
  assert.equal(state.snapshot().selectedKey, "empty-running:0");
});

test("reconciles appended steps with their run metadata and selection", () => {
  const state = new SubagentSessionBrowserState();
  startRun(state, "run-1", ["executor"]);
  assert.equal(state.enter(), true);

  state.reconcileRun("run-1", {
    state: "running",
    steps: [
      { agent: "executor", status: "running" },
      { agent: "reviewer", status: "running" },
    ],
  });
  state.move(1);

  assert.deepEqual(state.snapshot().selected, {
    key: "run-1:1",
    runId: "run-1",
    index: 1,
    agent: "reviewer",
    state: "running",
    asyncDir: "/tmp/run-1",
    cwd: "/repo",
    sessionId: "parent-1",
  });
});

test("preserves lifecycle step labels", () => {
  const state = new SubagentSessionBrowserState();
  startRun(state, "run-1", ["executor"]);

  state.reconcileRun("run-1", {
    state: "running",
    steps: [{ agent: "executor", status: "running", label: "Check implementation" }],
  });

  assert.equal(state.snapshot().children[0].label, "Check implementation");
});

test("does not downgrade terminal children from a delayed running status", () => {
  const state = new SubagentSessionBrowserState();
  startRun(state, "run-1", ["executor"]);
  state.trackCompleted({ runId: "run-1", state: "complete" });

  state.reconcileRun("run-1", {
    state: "running",
    steps: [{ agent: "executor", status: "running" }],
  });

  assert.equal(state.snapshot().children[0].state, "complete");
});

test("keeps terminal reconciled child facts and visible order after a duplicate start", () => {
  const state = new SubagentSessionBrowserState();
  startRun(state, "older", ["older"]);
  state.trackCompleted({ runId: "older", state: "complete" });
  startRun(state, "terminal", ["executor"]);
  state.reconcileRun("terminal", {
    state: "complete",
    steps: [{
      agent: "executor", status: "complete", sessionFile: "/sessions/terminal.jsonl",
      transcriptPath: "/transcripts/terminal.jsonl", model: "model-a", thinking: "high",
      tokens: { total: 123 }, label: "Reconciled terminal child",
    }],
  });
  const before = state.snapshot();

  startRun(state, "terminal", ["executor"]);

  assert.deepEqual(state.snapshot().children, before.children);
  assert.deepEqual(state.snapshot().recentChildren, before.recentChildren);
});

test("keeps active multi-child facts and ordering after a duplicate start", () => {
  const state = new SubagentSessionBrowserState();
  startRun(state, "first", ["first"]);
  startRun(state, "multi", ["executor", "reviewer"]);
  state.reconcileRun("multi", {
    state: "running",
    steps: [
      { agent: "executor", status: "complete", label: "Finished", sessionFile: "/sessions/executor.jsonl", tokens: { total: 55 } },
      { agent: "reviewer", status: "running", transcriptPath: "/transcripts/reviewer.jsonl", model: "model-b", thinking: "low" },
    ],
  });
  startRun(state, "last", ["last"]);
  const before = state.snapshot();

  startRun(state, "multi", ["executor", "reviewer"]);

  assert.deepEqual(state.snapshot().children, before.children);
  assert.deepEqual(state.snapshot().activeChildren, before.activeChildren);
});

test("final per-step terminal statuses correct an earlier async-complete summary", () => {
  const state = new SubagentSessionBrowserState();
  startRun(state, "mixed-run", ["executor", "reviewer"]);

  state.trackCompleted({ runId: "mixed-run", state: "failed" });
  state.reconcileRun("mixed-run", {
    state: "failed",
    steps: [
      { agent: "executor", status: "completed" },
      { agent: "reviewer", status: "failed" },
    ],
  });

  assert.deepEqual(state.snapshot().children.map((child) => child.state), ["completed", "failed"]);
});

test("keeps active pi-subagents states out of the recent cap and allows them to settle", () => {
  for (const activeState of ["queued", "running", "pending"]) {
    const state = new SubagentSessionBrowserState();
    startRun(state, `settling-${activeState}`, ["executor"]);
    state.reconcileRun(`settling-${activeState}`, {
      state: activeState,
      steps: [{ agent: "executor", status: activeState }],
    });
    state.reconcileRun(`settling-${activeState}`, {
      state: "complete",
      steps: [{ agent: "executor", status: "complete" }],
    });
    assert.equal(state.snapshot().children[0].state, "complete");

    startRun(state, `active-${activeState}`, ["executor"]);
    state.reconcileRun(`active-${activeState}`, {
      state: activeState,
      steps: [{ agent: "executor", status: activeState }],
    });
    for (let index = 0; index < 21; index += 1) {
      startRun(state, `complete-${activeState}-${index}`, ["executor"]);
      state.trackCompleted({ runId: `complete-${activeState}-${index}`, state: "complete" });
    }

    assert.equal(state.snapshot().children.some((child) => child.runId === `active-${activeState}`), true);
  }
});

test("treats all pi-subagents terminal states as recent and immutable", () => {
  for (const terminalState of ["complete", "completed", "failed", "paused", "stopped", "rejected", "detached", "timed-out"]) {
    const state = new SubagentSessionBrowserState();
    for (let index = 0; index < 21; index += 1) {
      const runId = `${terminalState}-${index}`;
      startRun(state, runId, ["executor"]);
      state.reconcileRun(runId, {
        state: terminalState,
        steps: [{ agent: "executor", status: terminalState }],
      });
    }

    const children = state.snapshot().children;
    assert.equal(children.some((child) => child.runId === `${terminalState}-0`), false, terminalState);
    assert.equal(children.filter((child) => child.runId.startsWith(`${terminalState}-`)).length, 20, terminalState);

    state.reconcileRun(`${terminalState}-1`, {
      state: "running",
      steps: [{ agent: "executor", status: "running" }],
    });
    assert.equal(state.snapshot().children.find((child) => child.runId === `${terminalState}-1`)?.state, terminalState);
  }
});

test("persists session files and exposes defensive active and recent partitions", () => {
  const state = new SubagentSessionBrowserState();
  startRun(state, "run-active", ["executor"]);
  startRun(state, "run-done", ["reviewer"]);

  state.reconcileRun("run-active", {
    state: "running",
    steps: [{
      agent: "executor", status: "running",
      sessionFile: "/repo/var/sessions/run-active/session.jsonl",
      transcriptPath: "/repo/.pi-subagents/artifacts/active.jsonl",
    }],
  });
  state.reconcileRun("run-done", {
    state: "complete",
    steps: [{
      agent: "reviewer", status: "completed",
      sessionFile: "/repo/var/sessions/run-done/session.jsonl",
      transcriptPath: "/repo/.pi-subagents/artifacts/done.jsonl",
    }],
  });

  const snapshot = state.snapshot();
  assert.deepEqual(snapshot.activeChildren.map((child) => child.agent), ["executor"]);
  assert.deepEqual(snapshot.recentChildren.map((child) => child.agent), ["reviewer"]);
  assert.deepEqual(snapshot.children.map((child) => child.agent), ["executor", "reviewer"]);
  assert.equal(snapshot.recentChildren[0].sessionFile, "/repo/var/sessions/run-done/session.jsonl");
  snapshot.activeChildren[0].agent = "mutated";
  assert.equal(state.snapshot().activeChildren[0].agent, "executor");
  const serialized = state.serialize();
  serialized.children[0].agent = "mutated";
  assert.equal(state.snapshot().children[0].agent, "executor");
});

test("orders active workflow order before newest terminal runs and enters the priority child", () => {
  const state = new SubagentSessionBrowserState();
  startRun(state, "done-old", ["old"]);
  state.trackCompleted({ runId: "done-old", state: "complete" });
  startRun(state, "active-first", ["first"]);
  startRun(state, "done-new", ["new"]);
  state.trackCompleted({ runId: "done-new", state: "complete" });
  startRun(state, "active-second", ["second"]);

  const snapshot = state.snapshot();
  assert.deepEqual(snapshot.activeChildren.map((child) => child.agent), ["first", "second"]);
  assert.deepEqual(snapshot.recentChildren.map((child) => child.agent), ["new", "old"]);
  assert.deepEqual(snapshot.children.map((child) => child.agent), ["first", "second", "new", "old"]);
  assert.equal(state.enter(), true);
  assert.equal(state.snapshot().selectedKey, "active-first:0");

  const recentOnly = new SubagentSessionBrowserState();
  startRun(recentOnly, "old", ["old"]);
  recentOnly.trackCompleted({ runId: "old", state: "complete" });
  startRun(recentOnly, "new", ["new"]);
  recentOnly.trackCompleted({ runId: "new", state: "complete" });
  assert.equal(recentOnly.enter(), true);
  assert.equal(recentOnly.snapshot().selectedKey, "new:0");
});

test("keeps a selected terminal child selected after completion", () => {
  const state = new SubagentSessionBrowserState();
  startRun(state, "run-1", ["executor"]);
  assert.equal(state.enter(), true);

  state.trackCompleted({ runId: "run-1", state: "complete" });

  assert.equal(state.snapshot().active, true);
  assert.equal(state.snapshot().selectedKey, "run-1:0");
  assert.equal(state.snapshot().selected?.state, "complete");
});

test("retains selected colon-containing terminal run IDs under the recent cap", () => {
  const state = new SubagentSessionBrowserState();
  const selectedRunId = "parent:child:run";
  startRun(state, selectedRunId, ["executor"]);
  state.trackCompleted({ runId: selectedRunId, state: "complete" });
  assert.equal(state.enter(), true);

  for (let index = 0; index < 20; index += 1) {
    const runId = `terminal-${index}`;
    startRun(state, runId, ["executor"]);
    state.trackCompleted({ runId, state: "complete" });
  }

  assert.equal(state.snapshot().children.some((child) => child.runId === selectedRunId), true);
  assert.equal(state.snapshot().recentChildren.length, 20);
  assert.equal(state.snapshot().selectedKey, `${selectedRunId}:0`);
});

test("retains presentation separately from raw lifecycle through completion and legacy hydrate", () => {
  const state = new SubagentSessionBrowserState();
  startRun(state, "report-run", ["executor"]);
  state.trackCompleted({ runId: "report-run", state: "failed", outputState: "RED", output: "tests-only RED" });
  assert.equal(state.snapshot().children[0].state, "failed");
  assert.equal(state.snapshot().children[0].presentation, "reported");
  const legacy = SubagentSessionBrowserState.hydrate({ version: 1, children: [{ key: "old:0", runId: "old", index: 0, agent: "executor", state: "failed", asyncDir: "/tmp/old", cwd: "/repo" }] });
  assert.equal(legacy.snapshot().children[0].presentation, undefined);
});

test("hydrates only known presentation values", () => {
  const state = SubagentSessionBrowserState.hydrate({ version: 1, children: [{
    key: "old:0", runId: "old", index: 0, agent: "executor", state: "completed", presentation: "unknown",
    asyncDir: "/tmp/old", cwd: "/repo",
  }] });
  assert.equal(state.snapshot().children[0].presentation, undefined);
});

test("projects normalized result status and presentation to each child without rewriting lifecycle state", () => {
  const state = new SubagentSessionBrowserState();
  startRun(state, "normalized", ["executor", "reviewer"]);
  state.trackCompleted({
    runId: "normalized", state: "failed", results: [
      { status: "completed", success: true, outputState: "present" },
      { status: "failed", outputState: "absent", protocolError: "bad frame" },
    ],
  });
  assert.deepEqual(state.snapshot().children.map(({ state: raw, presentation }) => ({ raw, presentation })), [
    { raw: "completed", presentation: "completed" },
    { raw: "failed", presentation: "runtime-failed" },
  ]);
});

test("projects real completion results to each child without rewriting lifecycle state", () => {
  const state = new SubagentSessionBrowserState();
  startRun(state, "mixed", ["executor", "reviewer"]);
  state.trackCompleted({
    runId: "mixed", state: "failed", success: false, summary: "mixed completion",
    results: [
      { state: "failed", outputState: "present", summary: "TDD RED", acceptance: { status: "rejected" } },
      { state: "rejected", outputState: "absent", protocolError: "bad frame" },
    ],
  });
  assert.deepEqual(state.snapshot().children.map(({ state: raw, presentation }) => ({ raw, presentation })), [
    { raw: "failed", presentation: "reported" },
    { raw: "rejected", presentation: "runtime-failed" },
  ]);
});

// typed 派发的 root facade 完成：run 级 state 终局，逐 child 条目携带 detach 时刻 state:"running"
// （上游 subagent-executor.js workflowResultChildren）。两条消费路径都必须让 run 级终局兜底
// child 级非终局，否则 root 条目被自己的完成事件锁死在运行区（bug #1）。
test("run-level terminal completion settles children whose facade result is frozen at running", () => {
  const state = new SubagentSessionBrowserState();
  startRun(state, "facade-complete", ["delegate"]);

  state.trackCompleted({ runId: "facade-complete", state: "complete", results: [{ state: "running" }] });

  const snapshot = state.snapshot();
  assert.equal(snapshot.children[0].state, "complete");
  assert.equal(snapshot.activeChildren.length, 0);
  assert.equal(snapshot.recentChildren.length, 1);
});

test("run-level terminal reconcile settles frozen running step status and later polls do not resurrect it", () => {
  const state = new SubagentSessionBrowserState();
  startRun(state, "facade-poll", ["delegate"]);
  const facadeStatus = {
    state: "complete",
    steps: [{ agent: "delegate", status: "running", label: "typed-facade", runId: "leaf-run", async: true }],
  };

  state.reconcileRun("facade-poll", facadeStatus);
  assert.equal(state.snapshot().children[0].state, "complete");
  assert.equal(state.snapshot().activeChildren.length, 0);
  assert.equal(state.snapshot().recentChildren.length, 1);

  state.reconcileRun("facade-poll", facadeStatus);
  assert.equal(state.snapshot().children[0].state, "complete");
  assert.equal(state.snapshot().activeChildren.length, 0);
});

// root facade 容器 steps 从不携带 model/thinking/tokens（spawn 时刻定格），数据在邻接 leaf
// run 的 status.json steps 里完整存在（bug #2/#3）。reconcileRun 必须经 step.runId 解析
// 同一 runs 根下邻接 leaf 的 status 补齐投影。
test("reconcile projects facade model, thinking, and tokens from the adjacent leaf status", (t) => {
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "footer-facade-runs-"));
  t.after(() => { fs.rmSync(runsRoot, { recursive: true, force: true }); });
  const rootDir = path.join(runsRoot, "facade-root-run");
  const leafDir = path.join(runsRoot, "facade-leaf-run");
  fs.mkdirSync(rootDir);
  fs.mkdirSync(leafDir);
  fs.writeFileSync(path.join(leafDir, "status.json"), JSON.stringify({
    state: "complete",
    steps: [{
      agent: "delegate", status: "completed",
      model: "qoder-pool/GLM-5.3-0.6x:high", thinking: "high",
      tokens: { input: 956232, output: 66034, total: 1022266 },
    }],
  }));

  const state = new SubagentSessionBrowserState();
  state.trackStarted({ id: "facade-root-run", asyncDir: rootDir, cwd: "/repo", agent: "workflow" });
  state.reconcileRun("facade-root-run", {
    state: "complete",
    steps: [{ agent: "delegate", status: "running", label: "typed-facade", runId: "facade-leaf-run", async: true }],
  });

  const child = state.snapshot().children[0];
  assert.equal(child.state, "complete");
  assert.equal(child.model, "qoder-pool/GLM-5.3-0.6x:high");
  assert.equal(child.thinking, "high");
  assert.equal(child.tokens, 1022266);
});

test("facade leaf resolution is confined to the adjacent runs root", (t) => {
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "footer-facade-confined-"));
  const escapeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "footer-facade-escape-"));
  t.after(() => {
    fs.rmSync(runsRoot, { recursive: true, force: true });
    fs.rmSync(escapeRoot, { recursive: true, force: true });
  });
  const rootDir = path.join(runsRoot, "facade-root-run");
  fs.mkdirSync(rootDir);
  fs.writeFileSync(path.join(escapeRoot, "status.json"), JSON.stringify({
    state: "complete",
    steps: [{ agent: "delegate", status: "completed", model: "escape-pool/escaped-model:high", thinking: "high", tokens: { total: 1 } }],
  }));

  const state = new SubagentSessionBrowserState();
  state.trackStarted({ id: "facade-root-run", asyncDir: rootDir, cwd: "/repo", agent: "workflow" });
  state.reconcileRun("facade-root-run", {
    state: "running",
    steps: [{ agent: "delegate", status: "running", runId: `../${path.basename(escapeRoot)}` }],
  });

  const child = state.snapshot().children[0];
  assert.equal(child.model, undefined);
  assert.equal(child.thinking, undefined);
  assert.equal(child.tokens, undefined);
});

const lifecycle = JSON.parse(fs.readFileSync(new URL('./fixtures/trial-browser-lifecycle.json', import.meta.url), 'utf8'));
function trialPair(order = 'root-first') {
  let state = new SubagentSessionBrowserState();
  const root = () => { state.trackStarted(lifecycle.rootStarted); state.reconcileRun('trial-root', lifecycle.rootStatus); state.trackCompleted(lifecycle.rootComplete); };
  const leaf = () => { state.trackStarted(lifecycle.leafStarted); state.reconcileRun('trial-leaf', lifecycle.leafStatus); };
  if (order === 'leaf-first') { leaf(); state = SubagentSessionBrowserState.hydrate(state.serialize()); root(); }
  else { root(); leaf(); }
  return state;
}
function pressure(state, prefix, afterEach = () => {}) {
  for (let index = 0; index < 21; index++) {
    const id = `${prefix}-${index}`;
    startRun(state, id, ['executor']);
    state.trackCompleted({ runId: id, state: 'complete' });
    afterEach();
  }
}

for (const order of ['root-first', 'leaf-first']) {
  test(`canonical ${order} retains actual leaf state, metadata, raw persistence and defensive copies`, () => {
    const before = structuredClone(lifecycle);
    const state = trialPair(order);
    const snapshot = state.snapshot();
    assert.deepEqual(snapshot.children.map(c => c.key), ['trial-leaf:0']);
    assert.equal(snapshot.activeChildren.length, 1);
    assert.equal(snapshot.recentChildren.length, 0);
    assert.equal(snapshot.children[0].state, 'running');
    assert.equal(snapshot.children[0].label, '审阅任务');
    assert.equal(snapshot.children[0].model, 'fixture/reviewer');
    assert.equal(snapshot.children[0].tokens, 4321);
    assert.equal(snapshot.children[0].sessionFile, lifecycle.leafStatus.steps[0].sessionFile);
    const persisted = state.serialize();
    assert.equal(persisted.children.length, 2);
    assert.equal(persisted.children.find(c => c.runId === 'trial-root').facadeLeafRunId, 'trial-leaf');
    assert.deepEqual(SubagentSessionBrowserState.hydrate(persisted).snapshot().children, snapshot.children);
    const tracked = state.trackedRuns();
    assert.deepEqual(new Set(tracked.map(r => r.id)), new Set(['trial-root','trial-leaf']));
    tracked[0].id = 'tampered'; snapshot.children[0].agent = 'tampered'; persisted.children[0].workflowKey = 'tampered';
    assert.equal(state.trackedRuns().some(r => r.id === 'tampered'), false);
    assert.equal(state.snapshot().children[0].agent, 'reviewer');
    state.trackCompleted(lifecycle.leafComplete);
    assert.deepEqual(state.snapshot().recentChildren.map(c => c.key), ['trial-leaf:0']);
    assert.equal(state.snapshot().activeChildren.length, 0);
    assert.deepEqual(SubagentSessionBrowserState.hydrate(state.serialize()).snapshot().children, state.snapshot().children);
    assert.deepEqual(lifecycle, before);
  });
}

test('canonical selected workflow placeholder migrates through reviewer step without exiting', () => {
  const state = new SubagentSessionBrowserState();
  state.trackStarted(lifecycle.rootStarted);
  assert.equal(state.snapshot().children[0].agent, 'workflow');
  state.enter();
  state.reconcileRun('trial-root', lifecycle.rootStatus);
  assert.equal(state.snapshot().selected.agent, 'reviewer');
  state.trackCompleted(lifecycle.rootComplete);
  state.trackStarted(lifecycle.leafStarted);
  state.reconcileRun('trial-leaf', lifecycle.leafStatus);
  assert.equal(state.snapshot().active, true);
  assert.equal(state.snapshot().selectedKey, 'trial-leaf:0');
  assert.equal(state.snapshot().selected.state, 'running');
});

test('canonical relation requires explicit matching parent/key/session/agent/single and never sessionFile or label alone', () => {
  const cases = [
    f => { delete f.rootStatus.steps[0].runId; },
    f => { delete f.rootStatus.steps[0].workflowKey; },
    f => { f.leafStarted.parentWorkflowRunId = f.leafStatus.parentWorkflowRunId = 'other'; },
    f => { delete f.leafStarted.parentWorkflowRunId; delete f.leafStatus.parentWorkflowRunId; },
    f => { f.leafStarted.workflowKey = f.leafStatus.workflowKey = 'other'; },
    f => { delete f.leafStarted.workflowKey; delete f.leafStatus.workflowKey; },
    f => { f.leafStarted.sessionId = 'other'; },
    f => { delete f.rootStarted.sessionId; },
    f => { delete f.leafStarted.sessionId; },
    f => { f.leafStarted.agent = f.leafStatus.steps[0].agent = 'executor'; },
    f => { delete f.leafStarted.mode; delete f.leafStatus.mode; },
    f => { f.leafStarted.mode = f.leafStatus.mode = 'workflow'; },
    f => { f.leafStatus.steps.push({...f.leafStatus.steps[0]}); },
  ];
  for (const mutate of cases) {
    const f = structuredClone(lifecycle); mutate(f);
    const state = new SubagentSessionBrowserState();
    state.trackStarted(f.rootStarted); state.reconcileRun('trial-root',f.rootStatus);
    state.trackStarted(f.leafStarted); state.reconcileRun('trial-leaf',f.leafStatus);
    assert.equal(state.snapshot().children.some(c => c.key === 'trial-root:0'), true);
  }
  const state = trialPair();
  state.trackStarted({...lifecycle.leafStarted, id:'resume', parentWorkflowRunId:undefined, workflowKey:undefined});
  state.reconcileRun('resume',{...lifecycle.leafStatus, runId:'resume', parentWorkflowRunId:undefined, workflowKey:undefined});
  assert.deepEqual(state.snapshot().children.map(c => c.key), ['trial-leaf:0','resume:0']);
});

test('canonical history eviction never splits a leaf-first confirmed component under 21 terminal runs', () => {
  const state = trialPair('leaf-first');
  state.trackCompleted(lifecycle.leafComplete);
  pressure(state, 'history', () => {
    assert.equal(state.snapshot().children.some(c => c.key === 'trial-root:0'), false);
    const ids = state.trackedRuns().map(r => r.id);
    assert.equal(ids.includes('trial-root'), ids.includes('trial-leaf'));
    const restored = SubagentSessionBrowserState.hydrate(state.serialize());
    assert.equal(restored.snapshot().children.some(c => c.key === 'trial-root:0'), false);
  });
  assert.equal(state.trackedRuns().some(r => r.id === 'trial-root' || r.id === 'trial-leaf'), false);
  assert.equal(state.trackedRuns().length, 20);
});

test('facade dispatch completion retains raw root for live/selected leaf, later steps and exit budget convergence', () => {
  const state = trialPair();
  pressure(state, 'live');
  assert.equal(state.trackedRuns().some(r => r.id === 'trial-root'), true);
  assert.deepEqual(state.snapshot().activeChildren.map(c => c.key), ['trial-leaf:0']);
  const rootStatus = structuredClone(lifecycle.rootStatus);
  rootStatus.steps.push({...rootStatus.steps[0], runId:'second', workflowKey:'second-key'});
  state.reconcileRun('trial-root',rootStatus);
  assert.equal(state.snapshot().children.some(c => c.key === 'trial-root:1'), true);
  state.trackStarted({...lifecycle.leafStarted, id:'second', workflowKey:'second-key'});
  state.reconcileRun('second',{...lifecycle.leafStatus, runId:'second', workflowKey:'second-key'});
  assert.equal(state.snapshot().children.some(c => c.runId === 'trial-root'), false);
  state.enter();
  assert.equal(state.snapshot().selectedKey, 'trial-leaf:0');
  state.trackCompleted(lifecycle.leafComplete);
  state.trackCompleted({runId:'second',state:'complete'});
  pressure(state, 'selected');
  assert.equal(state.trackedRuns().some(r => r.id === 'trial-root'), true);
  assert.equal(state.trackedRuns().some(r => r.id === 'trial-leaf'), true);
  state.exit();
  assert.ok(state.trackedRuns().length <= 20);
  pressure(state, 'released');
  assert.equal(state.trackedRuns().some(r => ['trial-root','trial-leaf','second'].includes(r.id)), false);
  assert.equal(state.trackedRuns().length, 20);
});

test('canonical trim does not protect an unconfirmed mismatching parent relation', () => {
  const state = new SubagentSessionBrowserState();
  state.trackStarted(lifecycle.rootStarted); state.reconcileRun('trial-root',lifecycle.rootStatus);
  state.trackStarted({...lifecycle.leafStarted,workflowKey:'conflict'});
  state.reconcileRun('trial-leaf',{...lifecycle.leafStatus,workflowKey:'conflict'});
  pressure(state,'unconfirmed');
  assert.equal(state.trackedRuns().some(r => r.id === 'trial-root'), false);
  assert.equal(state.trackedRuns().some(r => r.id === 'trial-leaf'), true);
});

test('canonical selected large component exceeds budget only until exit, then disappears without tombstones', () => {
  const state = new SubagentSessionBrowserState();
  state.trackStarted(lifecycle.rootStarted);
  const steps = Array.from({length:21}, (_,i) => ({...lifecycle.rootStatus.steps[0],runId:`large-${i}`,workflowKey:`large-key-${i}`}));
  state.reconcileRun('trial-root',{...lifecycle.rootStatus,steps});
  for (let i=0;i<21;i++) {
    state.trackStarted({...lifecycle.leafStarted,id:`large-${i}`,workflowKey:`large-key-${i}`});
  }
  state.enter();
  for (let i=0;i<21;i++) state.trackCompleted({runId:`large-${i}`,state:'complete'});
  assert.equal(state.trackedRuns().length,22);
  assert.equal(state.snapshot().selectedKey,'large-0:0');
  state.exit();
  assert.equal(state.trackedRuns().length,0);
  assert.equal(state.serialize().children.length,0);
  state.trackStarted(lifecycle.rootStarted);
  assert.equal(state.snapshot().children[0].agent,'workflow');
});
