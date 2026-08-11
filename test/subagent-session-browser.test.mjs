import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { SubagentSessionBrowserState } = await jiti.import("../pi/extensions/lib/subagent-session-browser.ts");

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

  state.reconcileRun("run-1", { state: "running", steps: [] });

  assert.equal(state.snapshot().active, false);
  assert.equal(state.snapshot().selectedKey, undefined);
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
