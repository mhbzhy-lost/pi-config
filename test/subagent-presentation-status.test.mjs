import assert from "node:assert/strict";
import test from "node:test";
import { classifySubagentPresentation } from "../scripts/lib/subagent-dispatch/presentation-status.ts";

test("classifies normal non-success reports without runtime failure", () => {
  const completed = (child) => ({ state: "failed", success: false, summary: "completion", results: [child] });
  for (const event of [
    completed({ outputState: "present", acceptance: { status: "rejected" }, summary: "tests-only RED" }),
    completed({ outputState: "present", summary: "NEEDS_CONTEXT" }),
    completed({ outputState: "present", acceptance: { status: "rejected" }, summary: "cannot complete" }),
  ]) assert.notEqual(classifySubagentPresentation(event), "runtime-failed");
  assert.equal(classifySubagentPresentation(completed({ outputState: "present", acceptance: { status: "rejected" }, summary: "tests-only RED" })), "reported");
  assert.equal(classifySubagentPresentation(completed({ outputState: "present", summary: "NEEDS_CONTEXT" })), "needs-context");
  assert.equal(classifySubagentPresentation(completed({ outputState: "present", acceptance: { status: "rejected" }, summary: "cannot complete" })), "reported");
});

test("classifies limits, interruption, and unavailable-report runtime faults structurally", () => {
  assert.equal(classifySubagentPresentation({ timedOut: true }), "limited");
  assert.equal(classifySubagentPresentation({ turnBudgetExceeded: true }), "limited");
  assert.equal(classifySubagentPresentation({ stopped: true }), "stopped");
  assert.equal(classifySubagentPresentation({ interrupted: true }), "paused");
  assert.equal(classifySubagentPresentation({ protocolError: "bad frame" }), "runtime-failed");
  assert.equal(classifySubagentPresentation({ processSignal: "SIGKILL" }), "runtime-failed");
  assert.equal(classifySubagentPresentation({ outputState: "absent", error: "worker crashed" }), "runtime-failed");
  assert.equal(classifySubagentPresentation({ usageBudget: { exhausted: true } }), "limited");
  assert.equal(classifySubagentPresentation({ state: "failed", output: "usable report" }), "reported");
});

test("classifies normalized status completion children and preserves higher-priority faults", () => {
  const completed = { status: "completed", success: true, outputState: "present" };
  assert.equal(classifySubagentPresentation({ state: "failed", results: [completed] }), "completed");
  assert.equal(classifySubagentPresentation({ state: "failed", results: [{ ...completed, timedOut: true }] }), "limited");
  assert.equal(classifySubagentPresentation({ state: "failed", results: [{ ...completed, protocolError: "bad frame" }] }), "runtime-failed");
  assert.equal(classifySubagentPresentation({ timedOut: true, results: [completed] }), "limited");
  assert.equal(classifySubagentPresentation({ stopped: true, results: [completed] }), "stopped");
  assert.equal(classifySubagentPresentation({ paused: true, results: [completed] }), "paused");
});

test("classifies real pi-subagents completion children rather than aggregate lifecycle", () => {
  const completion = {
    state: "failed", success: false, summary: "two children settled",
    results: [
      { state: "failed", outputState: "present", summary: "TDD remains RED", acceptance: { status: "rejected" } },
      { state: "rejected", outputState: "present", summary: "NEEDS_CONTEXT" },
      { state: "failed", outputState: "absent", protocolError: "bad frame" },
      { state: "failed", timedOut: true },
    ],
  };
  assert.equal(classifySubagentPresentation({ ...completion, results: [completion.results[0]] }), "reported");
  assert.equal(classifySubagentPresentation({ ...completion, results: [completion.results[1]] }), "needs-context");
  assert.equal(classifySubagentPresentation({ ...completion, results: [completion.results[2]] }), "runtime-failed");
  assert.equal(classifySubagentPresentation({ ...completion, results: [completion.results[3]] }), "limited");
  assert.equal(classifySubagentPresentation({ state: "failed", success: false, summary: "unknown" }), "reported");
  assert.equal(classifySubagentPresentation({ state: "rejected", success: false, summary: "unknown" }), "reported");
});
