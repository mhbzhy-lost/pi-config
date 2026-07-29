import assert from "node:assert/strict";
import test from "node:test";

import { applyEvent, createProjection } from "../scripts/lib/plan/plan-events.mjs";

const planId = "plan-1";
const workspace = {
  originRoot: "/repo",
  worktree: "/worktree",
  baseCommit: "base",
  headCommit: "head",
  planPath: "/origin/docs/release-plan.md",
  planHash: "a".repeat(64),
};
const revision = {
  number: 1, manifestSha256: "b".repeat(64), sourceBytesSha256: "c".repeat(64), planHash: "d".repeat(64),
  irVersion: "plan-ir.v3", irHash: "e".repeat(64),
  taskHashes: { "task-1": { full: "f".repeat(64), effective: "1".repeat(64), scheduling: "2".repeat(64) }, },
};

function event(type, data = {}, overrides = {}) {
  return {
    schemaVersion: "pi-plan-event.v1",
    eventId: crypto.randomUUID(),
    planId,
    occurredAt: "2026-07-15T00:00:00.000Z",
    type,
    data,
    ...overrides,
  };
}

function apply(projection, type, data, overrides) {
  return applyEvent(projection, event(type, data, overrides));
}

function createRunningProjection() {
  return apply(createProjection(), "plan.created", { workspace, tasks: ["task-1"] });
}

function acceptedTask(projection, taskId = "task-1") {
  return apply(projection, "task.accepted", { taskId });
}

function dispatchTool(attemptId = "attempt-1") {
  return { agent: "executor", task: "prompt", cwd: `/attempts/${attemptId}`, context: "fresh", async: true, clarify: false, worktree: false };
}

function attemptWorkspace(attemptId) {
  return { path: `/attempts/${attemptId}`, branch: `pi-plan-attempt/plan-1/task-1/${attemptId}`, ownerToken: `${attemptId}-owner` };
}

function requestAttempt(projection, attemptId, taskId = "task-1") {
  const workspaceLease = attemptWorkspace(attemptId);
  projection = apply(projection, "attempt.workspace-allocated", {
    attemptId,
    taskId,
    baseCommit: workspace.headCommit,
    workspace: workspaceLease,
  });
  return apply(projection, "attempt.dispatch-requested", {
    attemptId,
    taskId,
    dispatchId: `${attemptId}-dispatch`,
    baseCommit: workspace.headCommit,
    workspace: workspaceLease,
    tool: dispatchTool(attemptId),
    toolHash: `${attemptId}-tool-hash`,
  });
}

function bindAttempt(projection, attemptId, taskId = "task-1") {
  projection = requestAttempt(projection, attemptId, taskId);
  return apply(projection, "attempt.bound", {
    attemptId,
    taskId,
    dispatchId: `${attemptId}-dispatch`,
    runId: `${attemptId}-run`,
    asyncDir: `/${attemptId}`,
    sessionFile: `/${attemptId}.jsonl`,
  });
}

function passedGates(projection) {
  for (const type of ["deterministic", "plan-audit", "external-review", "final-completeness"]) {
    projection = apply(projection, "gate.finished", {
      type,
      status: "passed",
      inputHead: workspace.headCommit,
      gateId: `${type}-1`,
      changeSetHash: "changes-1",
      evidence: [{ command: "true" }],
      findings: [],
    });
  }
  return projection;
}

function sha(seed) {
  return seed.repeat(64).slice(0, 64);
}

function revisionProjection(tasks = ["task-1", "task-2", "task-3"]) {
  const revisionWorkspace = { originRoot: "/repo", worktree: "/worktree", baseCommit: "base", headCommit: "head" };
  const taskHashes = Object.fromEntries(tasks.map((taskId, index) => [taskId, {
    full: sha(String(index + 1)), effective: sha(String(index + 1)), scheduling: sha(String(index + 4)),
  }]));
  return applyEvent(createProjection(), event("plan.created", {
    workspace: revisionWorkspace,
    tasks,
    revision: { number: 1, manifestSha256: sha("a"), sourceBytesSha256: sha("b"), planHash: sha("c"), irVersion: "plan-ir.v3", irHash: sha("d"), taskHashes },
  }));
}

function amendmentData(projection, overrides = {}) {
  const old = projection.revision.taskHashes;
  const taskHashes = {
    "task-1": { ...old["task-1"] },
    "task-2": { full: sha("5"), effective: sha("5"), scheduling: sha("6") },
    "task-4": { full: sha("7"), effective: sha("7"), scheduling: sha("8") },
  };
  return {
    revision: 2, parentRevision: 1, manifestSha256: sha("9"), sourceBytesSha256: sha("a"), planHash: sha("b"), irHash: sha("c"), taskHashes,
    diff: { added: ["task-4"], changed: ["task-2"], rebound: [], retired: ["task-3"], unchanged: ["task-1"] },
    supersededAttemptIds: [], requestId: "supervisor-request-1", reason: "clarify execution contract", ...overrides,
  };
}

