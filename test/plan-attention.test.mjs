import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";

import { createAttentionRequest } from "../scripts/lib/plan/attention.mjs";
import { createPlanControl } from "../scripts/lib/plan/plan-control.mjs";
import { applyEvent, createProjection } from "../scripts/lib/plan/plan-events.mjs";

const planId = "plan-attention";
const taskId = "task-1";
const attemptId = "attempt-1";
const runId = "run-1";
const workspace = {
  originRoot: "/repo",
  worktree: "/worktree",
  baseCommit: "base",
  headCommit: "head",
  planPath: "/repo/docs/plan.md",
  planHash: "a".repeat(64),
};
const attemptWorkspace = {
  path: "/attempts/attempt-1",
  branch: "pi-plan-attempt/plan-attention/task-1/1",
  ownerToken: "owner-1",
};

function event(type, data) {
  return {
    schemaVersion: "pi-plan-event.v1",
    eventId: crypto.randomUUID(),
    planId,
    occurredAt: "2026-07-26T00:00:00.000Z",
    type,
    data,
  };
}

function apply(projection, type, data) {
  return applyEvent(projection, event(type, data));
}

function activeProjection() {
  let projection = apply(createProjection(), "plan.created", { workspace, tasks: [taskId] });
  projection = apply(projection, "attempt.workspace-allocated", {
    attemptId,
    taskId,
    baseCommit: workspace.headCommit,
    workspace: attemptWorkspace,
  });
  projection = apply(projection, "attempt.dispatch-requested", {
    attemptId,
    taskId,
    dispatchId: "dispatch-1",
    baseCommit: workspace.headCommit,
    workspace: attemptWorkspace,
    tool: {
      agent: "executor",
      task: "prompt",
      cwd: attemptWorkspace.path,
      context: "fresh",
      async: true,
      clarify: false,
      worktree: false,
    },
    toolHash: "tool-hash",
  });
  return apply(projection, "attempt.bound", {
    attemptId,
    taskId,
    dispatchId: "dispatch-1",
    runId,
    asyncDir: "/async/run-1",
    sessionFile: "/sessions/run-1.jsonl",
  });
}

function requestData(projection, overrides = {}) {
  return {
    requestId: "request-1",
    taskId,
    attemptId,
    runId,
    kind: "need_decision",
    message: "Choose the integration target",
    projectionVersion: projection.version + 1,
    createdAt: "2026-07-26T00:00:01.000Z",
    evidence: { bodyPath: "attention/request-1.md", bodySha256: "b".repeat(64) },
    ...overrides,
  };
}

test("creates immutable typed attention requests and derives blocking semantics", () => {
  const blocking = createAttentionRequest({
    requestId: "request-1",
    planId,
    taskId,
    attemptId,
    runId,
    kind: "interview_request",
    message: "Need structured answers",
    projectionVersion: 5,
    createdAt: "2026-07-26T00:00:01.000Z",
  });
  const progress = createAttentionRequest({ ...blocking, requestId: "request-2", kind: "progress_update" });

  assert.equal(blocking.blocking, true);
  assert.equal(progress.blocking, false);
  assert.equal(Object.isFrozen(blocking), true);
  assert.throws(() => createAttentionRequest({ ...blocking, kind: "unknown" }), /attention kind/);
  assert.throws(() => createAttentionRequest({ ...blocking, message: "x".repeat(64 * 1024 + 1) }), /64 KiB/);
  assert.throws(() => createAttentionRequest({ ...blocking, projectionVersion: 0 }), /projectionVersion/);
});

test("blocking attention fences escalation and resolution by request, run, and projection version", () => {
  let projection = activeProjection();
  const requested = requestData(projection);
  projection = apply(projection, "attempt.attention-requested", requested);

  const attempt = projection.attempts.get(attemptId);
  assert.equal(projection.version, requested.projectionVersion);
  assert.equal(attempt.status, "waiting-attention");
  assert.equal(attempt.attention.requestId, "request-1");
  assert.equal(attempt.attention.messageSha256, createHash("sha256").update(requested.message).digest("hex"));
  assert.equal("message" in attempt.attention, false);

  assert.throws(
    () => apply(projection, "attempt.attention-requested", requestData(projection, { requestId: "request-2" })),
    /unresolved blocking attention/,
  );
  for (const overrides of [
    { requestId: "wrong" },
    { runId: "wrong" },
    { expectedProjectionVersion: projection.version - 1 },
  ]) {
    assert.throws(() => apply(projection, "attempt.attention-resolved", {
      attemptId,
      requestId: "request-1",
      runId,
      expectedProjectionVersion: projection.version,
      resolutionSha256: "c".repeat(64),
      ...overrides,
    }), /request|runId|projection version/);
  }

  projection = apply(projection, "attempt.attention-escalated", {
    attemptId,
    requestId: "request-1",
    runId,
    expectedProjectionVersion: projection.version,
    evidence: { bodyPath: "attention/request-1.md", bodySha256: "b".repeat(64) },
  });
  assert.equal(projection.attempts.get(attemptId).attention.escalated, true);
  assert.equal(projection.attempts.get(attemptId).attention.projectionVersion, projection.version);

  projection = apply(projection, "attempt.attention-resolved", {
    attemptId,
    requestId: "request-1",
    runId,
    expectedProjectionVersion: projection.version,
    resolutionSha256: "c".repeat(64),
  });
  assert.equal(projection.attempts.get(attemptId).status, "active");
  assert.equal(projection.attempts.get(attemptId).attention.status, "resolved");

  projection = apply(projection, "attempt.settled", { attemptId, outcome: "failed" });
  assert.throws(() => apply(projection, "attempt.attention-resolved", {
    attemptId,
    requestId: "request-1",
    runId,
    expectedProjectionVersion: projection.version,
    resolutionSha256: "d".repeat(64),
  }), /waiting-attention/);
});

test("durable attention reply commands are fenced, acknowledged, and replayable across control instances", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "pi-plan-attention-control-"));
  try {
    const command = {
      planId,
      requestId: "request-1",
      taskId,
      attemptId,
      runId,
      expectedProjectionVersion: 7,
      message: "Use the approved target",
      occurredAt: "2026-07-26T00:00:02.000Z",
    };
    const first = createPlanControl({ stateRoot });
    await first.writeAttentionReply(command);

    const recovered = createPlanControl({ stateRoot });
    assert.deepEqual(await recovered.readAttentionReplies(planId), [command]);
    await assert.rejects(
      recovered.writeAttentionReply({ ...command, requestId: "../escape" }),
      /attention reply|requestId/i,
    );
    await recovered.writeAttentionAck({ ...command, result: "delivered", deliveredAt: "2026-07-26T00:00:03.000Z" });
    assert.deepEqual(await first.readAttentionReplies(planId), []);

    const ack = JSON.parse(await readFile(path.join(stateRoot, "var", "plan-runs", planId, "control", "attention", "request-1.ack.json"), "utf8"));
    assert.equal(ack.result, "delivered");
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("progress updates remain nonblocking and retain only redacted projection data", () => {
  let projection = activeProjection();
  const requested = requestData(projection, {
    requestId: "progress-1",
    kind: "progress_update",
    message: "Compilation is still running",
  });
  projection = apply(projection, "attempt.attention-requested", requested);

  const attempt = projection.attempts.get(attemptId);
  assert.equal(attempt.status, "active");
  assert.equal(attempt.attention, undefined);
  assert.equal(attempt.lastProgress.requestId, "progress-1");
  assert.equal(attempt.lastProgress.blocking, false);
  assert.equal("message" in attempt.lastProgress, false);
});
