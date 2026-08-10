import assert from "node:assert/strict";
import test from "node:test";
import {
  buildContinuityCheckpoint,
  buildDiscovery,
  buildSessionBinding,
  formatRecoveryInjection,
  selectContinuityCandidate,
} from "../scripts/lib/goal-engine/continuity.mjs";

function goal(overrides = {}) {
  return {
    goalId: "goal-1",
    lifecycle: "active",
    epoch: 1,
    version: 4,
    scope: ["src/**"],
    tasks: new Map([["t1", { writePaths: ["src/a.ts"] }]]),
    sessionBindings: [],
    continuity: { observations: {}, lastCheckpoint: null },
    nextAction: null,
    updatedAt: "2026-08-05T00:00:00.000Z",
    ...overrides,
  };
}

test("selects the unique active goal before path-based completed candidates", () => {
  const active = goal({ goalId: "active" });
  const completed = goal({ goalId: "completed", lifecycle: "completed", updatedAt: "2026-08-06T00:00:00.000Z" });

  assert.deepEqual(selectContinuityCandidate({
    projections: [completed, active], cwd: "/repo", paths: ["/repo/unrelated.txt"], sessionId: "session-1",
  }), { status: "selected", goalId: "active", reason: "unique_active" });
});

test("does not select an active goal detached by the current session", () => {
  const detached = goal({
    goalId: "detached-active", lifecycle: "active",
    sessionBindings: [{ sessionId: "session-1", state: "detached" }],
  });

  assert.deepEqual(selectContinuityCandidate({
    projections: [detached], cwd: "/repo", paths: [], sessionId: "session-1",
  }), { status: "none", reason: "no_related_goal" });
});

test("selects only a completed goal watched by the same session and ignores detached bindings", () => {
  const watching = goal({
    goalId: "watching", lifecycle: "completed",
    sessionBindings: [{ sessionId: "session-1", state: "watching" }],
  });
  const detached = goal({
    goalId: "detached", lifecycle: "completed",
    sessionBindings: [{ sessionId: "session-1", state: "detached" }],
  });

  assert.deepEqual(selectContinuityCandidate({
    projections: [watching, detached], cwd: "/repo", paths: [], sessionId: "session-1",
  }), { status: "selected", goalId: "watching", reason: "bound_completed" });
  assert.deepEqual(selectContinuityCandidate({
    projections: [detached], cwd: "/repo", paths: [], sessionId: "session-1",
  }), { status: "none", reason: "no_related_goal" });
});

test("fails closed on multiple candidates and ignores unrelated paths", () => {
  assert.deepEqual(selectContinuityCandidate({
    projections: [goal({ goalId: "b" }), goal({ goalId: "a" })], cwd: "/repo", paths: [], sessionId: "session-1",
  }), { status: "ambiguous", goalIds: ["a", "b"], reason: "multiple_active" });

  const completedA = goal({ goalId: "done-a", lifecycle: "completed", scope: ["src/**"] });
  const completedB = goal({ goalId: "done-b", lifecycle: "completed", scope: [], tasks: new Map([["t", { writePaths: ["src/nested/**"] }]]) });
  assert.deepEqual(selectContinuityCandidate({
    projections: [completedB, completedA], cwd: "/repo", paths: ["/repo/src/nested/file.ts"], sessionId: "other",
  }), { status: "ambiguous", goalIds: ["done-a", "done-b"], reason: "multiple_path_matches" });
  assert.deepEqual(selectContinuityCandidate({
    projections: [completedA], cwd: "/repo", paths: ["/repo/docs/readme.md"], sessionId: "other",
  }), { status: "none", reason: "no_related_goal" });
});

test("builds deterministic idempotent discoveries with credential redaction and byte bounds", () => {
  const input = {
    userText: `Fix auth. Authorization: Bearer secret-value Cookie: sid=private API_TOKEN=abc PRIVATE_KEY=xyz ${"x".repeat(5000)}`,
    userEntryId: "entry-1",
    paths: ["src/b.ts", "src/b.ts"],
    sessionId: "session-1",
    source: "user_intent",
  };
  const first = buildDiscovery(input);
  const second = buildDiscovery(input);

  assert.deepEqual(first, second);
  assert.match(first.id, /^obs-[a-f0-9]{24}$/);
  assert.deepEqual(first.paths, ["src/b.ts"]);
  assert.equal(first.userEntryId, "entry-1");
  assert.ok(Buffer.byteLength(JSON.stringify(first), "utf8") <= 2048);
  assert.doesNotMatch(JSON.stringify(first), /secret-value|sid=private|API_TOKEN=abc|PRIVATE_KEY=xyz/);
  assert.match(first.summary, /\[REDACTED\]/);
  assert.notEqual(buildDiscovery({ ...input, userEntryId: "entry-2" }).id, first.id);

  const manyPaths = buildDiscovery({
    ...input,
    paths: Array.from({ length: 32 }, (_, index) => `src/${index}-${"p".repeat(300)}.ts`),
  });
  assert.ok(Buffer.byteLength(JSON.stringify(manyPaths), "utf8") <= 2048);
});

test("builds session binding and deterministic compact checkpoints", () => {
  const projection = goal({
    nextAction: "Call goal_status with Authorization: Bearer hidden-value before mutation",
  });
  assert.deepEqual(buildSessionBinding({ projection, sessionId: "session-1", leafId: "leaf-1" }), {
    sessionId: "session-1", leafId: "leaf-1",
  });

  const first = buildContinuityCheckpoint({
    projection, sessionId: "session-1", reason: "overflow",
    modifiedFiles: ["src/z.ts", "src/a.ts", "src/z.ts"], userEntryId: "entry-1",
  });
  const second = buildContinuityCheckpoint({
    projection, sessionId: "session-1", reason: "overflow",
    modifiedFiles: ["src/z.ts", "src/a.ts", "src/z.ts"], userEntryId: "entry-1",
  });
  assert.deepEqual(first, second);
  assert.deepEqual(first.modifiedFiles, ["src/a.ts", "src/z.ts"]);
  assert.match(first.nextAction, /\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(first), /hidden-value/);
  assert.ok(Buffer.byteLength(JSON.stringify(first), "utf8") <= 2048);

  const bounded = buildContinuityCheckpoint({
    projection, sessionId: "session-1", reason: "overflow",
    modifiedFiles: Array.from({ length: 32 }, (_, index) => `src/${index}-${"p".repeat(300)}.ts`),
    userEntryId: "entry-1",
  });
  assert.ok(Buffer.byteLength(JSON.stringify(bounded), "utf8") <= 2048);
});

test("formats deterministic bounded recovery injection without secrets or tool output", () => {
  const projection = goal({
    goalId: "recovery-goal",
    epoch: 3,
    continuity: {
      observations: {
        "obs-2": { id: "obs-2", status: "untriaged", summary: "Cookie: private-cookie follow-up" },
        "obs-1": { id: "obs-1", status: "tasked", summary: "already handled" },
      },
      lastCheckpoint: { checkpointId: "checkpoint-1", reason: "overflow", modifiedFiles: ["src/a.ts"], nextAction: "Bearer private-token" },
    },
  });

  const first = formatRecoveryInjection(projection);
  const second = formatRecoveryInjection(projection);
  assert.equal(first, second);
  assert.match(first, /recovery-goal/);
  assert.match(first, /epoch 3/i);
  assert.match(first, /checkpoint-1/);
  assert.match(first, /obs-2/);
  assert.match(first, /goal_status/);
  assert.doesNotMatch(first, /private-cookie|private-token|tool output/i);
  assert.ok(Buffer.byteLength(first, "utf8") <= 2048);
});