test("atomically projects a strict Plan amendment matrix with tombstones and supersede intent", () => {
  let projection = revisionProjection();
  projection = apply(projection, "task.accepted", { taskId: "task-1" });
  projection = apply(projection, "attempt.workspace-allocated", { attemptId: "attempt-2", taskId: "task-2", baseCommit: "head", workspace: attemptWorkspace("attempt-2") });
  projection = apply(projection, "attempt.dispatch-requested", {
    attemptId: "attempt-2", taskId: "task-2", dispatchId: "dispatch-2", baseCommit: "head", workspace: attemptWorkspace("attempt-2"), tool: dispatchTool("attempt-2"), toolHash: "tool-2",
    planIrHash: projection.revision.irHash, taskHash: projection.revision.taskHashes["task-2"].effective, schedulingHash: projection.revision.taskHashes["task-2"].scheduling, dispatchContextHash: sha("e"),
  });
  const data = amendmentData(projection, { supersededAttemptIds: ["attempt-2"] });
  const amended = apply(projection, "plan.amended", data);
  assert.equal(amended.revision.number, 2);
  assert.equal(amended.revision.irVersion, "plan-ir.v3");
  assert.deepEqual(amended.revision.taskHashes, data.taskHashes);
  assert.deepEqual(amended.tasks.get("task-1"), { status: "accepted" });
  assert.deepEqual(amended.tasks.get("task-2"), { status: "pending" });
  assert.deepEqual(amended.tasks.get("task-3"), { status: "retired" });
  assert.deepEqual(amended.tasks.get("task-4"), { status: "pending" });
  assert.equal(amended.attempts.get("attempt-2").status, "supersede-requested");
  assert.deepEqual(amended.amendmentRequestIds, new Set(["supervisor-request-1"]));
});

test("atomically closes unresolved blocking Attention when an amendment supersedes its Attempt", () => {
  function revisedProjection() {
    let projection = revisionProjection(["task-1", "task-2"]);
    for (const attemptId of ["source", "waiting"]) {
      const taskId = attemptId === "source" ? "task-1" : "task-2";
      const workspaceLease = attemptWorkspace(attemptId);
      projection = apply(projection, "attempt.workspace-allocated", { attemptId, taskId, baseCommit: "head", workspace: workspaceLease });
      projection = apply(projection, "attempt.dispatch-requested", {
        attemptId, taskId, dispatchId: `${attemptId}-dispatch`, baseCommit: "head", workspace: workspaceLease,
        tool: dispatchTool(attemptId), toolHash: `${attemptId}-tool`, planIrHash: projection.revision.irHash,
        taskHash: projection.revision.taskHashes[taskId].effective, schedulingHash: projection.revision.taskHashes[taskId].scheduling, dispatchContextHash: sha(attemptId === "source" ? "a" : "b"),
      });
      projection = apply(projection, "attempt.bound", { attemptId, taskId, dispatchId: `${attemptId}-dispatch`, runId: `${attemptId}-run`, asyncDir: `/${attemptId}`, sessionFile: `/${attemptId}.jsonl` });
    }
    const attention = (attemptId) => ({ requestId: `${attemptId}-request`, taskId: attemptId === "source" ? "task-1" : "task-2", attemptId, runId: `${attemptId}-run`, kind: "need_decision", message: `${attemptId} needs a decision`, projectionVersion: projection.version + 1, createdAt: "2026-07-15T00:00:00.000Z", evidence: { bodyPath: `${attemptId}.md`, bodySha256: sha(attemptId === "source" ? "c" : "d") } });
    projection = apply(projection, "attempt.attention-requested", attention("source"));
    projection = apply(projection, "attempt.attention-resolved", { attemptId: "source", requestId: "source-request", runId: "source-run", expectedProjectionVersion: projection.version, resolutionSha256: sha("e") });
    projection = apply(projection, "attempt.attention-requested", attention("waiting"));
    projection = apply(projection, "attempt.attention-escalated", { attemptId: "waiting", requestId: "waiting-request", runId: "waiting-run", expectedProjectionVersion: projection.version, evidence: { bodyPath: "waiting-escalated.md", bodySha256: sha("f") } });
    return projection;
  }

  const amend = (projection) => amendmentData(projection, {
    taskHashes: {
      "task-1": { ...projection.revision.taskHashes["task-1"], effective: sha("7") },
      "task-2": { ...projection.revision.taskHashes["task-2"], effective: sha("8") },
    },
    diff: { added: [], changed: [], rebound: ["task-1", "task-2"], retired: [], unchanged: [] },
    supersededAttemptIds: ["source", "waiting"],
  });

  const before = revisedProjection();
  const sourceAttention = structuredClone(before.attempts.get("source").attention);
  const waitingAttention = structuredClone(before.attempts.get("waiting").attention);
  const amended = apply(before, "plan.amended", amend(before));
  const waiting = amended.attempts.get("waiting");
  assert.deepEqual(amended.attempts.get("source").attention, sourceAttention);
  assert.deepEqual(waiting.attention, { ...waitingAttention, status: "superseded", supersededByRevision: 2, projectionVersion: before.version + 1 });
  assert.equal(waiting.attention.resolutionSha256, undefined);
  for (const type of ["attempt.attention-resolved", "attempt.attention-escalated"]) {
    assert.throws(() => apply(amended, type, { attemptId: "waiting", requestId: "waiting-request", runId: "waiting-run", expectedProjectionVersion: amended.version, ...(type.endsWith("resolved") ? { resolutionSha256: sha("9") } : { evidence: { bodyPath: "late.md", bodySha256: sha("a") } }) }), /waiting-attention/);
  }
  const replay = revisedProjection();
  assert.deepEqual(apply(replay, "plan.amended", amend(replay)).attempts.get("waiting").attention, waiting.attention);
  const invalid = { ...amend(before), supersededAttemptIds: ["source"] };
  const original = structuredClone(before.attempts.get("waiting").attention);
  assert.throws(() => apply(before, "plan.amended", invalid), /supersededAttemptIds/);
  assert.deepEqual(before.attempts.get("waiting").attention, original);
});

