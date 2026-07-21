import assert from "node:assert/strict";
import test from "node:test";
import { createPlanCoordinator } from "../scripts/lib/plan/coordinator.mjs";
import { applyEvent, createProjection } from "../scripts/lib/plan/plan-events.mjs";

function plan() {
  return {
    title: "Test Plan",
    tasks: [{ id: "task-1", title: "First", deps: [], files: ["a.mjs"] }],
    verification: ["true"],
    sha256: "a".repeat(64),
  };
}

function createdEntries() {
  return [{
    schemaVersion: "pi-plan-event.v1",
    eventId: "e1",
    planId: "plan-1",
    occurredAt: new Date().toISOString(),
    type: "plan.created",
    data: {
      workspace: { originRoot: "/origin", worktree: "/worktree", baseCommit: "base", headCommit: "head", planPath: "/plan.md", planHash: "a".repeat(64) },
      tasks: ["task-1"],
    },
  }];
}

test("authorizeNestedSubagent error includes field-level mismatch details", () => {
  const entries = createdEntries();
  const appended = [];
  const { coordinator } = createPlanCoordinator({
    plan: plan(),
    entries,
    append: (e) => appended.push(e),
  });

  const { tool } = coordinator.authorizeNext();
  // tool has: agent, task, cwd, context, async, clarify, acceptance

  // Simulate what the model sends: missing clarify, different cwd
  const modelCall = {
    agent: tool.agent,
    task: tool.task,
    cwd: "/wrong/path",
    context: tool.context,
    async: tool.async,
    // clarify is missing (undefined)
    acceptance: "none",
  };

  try {
    coordinator.authorizeNestedSubagent(modelCall);
    assert.fail("should throw");
  } catch (error) {
    // Error message should include field-level details
    assert.match(error.message, /cwd/i, "should mention the mismatched field 'cwd'");
    assert.match(error.message, /clarify/i, "should mention the mismatched field 'clarify'");
    // Should show expected vs actual
    assert.match(error.message, /\/worktree/i, "should show expected cwd value");
    assert.match(error.message, /\/wrong\/path/i, "should show actual cwd value");
    assert.match(error.message, /false/, "should show expected clarify value");
  }
});

test("authorizeNestedSubagent passes when all compared fields match", () => {
  const entries = createdEntries();
  const appended = [];
  const { coordinator } = createPlanCoordinator({
    plan: plan(),
    entries,
    append: (e) => appended.push(e),
  });

  const { tool } = coordinator.authorizeNext();

  const modelCall = {
    agent: tool.agent,
    task: "different task text is fine",
    cwd: tool.cwd,
    context: tool.context,
    async: tool.async,
    clarify: tool.clarify,
    acceptance: "whatever",
  };

  assert.equal(coordinator.authorizeNestedSubagent(modelCall), true);
});

test("authorizeNestedSubagent error is actionable for single field mismatch", () => {
  const entries = createdEntries();
  const appended = [];
  const { coordinator } = createPlanCoordinator({
    plan: plan(),
    entries,
    append: (e) => appended.push(e),
  });

  const { tool } = coordinator.authorizeNext();

  // Only clarify is wrong
  const modelCall = {
    agent: tool.agent,
    task: tool.task,
    cwd: tool.cwd,
    context: tool.context,
    async: tool.async,
    // clarify omitted
  };

  try {
    coordinator.authorizeNestedSubagent(modelCall);
    assert.fail("should throw");
  } catch (error) {
    assert.match(error.message, /clarify/);
    assert.match(error.message, /false/);
    // Should NOT mention fields that matched
    assert.doesNotMatch(error.message, /\bagent\b.*mismatch/i);
    assert.doesNotMatch(error.message, /\bcwd\b.*mismatch/i);
  }
});