test("rejects invalid Plan amendments without mutating the current projection", () => {
  const projection = revisionProjection();
  const original = structuredClone({ revision: projection.revision, tasks: [...projection.tasks], attempts: [...projection.attempts] });
  const invalid = [
    ["legacy projection", createRunningProjection(), amendmentData(projection), /revision identity/],
    ["bad exact keys", projection, { ...amendmentData(projection), extra: true }, /plan.amended data/],
    ["bad revision chain", projection, amendmentData(projection, { revision: 3 }), /revision/],
    ["invalid SHA", projection, amendmentData(projection, { manifestSha256: "bad" }), /manifestSha256/],
    ["unsorted diff", projection, amendmentData(projection, { diff: { added: ["task-z", "task-4"], changed: ["task-2"], rebound: [], retired: ["task-3"], unchanged: ["task-1"] } }), /diff/],
    ["wrong partition", projection, amendmentData(projection, { diff: { added: ["task-4"], changed: [], rebound: [], retired: ["task-3"], unchanged: ["task-1", "task-2"] } }), /diff/],
    ["missing task hash", projection, (() => { const { "task-4": ignored, ...taskHashes } = amendmentData(projection).taskHashes; return amendmentData(projection, { taskHashes }); })(), /diff/],
  ];
  for (const [label, current, data, expected] of invalid) assert.throws(() => apply(current, "plan.amended", data), expected, label);
  assert.deepEqual({ revision: projection.revision, tasks: [...projection.tasks], attempts: [...projection.attempts] }, original);
});

test("rejects invalid amendment metadata without mutating the current projection", () => {
  const projection = revisionProjection();
  const original = structuredClone({ revision: projection.revision, tasks: [...projection.tasks], attempts: [...projection.attempts], amendmentRequestIds: [...projection.amendmentRequestIds] });
  for (const [label, data, expected] of [
    ["requestId with spaces", amendmentData(projection, { requestId: "request id" }), /requestId/],
    ["requestId with slash", amendmentData(projection, { requestId: "request/id" }), /requestId/],
    ["requestId with invalid leading character", amendmentData(projection, { requestId: ".request-id" }), /requestId/],
    ["blank reason", amendmentData(projection, { reason: " \t\n" }), /reason/],
    ["reason longer than 4096 UTF-8 bytes", amendmentData(projection, { reason: "\u00e9".repeat(2049) }), /reason/],
  ]) {
    assert.throws(() => apply(projection, "plan.amended", data), expected, label);
    assert.deepEqual({ revision: projection.revision, tasks: [...projection.tasks], attempts: [...projection.attempts], amendmentRequestIds: [...projection.amendmentRequestIds] }, original, label);
  }
});

test("rejects a new amendment while supersede cleanup is pending without mutating the projection", () => {
  let projection = revisionProjection(["task-1", "task-2"]);
  projection = apply(projection, "attempt.workspace-allocated", { attemptId: "attempt-2", taskId: "task-2", baseCommit: "head", workspace: attemptWorkspace("attempt-2") });
  projection = apply(projection, "plan.amended", amendmentData(projection, {
    taskHashes: { "task-1": { ...projection.revision.taskHashes["task-1"] }, "task-2": { ...projection.revision.taskHashes["task-2"], effective: sha("e") } },
    diff: { added: [], changed: [], rebound: ["task-2"], retired: [], unchanged: ["task-1"] },
    supersededAttemptIds: ["attempt-2"],
  }));
  const original = structuredClone({ revision: projection.revision, tasks: [...projection.tasks], attempts: [...projection.attempts], amendmentRequestIds: [...projection.amendmentRequestIds] });
  const second = amendmentData(projection, {
    revision: 3, parentRevision: 2, requestId: "supervisor-request-2",
    taskHashes: { "task-1": { ...projection.revision.taskHashes["task-1"] }, "task-2": { ...projection.revision.taskHashes["task-2"], effective: sha("f") } },
    diff: { added: [], changed: [], rebound: ["task-2"], retired: [], unchanged: ["task-1"] },
  });
  assert.throws(() => apply(projection, "plan.amended", second), /supersede cleanup/);
  assert.deepEqual({ revision: projection.revision, tasks: [...projection.tasks], attempts: [...projection.attempts], amendmentRequestIds: [...projection.amendmentRequestIds] }, original);
});

test("requires exact supersede attempts, rejects request replay, and preserves accepted rebound carry-forward", () => {
  let projection = revisionProjection(["task-1", "task-2"]);
  projection = apply(projection, "task.accepted", { taskId: "task-1" });
  projection = apply(projection, "attempt.workspace-allocated", { attemptId: "attempt-2", taskId: "task-2", baseCommit: "head", workspace: attemptWorkspace("attempt-2") });
  const changed = amendmentData(projection, {
    taskHashes: { "task-1": { ...projection.revision.taskHashes["task-1"], effective: sha("f") }, "task-2": { ...projection.revision.taskHashes["task-2"], effective: sha("e") } },
    diff: { added: [], changed: [], rebound: ["task-1", "task-2"], retired: [], unchanged: [] },
  });
  assert.throws(() => apply(projection, "plan.amended", changed), /supersededAttemptIds/);
  const amended = apply(projection, "plan.amended", { ...changed, supersededAttemptIds: ["attempt-2"] });
  assert.equal(amended.tasks.get("task-1").status, "accepted");
  assert.equal(amended.attempts.get("attempt-2").status, "supersede-requested");
  assert.throws(() => apply(amended, "plan.amended", { ...changed, revision: 3, parentRevision: 2 }), /duplicate amendment requestId/);
  const withTombstone = apply(revisionProjection(), "plan.amended", amendmentData(revisionProjection()));
  assert.throws(() => apply(withTombstone, "plan.amended", {
    revision: 3, parentRevision: 2, manifestSha256: sha("1"), sourceBytesSha256: sha("2"), planHash: sha("3"), irHash: sha("4"),
    taskHashes: { ...withTombstone.revision.taskHashes, "task-3": { full: sha("5"), effective: sha("5"), scheduling: sha("6") } },
    diff: { added: ["task-3"], changed: [], rebound: [], retired: [], unchanged: ["task-1", "task-2", "task-4"] },
    supersededAttemptIds: [], requestId: "new-request", reason: "reuse a tombstone",
  }), /historical task ID/);
});

test("creates a created projection with every declared task pending", () => {
  const projection = createRunningProjection();

  assert.equal(projection.planId, planId);
  assert.equal(projection.lifecycle, "created");
  assert.deepEqual(projection.workspace, workspace);
  assert.equal(projection.validatedHead, null);
  assert.ok(projection.tasks instanceof Map);
  assert.ok(projection.attempts instanceof Map);
  assert.ok(projection.gates instanceof Map);
  assert.deepEqual(projection.tasks.get("task-1"), { status: "pending" });
});

test("requires a nonempty unique task list when creating a plan", () => {
  assert.throws(
    () => applyEvent(createProjection(), event("plan.created", { workspace, tasks: [] })),
    /tasks/,
  );
  assert.throws(
    () => applyEvent(createProjection(), event("plan.created", { workspace, tasks: ["task-1", "task-1"] })),
    /unique/,
  );
});

test("requires and preserves immutable approved plan identity", () => {
  assert.throws(
    () => applyEvent(createProjection(), event("plan.created", { workspace: { ...workspace, planPath: "" }, tasks: ["task-1"] })),
    /workspace.planPath/,
  );
  assert.throws(
    () => applyEvent(createProjection(), event("plan.created", { workspace: { ...workspace, planHash: "" }, tasks: ["task-1"] })),
    /workspace.planHash/,
  );
  assert.deepEqual(createRunningProjection().workspace, workspace);
});

test("projects a defensive revision identity and requires matching dispatch hashes", () => {
  const revisionWorkspace = { originRoot: "/repo", worktree: "/worktree", baseCommit: "base", headCommit: "head" };
  let projection = applyEvent(createProjection(), event("plan.created", { workspace: revisionWorkspace, tasks: ["task-1"], revision }));
  assert.deepEqual(projection.revision, revision);
  revision.taskHashes["task-1"].effective = "0".repeat(64);
  assert.equal(projection.revision.taskHashes["task-1"].effective, "1".repeat(64));
  projection = apply(projection, "attempt.workspace-allocated", { attemptId: "attempt-1", taskId: "task-1", baseCommit: "head", workspace: attemptWorkspace("attempt-1") });
  const dispatch = { attemptId: "attempt-1", taskId: "task-1", dispatchId: "dispatch-1", baseCommit: "head", workspace: attemptWorkspace("attempt-1"), tool: dispatchTool(), toolHash: "tool", planIrHash: revision.irHash, taskHash: "1".repeat(64), schedulingHash: "2".repeat(64), dispatchContextHash: "3".repeat(64) };
  projection = apply(projection, "attempt.dispatch-requested", dispatch);
  assert.equal(projection.attempts.get("attempt-1").taskHash, "1".repeat(64));
  assert.throws(() => applyEvent(createProjection(), event("plan.created", { workspace: revisionWorkspace, tasks: ["task-1"], revision: { ...revision, taskHashes: {} } })), /taskHashes/);
});

test("rejects every revision dispatch identity mismatch and malformed dispatch context", () => {
  const revisionWorkspace = { originRoot: "/repo", worktree: "/worktree", baseCommit: "base", headCommit: "head" };
  const baseDispatch = {
    attemptId: "attempt-1", taskId: "task-1", dispatchId: "dispatch-1", baseCommit: "head",
    workspace: attemptWorkspace("attempt-1"), tool: dispatchTool(), toolHash: "tool",
    planIrHash: revision.irHash, taskHash: "0".repeat(64), schedulingHash: "2".repeat(64), dispatchContextHash: "3".repeat(64),
  };
  const allocatedProjection = () => applyEvent(
    applyEvent(createProjection(), event("plan.created", { workspace: revisionWorkspace, tasks: ["task-1"], revision })),
    event("attempt.workspace-allocated", { attemptId: "attempt-1", taskId: "task-1", baseCommit: "head", workspace: attemptWorkspace("attempt-1") }),
  );

  for (const [label, data, expected] of [
    ["planIrHash mismatch", { ...baseDispatch, planIrHash: "4".repeat(64) }, /dispatch revision identity/],
    ["effective taskHash mismatch", { ...baseDispatch, taskHash: "4".repeat(64) }, /dispatch revision identity/],
    ["schedulingHash mismatch", { ...baseDispatch, schedulingHash: "4".repeat(64) }, /dispatch revision identity/],
    ["missing dispatchContextHash", (() => { const { dispatchContextHash, ...data } = baseDispatch; return data; })(), /invalid dispatch (revision keys|dispatchContextHash)/],
    ["non-SHA-256 dispatchContextHash", { ...baseDispatch, dispatchContextHash: "not-a-sha" }, /invalid dispatchContextHash/],
    ["extra dispatch key", { ...baseDispatch, unexpected: true }, /invalid dispatch revision keys/],
  ]) {
    assert.throws(() => apply(allocatedProjection(), "attempt.dispatch-requested", data), expected, label);
  }
});

test("rejects invalid envelopes, mixed plans, and duplicate event ids", () => {
  const created = createRunningProjection();

  assert.throws(
    () => applyEvent(createProjection(), event("plan.created", { workspace }, { schemaVersion: "wrong" })),
    /schemaVersion/,
  );
  assert.throws(
    () => applyEvent(createProjection(), event("plan.created", { workspace }, { eventId: "" })),
    /eventId/,
  );
  assert.throws(
    () => applyEvent(created, event("task.accepted", { taskId: "task-1" }, { planId: "other" })),
    /planId/,
  );
  const duplicate = event("task.accepted", { taskId: "task-1" }, { eventId: "same" });
  const applied = applyEvent(created, duplicate);
  assert.throws(() => applyEvent(applied, duplicate), /duplicate eventId/);
});

test("attempt activity moves created plans to running and preserves transitions", () => {
  let projection = createRunningProjection();
  projection = bindAttempt(projection, "attempt-1");
  assert.equal(projection.lifecycle, "running");
  assert.equal(projection.attempts.get("attempt-1").taskId, "task-1");
  assert.equal(projection.attempts.get("attempt-1").status, "active");
  assert.equal(projection.attempts.get("attempt-1").runId, "attempt-1-run");

  assert.throws(
    () => apply(projection, "attempt.bound", { attemptId: "attempt-1", taskId: "task-1", dispatchId: "attempt-1-dispatch" }),
    /not dispatch-requested/,
  );
  projection = apply(projection, "attempt.settled", { attemptId: "attempt-1", outcome: "succeeded", resultCommit: "result-1" });
  assert.equal(projection.attempts.get("attempt-1").taskId, "task-1");
  assert.equal(projection.attempts.get("attempt-1").status, "succeeded");
  assert.equal(projection.attempts.get("attempt-1").runId, "attempt-1-run");
  assert.throws(
    () => apply(projection, "attempt.settled", { attemptId: "attempt-1", outcome: "failed" }),
    /not active/,
  );
});

test("settles an explicitly blocked Attempt without inventing a result commit", () => {
  let projection = bindAttempt(createRunningProjection(), "attempt-1");

  projection = apply(projection, "attempt.settled", {
    attemptId: "attempt-1",
    outcome: "blocked",
    blockerReason: "real-module-candidates-not-ready",
    blockers: ["cocoapods", "tbctx7_code_auth"],
    evidenceSha256: "a".repeat(64),
  });

  assert.equal(projection.attempts.get("attempt-1").status, "blocked");
  assert.equal(projection.attempts.get("attempt-1").resultCommit, undefined);
  assert.equal(projection.attempts.get("attempt-1").blockerReason, "real-module-candidates-not-ready");
  assert.deepEqual(projection.attempts.get("attempt-1").blockers, ["cocoapods", "tbctx7_code_auth"]);
  assert.equal(projection.attempts.get("attempt-1").evidenceSha256, "a".repeat(64));
});

test("persists workspace ownership and exactly one dispatch intent before binding", () => {
  let projection = createRunningProjection();
  projection = apply(projection, "attempt.workspace-allocated", {
    attemptId: "attempt-1",
    taskId: "task-1",
    baseCommit: workspace.headCommit,
    workspace: attemptWorkspace("attempt-1"),
  });
  projection = apply(projection, "attempt.dispatch-requested", {
    attemptId: "attempt-1",
    taskId: "task-1",
    dispatchId: "attempt-1-dispatch",
    baseCommit: workspace.headCommit,
    workspace: attemptWorkspace("attempt-1"),
    tool: dispatchTool(),
    toolHash: "attempt-1-tool-hash",
  });
  assert.deepEqual(projection.attempts.get("attempt-1"), {
    taskId: "task-1",
    status: "dispatch-requested",
    dispatchId: "attempt-1-dispatch",
    baseCommit: workspace.headCommit,
    workspace: attemptWorkspace("attempt-1"),
    tool: dispatchTool(),
    toolHash: "attempt-1-tool-hash",
  });
  projection = apply(projection, "attempt.bound", {
    attemptId: "attempt-1",
    taskId: "task-1",
    dispatchId: "attempt-1-dispatch",
    runId: "run-1",
    asyncDir: "/async/1",
    sessionFile: "/sessions/one.jsonl",
  });
  assert.deepEqual(projection.attempts.get("attempt-1"), {
    taskId: "task-1",
    status: "active",
    dispatchId: "attempt-1-dispatch",
    baseCommit: workspace.headCommit,
    workspace: attemptWorkspace("attempt-1"),
    tool: dispatchTool(),
    toolHash: "attempt-1-tool-hash",
    runId: "run-1",
    asyncDir: "/async/1",
    sessionFile: "/sessions/one.jsonl",
  });
});

test("rejects attempts for undeclared tasks and a second active mutating attempt", () => {
  let projection = apply(createProjection(), "plan.created", { workspace, tasks: ["task-1", "task-2"] });
  assert.throws(
    () => requestAttempt(projection, "unknown-attempt", "unknown"),
    /unknown task/,
  );

  projection = requestAttempt(projection, "attempt-1", "task-1");
  // Different task can now have a parallel dispatch (task-level mutual exclusion)
  const parallel = requestAttempt(projection, "attempt-2", "task-2");
  assert.equal(parallel.attempts.get("attempt-2").taskId, "task-2");
  // Same task still rejected
  assert.throws(
    () => requestAttempt(projection, "attempt-3", "task-1"),
    /active attempt/,
  );
});

test("advances succeeded attempts through validation, integration, and workspace release", () => {
  let projection = bindAttempt(createRunningProjection(), "attempt-1");
  projection = apply(projection, "attempt.settled", {
    attemptId: "attempt-1",
    outcome: "succeeded",
    resultCommit: "result-commit",
  });
  projection = apply(projection, "attempt.validated", {
    attemptId: "attempt-1",
    resultCommit: "result-commit",
    validationHash: "validation-hash",
    diffSha256: "d".repeat(64),
    changedPaths: ["src/a.mjs"],
    evidence: [{ path: "evidence/validation.json", sha256: "e".repeat(64) }],
  });
  assert.equal(projection.attempts.get("attempt-1").status, "validated");
  assert.equal(projection.attempts.get("attempt-1").validationDiffSha256, "d".repeat(64));
  assert.deepEqual(projection.attempts.get("attempt-1").validationChangedPaths, ["src/a.mjs"]);
  projection = apply(projection, "integration.requested", {
    attemptId: "attempt-1",
    expectedHead: workspace.headCommit,
    resultCommit: "result-commit",
    diffSha256: "d".repeat(64),
  });
  projection = apply(projection, "integration.finished", {
    attemptId: "attempt-1",
    previousHead: workspace.headCommit,
    newHead: "integrated-head",
  });
  assert.equal(projection.attempts.get("attempt-1").status, "integrated");
  assert.equal(projection.attempts.get("attempt-1").resultCommit, "result-commit");
  assert.deepEqual(projection.tasks.get("task-1"), { status: "accepted" });
  projection = apply(projection, "attempt.workspace-released", {
    attemptId: "attempt-1",
    disposition: "integrated-cleanup",
    evidence: { path: "evidence/release.json", sha256: "r".repeat(64) },
  });
  assert.equal(projection.attempts.get("attempt-1").workspaceReleased, true);
});

test("rejects dispatch intents that do not match their allocated workspace", () => {
  let projection = createRunningProjection();
  projection = apply(projection, "attempt.workspace-allocated", {
    attemptId: "attempt-1",
    taskId: "task-1",
    baseCommit: workspace.headCommit,
    workspace: attemptWorkspace("attempt-1"),
  });
  assert.throws(() => apply(projection, "attempt.dispatch-requested", {
    attemptId: "attempt-1",
    taskId: "task-1",
    dispatchId: "dispatch-1",
    baseCommit: "stale",
    workspace: attemptWorkspace("attempt-1"),
    tool: dispatchTool(),
    toolHash: "tool-hash",
  }), /baseCommit/);
});

test("accepts a task once and keeps task values directly usable", () => {
  let projection = createRunningProjection();
  projection = acceptedTask(projection);

  assert.deepEqual(projection.tasks.get("task-1"), { status: "accepted" });
  assert.throws(() => acceptedTask(projection), /not pending/);
  assert.throws(() => apply(projection, "task.accepted", { taskId: "unknown" }), /unknown/);
});

test("records immutable GateAttempt values and enters verifying on the first gate", () => {
  let projection = createRunningProjection();

  assert.throws(
    () => apply(projection, "gate.finished", { type: "deterministic", status: "passed", inputHead: "stale", gateId: "stale", changeSetHash: "changes", evidence: [], findings: [] }),
    /inputHead/,
  );
  projection = apply(projection, "gate.finished", {
    type: "deterministic", status: "passed", inputHead: workspace.headCommit,
    gateId: "deterministic-1", changeSetHash: "changes-1", evidence: [{ command: "true" }], findings: [],
  });
  assert.equal(projection.lifecycle, "verifying");
  assert.deepEqual(projection.gates.get("deterministic"), {
    type: "deterministic", status: "passed", inputHead: workspace.headCommit,
    gateId: "deterministic-1", changeSetHash: "changes-1", evidence: [{ command: "true" }], findings: [],
  });
  assert.throws(
    () => apply(projection, "gate.finished", { type: "deterministic", status: "failed", inputHead: workspace.headCommit, gateId: "deterministic-2", changeSetHash: "changes-2", evidence: [], findings: [] }),
    /already finished/,
  );
});

test("observes a new HEAD, invalidates current gates, and permits replacement gate attempts", () => {
  let projection = createRunningProjection();
  projection = acceptedTask(projection);
  projection = passedGates(projection);
  projection = apply(projection, "workspace.head-observed", { headCommit: "new-head" });

  assert.equal(projection.workspace.headCommit, "new-head");
  assert.equal(projection.lifecycle, "running");
  assert.equal(projection.gates.size, 0);
  projection = apply(projection, "gate.finished", {
    type: "deterministic", status: "passed", inputHead: "new-head",
    gateId: "deterministic-2", changeSetHash: "changes-2", evidence: [{ command: "true" }], findings: [],
  });
  assert.equal(projection.gates.get("deterministic").inputHead, "new-head");
});

test("validates only fully accepted, settled, clean plans with four current passed gates", () => {
  let projection = createRunningProjection();
  projection = bindAttempt(projection, "attempt-1");
  projection = apply(projection, "attempt.settled", { attemptId: "attempt-1", outcome: "succeeded", resultCommit: "result-1" });
  projection = acceptedTask(projection);
  projection = passedGates(projection);

  assert.throws(() => apply(projection, "plan.validated", { worktreeClean: false }), /worktree clean/);
  projection = apply(projection, "plan.validated", { worktreeClean: true });
  assert.equal(projection.lifecycle, "validated");
  assert.equal(projection.validatedHead, workspace.headCommit);
});

test("fails closed when validation has nonterminal tasks, active attempts, missing gates, or nonpassed gates", () => {
  let projection = createRunningProjection();
  projection = bindAttempt(projection, "attempt-1");
  projection = apply(projection, "task.accepted", { taskId: "task-1" });
  projection = apply(projection, "gate.finished", {
    type: "deterministic", status: "passed", inputHead: workspace.headCommit,
    gateId: "deterministic-1", changeSetHash: "changes-1", evidence: [], findings: [],
  });
  assert.throws(() => apply(projection, "plan.validated", { worktreeClean: true }), /active attempt/);

  projection = apply(projection, "attempt.settled", { attemptId: "attempt-1", outcome: "succeeded", resultCommit: "result-1" });
  assert.throws(() => apply(projection, "plan.validated", { worktreeClean: true }), /missing gate/);

  for (const type of ["plan-audit", "external-review", "final-completeness"]) {
    projection = apply(projection, "gate.finished", {
      type,
      status: "passed",
      inputHead: workspace.headCommit,
      gateId: `${type}-1`, changeSetHash: "changes-1", evidence: [{ command: "true" }], findings: [],
    });
  }
  projection.tasks.set("task-2", { status: "running" });
  assert.throws(() => apply(projection, "plan.validated", { worktreeClean: true }), /not accepted/);
});

test("rejects validation when a current gate failed or was unavailable", () => {
  let projection = acceptedTask(createRunningProjection());
  for (const [type, status] of [
    ["deterministic", "passed"],
    ["plan-audit", "passed"],
    ["external-review", "failed"],
    ["final-completeness", "unavailable"],
  ]) {
    projection = apply(projection, "gate.finished", {
      type, status, inputHead: workspace.headCommit,
      gateId: `${type}-1`, changeSetHash: "changes-1", evidence: [{ command: "true" }], findings: [],
    });
  }
  assert.throws(() => apply(projection, "plan.validated", { worktreeClean: true }), /gate did not pass/);
});

test("moves a running plan into explicit terminal lifecycle states only", () => {
  for (const type of ["plan.blocked", "plan.cancelled", "plan.interrupted"]) {
    let projection = createRunningProjection();
    projection = bindAttempt(projection, `${type}-attempt`);
    projection = apply(projection, "attempt.settled", { attemptId: `${type}-attempt`, outcome: "succeeded", resultCommit: `${type}-result` });
    projection = apply(projection, type, {});
    assert.equal(projection.lifecycle, type.slice(5));
    assert.throws(() => apply(projection, "plan.cancelled", {}), /terminal/);
  }
});

test("persists strict supersede provenance and only accepts matching proof before release", () => {
  let projection = revisionProjection(["task-1", "task-2"]);
  projection = apply(projection, "attempt.workspace-allocated", { attemptId: "attempt-2", taskId: "task-2", baseCommit: "head", workspace: attemptWorkspace("attempt-2") });
  projection = apply(projection, "plan.amended", amendmentData(projection, {
    taskHashes: { "task-1": { ...projection.revision.taskHashes["task-1"] }, "task-2": { ...projection.revision.taskHashes["task-2"], effective: sha("e") } },
    diff: { added: [], changed: [], rebound: ["task-2"], retired: [], unchanged: ["task-1"] }, supersededAttemptIds: ["attempt-2"],
  }));
  const requested = projection.attempts.get("attempt-2");
  assert.equal(requested.supersededFromStatus, "workspace-allocated");
  assert.equal(requested.supersededTaskHash, sha("2"));
  assert.equal(requested.supersededByRevision, 2);
  assert.throws(() => apply(projection, "attempt.superseded", { attemptId: "attempt-2", taskId: "task-2", oldTaskHash: sha("0"), supersededByRevision: 2, evidence: { kind: "never-started", dispatchId: null } }), /oldTaskHash/);
  assert.throws(() => apply(projection, "attempt.superseded", { attemptId: "attempt-2", taskId: "task-2", oldTaskHash: sha("2"), supersededByRevision: 2, evidence: { kind: "never-started", dispatchId: "unexpected" } }), /dispatchId/);
  projection = apply(projection, "attempt.superseded", { attemptId: "attempt-2", taskId: "task-2", oldTaskHash: sha("2"), supersededByRevision: 2, evidence: { kind: "never-started", dispatchId: null } });
  assert.equal(projection.attempts.get("attempt-2").status, "superseded");
  assert.equal(projection.attempts.get("attempt-2").workspaceReleased, undefined);
  const blockedAmendment = amendmentData(projection, {
    revision: 3, parentRevision: 2, requestId: "supervisor-request-2",
    taskHashes: { "task-1": { ...projection.revision.taskHashes["task-1"] }, "task-2": { ...projection.revision.taskHashes["task-2"], effective: sha("f") } },
    diff: { added: [], changed: [], rebound: ["task-2"], retired: [], unchanged: ["task-1"] },
  });
  assert.throws(() => apply(projection, "plan.amended", blockedAmendment), /supersede cleanup/);
  assert.throws(() => apply(projection, "workspace.head-observed", { headCommit: "later-head" }), /active attempt/);
  projection.tasks.set("task-1", { status: "accepted" });
  projection.tasks.set("task-2", { status: "accepted" });
  projection.lifecycle = "verifying";
  assert.throws(() => apply(projection, "plan.validated", { worktreeClean: true }), /active attempt/);
  projection.lifecycle = "running";
  projection.tasks.set("task-2", { status: "pending" });
  assert.throws(() => apply(projection, "attempt.workspace-allocated", { attemptId: "attempt-3", taskId: "task-2", baseCommit: "head", workspace: attemptWorkspace("attempt-3") }), /active attempt/);
  assert.throws(() => apply(projection, "attempt.workspace-released", { attemptId: "attempt-2", disposition: "failed-preserve", evidence: {} }), /disposition/);
  projection = apply(projection, "attempt.workspace-released", { attemptId: "attempt-2", disposition: "superseded-cleanup", evidence: {} });
  assert.equal(projection.attempts.get("attempt-2").workspaceReleased, true);
  projection.tasks.set("task-1", { status: "accepted" });
  projection.tasks.set("task-2", { status: "accepted" });
  projection.lifecycle = "verifying";
  assert.throws(() => apply(projection, "plan.validated", { worktreeClean: true }), /missing gate/);
  projection.lifecycle = "running";
  projection.tasks.set("task-2", { status: "pending" });
  projection = apply(projection, "attempt.workspace-allocated", { attemptId: "attempt-3", taskId: "task-2", baseCommit: "head", workspace: attemptWorkspace("attempt-3") });
  assert.equal(projection.attempts.get("attempt-3").status, "workspace-allocated");
});

test("requires dispatch and run binding identity for terminal supersede proof", () => {
  let projection = revisionProjection(["task-1", "task-2"]);
  const workspaceLease = attemptWorkspace("attempt-2");
  projection = apply(projection, "attempt.workspace-allocated", { attemptId: "attempt-2", taskId: "task-2", baseCommit: "head", workspace: workspaceLease });
  projection = apply(projection, "attempt.dispatch-requested", {
    attemptId: "attempt-2", taskId: "task-2", dispatchId: "attempt-2-dispatch", baseCommit: "head", workspace: workspaceLease,
    tool: dispatchTool("attempt-2"), toolHash: "tool-2", planIrHash: projection.revision.irHash,
    taskHash: projection.revision.taskHashes["task-2"].effective, schedulingHash: projection.revision.taskHashes["task-2"].scheduling, dispatchContextHash: sha("f"),
  });
  projection = apply(projection, "plan.amended", amendmentData(projection, {
    taskHashes: { "task-1": { ...projection.revision.taskHashes["task-1"] }, "task-2": { ...projection.revision.taskHashes["task-2"], effective: sha("e") } },
    diff: { added: [], changed: [], rebound: ["task-2"], retired: [], unchanged: ["task-1"] }, supersededAttemptIds: ["attempt-2"],
  }));
  const data = { attemptId: "attempt-2", taskId: "task-2", oldTaskHash: sha("2"), supersededByRevision: 2, evidence: { kind: "terminal", dispatchId: "attempt-2-dispatch", runId: "late-run", asyncDir: "/late", artifactSha256: sha("a") } };
  assert.throws(() => apply(projection, "attempt.superseded", { ...data, extra: true }), /keys/);
  projection = apply(projection, "attempt.superseded", data);
  assert.equal(projection.attempts.get("attempt-2").runId, "late-run");
});

test("requires exact terminal and never-started supersede proof identities", () => {
  function supersede(status) {
    let projection = revisionProjection(["task-1", "task-2"]);
    const workspaceLease = attemptWorkspace("attempt-2");
    projection = apply(projection, "attempt.workspace-allocated", { attemptId: "attempt-2", taskId: "task-2", baseCommit: "head", workspace: workspaceLease });
    projection = apply(projection, "attempt.dispatch-requested", { attemptId: "attempt-2", taskId: "task-2", dispatchId: "attempt-2-dispatch", baseCommit: "head", workspace: workspaceLease, tool: dispatchTool("attempt-2"), toolHash: "tool-2", planIrHash: projection.revision.irHash, taskHash: projection.revision.taskHashes["task-2"].effective, schedulingHash: projection.revision.taskHashes["task-2"].scheduling, dispatchContextHash: sha("a") });
    if (status !== "dispatch-requested") projection = apply(projection, "attempt.bound", { attemptId: "attempt-2", taskId: "task-2", dispatchId: "attempt-2-dispatch", runId: "attempt-2-run", asyncDir: "/attempt-2", sessionFile: "/attempt-2.jsonl" });
    if (status === "waiting-attention") projection = apply(projection, "attempt.attention-requested", { requestId: "request-2", taskId: "task-2", attemptId: "attempt-2", runId: "attempt-2-run", kind: "need_decision", message: "Need decision", projectionVersion: projection.version + 1, createdAt: "2026-07-15T00:00:00.000Z" });
    if (["succeeded", "validated"].includes(status)) projection = apply(projection, "attempt.settled", { attemptId: "attempt-2", outcome: "succeeded", resultCommit: "result-2" });
    if (status === "validated") projection = apply(projection, "attempt.validated", { attemptId: "attempt-2", resultCommit: "result-2", validationHash: "validation-2", evidence: [] });
    return apply(projection, "plan.amended", amendmentData(projection, { taskHashes: { "task-1": { ...projection.revision.taskHashes["task-1"] }, "task-2": { ...projection.revision.taskHashes["task-2"], effective: sha("e") } }, diff: { added: [], changed: [], rebound: ["task-2"], retired: [], unchanged: ["task-1"] }, supersededAttemptIds: ["attempt-2"] }));
  }
  for (const status of ["active", "waiting-attention", "succeeded", "validated"]) {
    const projection = supersede(status);
    const proof = { kind: "terminal", dispatchId: "attempt-2-dispatch", runId: "attempt-2-run", asyncDir: "/attempt-2", artifactSha256: sha("f") };
    const data = { attemptId: "attempt-2", taskId: "task-2", oldTaskHash: sha("2"), supersededByRevision: 2, evidence: proof };
    for (const evidence of [{ ...proof, dispatchId: "wrong" }, { ...proof, runId: "wrong" }, { ...proof, asyncDir: "/wrong" }, { ...proof, extra: true }]) {
      assert.throws(() => apply(projection, "attempt.superseded", { ...data, evidence }), /terminal/);
    }
    assert.equal(apply(projection, "attempt.superseded", data).attempts.get("attempt-2").status, "superseded");
  }
  const projection = supersede("dispatch-requested");
  const data = { attemptId: "attempt-2", taskId: "task-2", oldTaskHash: sha("2"), supersededByRevision: 2, evidence: { kind: "never-started", dispatchId: "attempt-2-dispatch" } };
  assert.throws(() => apply(projection, "attempt.superseded", { ...data, evidence: { kind: "never-started", dispatchId: "wrong" } }), /dispatchId/);
  assert.equal(apply(projection, "attempt.superseded", data).attempts.get("attempt-2").status, "superseded");
});
