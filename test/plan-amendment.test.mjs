import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPlanAmendmentService, diffPlanRevisions, validateAmendment } from "../scripts/lib/plan/plan-amendment.mjs";
import { applyEvent } from "../scripts/lib/plan/plan-events.mjs";
import { createPlanRevisionStore } from "../scripts/lib/plan/plan-revision-store.mjs";

function hash(seed) {
  return seed.repeat(64).slice(0, 64);
}

function node(id, { full = id[5] ?? "a", effective = full, scheduling = full, resources = [] } = {}) {
  return { id, resources, hashes: { full: hash(full), effective: hash(effective), scheduling: hash(scheduling) } };
}

function ir(nodes, resourceCapacities = {}) {
  return { nodes, resourceCapacities };
}

function projection({ tasks = [], attempts = [] } = {}) {
  return {
    tasks: new Map(tasks.map(([id, status]) => [id, { status }])),
    attempts: new Map(attempts.map(([id, attempt]) => [id, attempt])),
  };
}

const oldIr = ir([
  node("task-1", { full: "a", effective: "a" }),
  node("task-2", { full: "b", effective: "b", resources: [{ id: "provider", mode: "shared" }] }),
], { provider: 2 });

test("diffs local contract changes separately from global effective rebounds", () => {
  const bodyChangedIr = ir([node("task-1", { full: "a", effective: "a" }), node("task-2", { full: "c", effective: "c" })]);
  const globalContextChangedIr = ir([node("task-1", { full: "a", effective: "d" }), node("task-2", { full: "b", effective: "e" })]);

  assert.deepEqual(diffPlanRevisions(oldIr, bodyChangedIr), {
    added: [], changed: ["task-2"], rebound: [], retired: [], unchanged: ["task-1"],
  });
  assert.deepEqual(diffPlanRevisions(oldIr, globalContextChangedIr), {
    added: [], changed: [], rebound: ["task-1", "task-2"], retired: [], unchanged: [],
  });
});

test("rejects changes to accepted and integrated task contracts but permits repair tasks", () => {
  const accepted = projection({ tasks: [["task-1", "accepted"]] });
  const integrated = projection({ tasks: [["task-1", "pending"]], attempts: [["attempt-1", { taskId: "task-1", status: "integrated" }]] });
  const changed = ir([node("task-1", { full: "c", effective: "c" }), oldIr.nodes[1]], { provider: 2 });
  const repair = ir([...oldIr.nodes, node("task-3", { full: "d", effective: "d" })], { provider: 2 });

  assert.throws(() => validateAmendment({ projection: accepted, oldIr, newIr: changed }), /accepted task contract is immutable: task-1/);
  assert.throws(() => validateAmendment({ projection: integrated, oldIr, newIr: changed }), /integrated task contract is immutable: task-1/);
  assert.doesNotThrow(() => validateAmendment({ projection: accepted, oldIr, newIr: repair }));
});

for (const status of ["workspace-allocated", "dispatch-requested", "active", "waiting-attention", "succeeded", "validated"]) {
  test(`collects ${status} attempts whose effective task contract changes`, () => {
    const current = projection({ attempts: [
      ["attempt-task-2", { taskId: "task-2", status }],
      ["attempt-task-1", { taskId: "task-1", status }],
    ] });
    const changed = ir([oldIr.nodes[0], node("task-2", { full: "c", effective: "c", resources: [{ id: "provider", mode: "shared" }] })], { provider: 2 });

    assert.deepEqual(validateAmendment({ projection: current, oldIr, newIr: changed }).supersededAttemptIds, ["attempt-task-2"]);
  });
}

test("does not collect released or terminal attempts whose effective task contract changes", () => {
  const settled = projection({ attempts: [
    ["attempt-integrated", { taskId: "task-1", status: "integrated" }],
    ...["released", "failed", "cancelled", "blocked", "interrupted"].map((status) => [`attempt-${status}`, { taskId: "task-2", status }]),
  ] });
  const changed = ir([oldIr.nodes[0], node("task-2", { full: "c", effective: "c", resources: [{ id: "provider", mode: "shared" }] })], { provider: 10 });

  assert.deepEqual(validateAmendment({ projection: settled, oldIr, newIr: changed }).supersededAttemptIds, []);
});

test("allows retirement only for pending tasks that have never been attempted", () => {
  const pending = projection({ tasks: [["task-2", "pending"]] });
  const attempted = projection({ tasks: [["task-2", "pending"]], attempts: [["attempt-2", { taskId: "task-2", status: "failed" }]] });
  const accepted = projection({ tasks: [["task-2", "accepted"]] });
  const retired = ir([oldIr.nodes[0]], { provider: 2 });

  assert.doesNotThrow(() => validateAmendment({ projection: pending, oldIr, newIr: retired }));
  assert.throws(() => validateAmendment({ projection: attempted, oldIr, newIr: retired }), /retired task has attempt history: task-2/);
  assert.throws(() => validateAmendment({ projection: accepted, oldIr, newIr: retired }), /accepted task cannot be deleted: task-2/);
});

test("rejects reuse of retired or historical task IDs", () => {
  const historical = projection({
    tasks: [["task-1", "pending"], ["task-2", "retired"]],
    attempts: [["attempt-2", { taskId: "task-2", status: "failed" }]],
  });
  const oldWithoutTaskTwo = ir([oldIr.nodes[0]], { provider: 2 });

  assert.throws(
    () => validateAmendment({ projection: historical, oldIr: oldWithoutTaskTwo, newIr: oldIr }),
    /historical task ID cannot be reused: task-2/,
  );
});

for (const status of ["workspace-allocated", "dispatch-requested", "validated", "succeeded", "blocked", "interrupted"]) {
  test(`rejects resource capacities below ${status} claims`, () => {
    const current = projection({ attempts: [
      ["attempt-2", { taskId: "task-2", status }],
    ] });
    const tooSmall = ir(oldIr.nodes, { provider: 0 });

    assert.throws(() => validateAmendment({ projection: current, oldIr, newIr: tooSmall }), /resource capacity is below active claims: provider/);
  });
}

for (const status of ["succeeded", "blocked", "interrupted"]) {
  test(`does not count ${status} resource claims after workspace release`, () => {
    const current = projection({ attempts: [
      ["attempt-2", { taskId: "task-2", status, workspaceReleased: true }],
    ] });

    assert.doesNotThrow(() => validateAmendment({ projection: current, oldIr, newIr: ir(oldIr.nodes, { provider: 0 }) }));
  });
}

test("rejects resource capacities below open claims, ignores settled claims, and returns new task hashes", () => {
  const active = projection({ attempts: [
    ["attempt-2", { taskId: "task-2", status: "active" }],
    ["attempt-3", { taskId: "task-3", status: "waiting-attention" }],
  ] });
  const withThirdTask = ir([...oldIr.nodes, node("task-3", { full: "c", effective: "c", resources: [{ id: "provider", mode: "shared" }] })], { provider: 2 });
  const tooSmall = ir(withThirdTask.nodes, { provider: 1 });

  assert.throws(() => validateAmendment({ projection: active, oldIr: withThirdTask, newIr: tooSmall }), /resource capacity is below active claims: provider/);
  const settled = projection({ attempts: [
    ...["failed", "cancelled", "integrated"].map((status) => [`attempt-${status}`, { taskId: "task-2", status }]),
  ] });
  assert.doesNotThrow(() => validateAmendment({ projection: settled, oldIr, newIr: ir(oldIr.nodes, { provider: 0 }) }));
  assert.deepEqual(validateAmendment({ projection: projection(), oldIr, newIr: oldIr }).taskHashes, {
    "task-1": { full: oldIr.nodes[0].hashes.full, effective: oldIr.nodes[0].hashes.effective, scheduling: oldIr.nodes[0].hashes.scheduling },
    "task-2": { full: oldIr.nodes[1].hashes.full, effective: oldIr.nodes[1].hashes.effective, scheduling: oldIr.nodes[1].hashes.scheduling },
  });
});

function amendmentSource({ revision, parentPlanHash, taskTwoBody }) {
  return `# Amendment service fixture

This approved plan exercises the amendment protocol.

## Execution Contract

\`\`\`json
{"schemaVersion":"pi-plan.v3","revision":${revision},"parentPlanHash":${JSON.stringify(parentPlanHash)},"verification":[{"id":"plan:test","command":"node --test","cwd":".","timeoutMs":900000}],"requiredGates":["deterministic","plan-audit","external-review","final-completeness"],"resourceCapacities":{},"executionDefaults":{"agent":"executor","risk":"normal","workflow":{"mode":"inherit-repository"},"timeoutMs":900000},"taskExecution":{"task-1":{},"task-2":{}},"taskAcceptance":{"task-1":{"strategy":"commands","commandIds":["plan:test"]},"task-2":{"strategy":"commands","commandIds":["plan:test"]}}}
\`\`\`

### Task 1: Stable task

**Files:**
- Modify: \`src/one.mjs\`

Keep this task ${taskTwoBody}.

### Task 2: Mutable task

**Files:**
- Modify: \`src/two.mjs\`

${taskTwoBody}
`;
}

async function amendmentHarness({ appendError, pointerError, supersedeError, attention = { status: "resolved", blocking: true }, mutateRevision } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-amendment-service-"));
  const store = createPlanRevisionStore({ stateRoot: root, now: () => "2026-07-29T00:00:00.000Z" });
  const initial = await store.prepareRevision({
    planId: "plan-amendment", sourceBytes: Buffer.from(amendmentSource({ revision: 1, parentPlanHash: null, taskTwoBody: "original contract" })),
    reason: "initial-approval", initiator: { kind: "launcher" },
  });
  const current = {
    planId: "plan-amendment", version: 7, lifecycle: "running", gates: new Map(), workspace: null,
    validatedHead: null, eventIds: new Set(),
    revision: { number: 1, manifestSha256: initial.manifestSha256, ...initial.manifest, taskHashes: initial.manifest.taskHashes },
    tasks: new Map([["task-1", { status: "pending" }], ["task-2", { status: "pending" }]]),
    attempts: new Map([
      ["attempt-1", { taskId: "task-1", status: "workspace-allocated" }],
      ["attempt-2", { taskId: "task-2", taskHash: initial.manifest.taskHashes["task-2"].effective, runId: "run-2", status: "active", attention: { requestId: "request-2", ...attention } }],
    ]),
    amendmentRequestIds: new Set(),
  };
  const originalReadRevision = store.readRevision.bind(store);
  const calls = [];
  const appendedEvents = [];
  const revisionStore = {
    async readRevision(...args) { calls.push("read"); const revision = await originalReadRevision(...args); return mutateRevision ? mutateRevision(structuredClone(revision)) : revision; },
    async prepareRevision(...args) { calls.push("prepare"); return store.prepareRevision(...args); },
    async writeCurrent(...args) { calls.push("writeCurrent"); if (pointerError) throw pointerError; return store.writeCurrent(...args); },
  };
  const service = createPlanAmendmentService({
    revisionStore,
    currentProjection: () => current,
    eventWriter: { async append(event) {
      calls.push("append");
      appendedEvents.push(event);
      if (appendError) throw appendError;
      const applied = applyEvent(current, {
        schemaVersion: "pi-plan-event.v1", eventId: "event-amendment", planId: event.planId,
        occurredAt: "2026-07-29T00:00:01.000Z", type: event.type, data: event.data,
      });
      Object.assign(current, applied);
      return event;
    } },
    async supersedeAttempt(input) { calls.push(`supersede:${input.attemptId}:${input.expectedTaskHash}`); if (typeof supersedeError === "function" ? supersedeError(input) : supersedeError) throw typeof supersedeError === "function" ? supersedeError(input) : supersedeError; },
  });
  return { root, current, calls, appendedEvents, service, source: amendmentSource({ revision: 2, parentPlanHash: initial.manifest.planHash, taskTwoBody: "amended contract" }) };
}

test("requires exactly one resolved blocking authorization before reading", async () => {
  const fixture = await amendmentHarness();
  try {
    fixture.current.attempts.set("attempt-3", {
      taskId: "task-2", status: "active", attention: { requestId: "request-2", status: "resolved", blocking: true },
    });
    await assert.rejects(
      fixture.service.amend({ expectedProjectionVersion: 7, baseRevision: 1, requestId: "request-2", reason: "approved scope change", source: fixture.source }),
      /exactly one resolved blocking Supervisor request/,
    );
    assert.deepEqual(fixture.calls, []);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("continues supersede cleanup after pointer repair fails", async () => {
  const fixture = await amendmentHarness({ pointerError: new Error("pointer rejected") });
  try {
    await assert.rejects(
      fixture.service.amend({ expectedProjectionVersion: 7, baseRevision: 1, requestId: "request-2", reason: "approved scope change", source: fixture.source }),
      AggregateError,
    );
    assert.equal(fixture.calls.filter((call) => call.startsWith("supersede:")).length, 2);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("commits a validated v3 amendment before pointer and supersede cleanup", async () => {
  const fixture = await amendmentHarness();
  try {
    const result = await fixture.service.amend({ expectedProjectionVersion: 7, baseRevision: 1, requestId: "request-2", reason: "approved scope change", source: fixture.source });
    assert.equal(result.revision, 2);
    assert.deepEqual(result.supersededAttemptIds, ["attempt-1", "attempt-2"]);
    assert.deepEqual(fixture.calls.slice(0, 4), ["read", "prepare", "append", "writeCurrent"]);
    assert.match(fixture.calls[4], /^supersede:attempt-1:[a-f0-9]{64}$/);
    assert.match(fixture.calls[5], /^supersede:attempt-2:[a-f0-9]{64}$/);
    assert.equal(fixture.current.revision.number, 2);
    assert.equal(fixture.current.attempts.get("attempt-1").status, "supersede-requested");
    assert.equal(fixture.current.attempts.get("attempt-2").status, "supersede-requested");
    assert.equal(fixture.current.revision.parentRevision, undefined);
    assert.equal(fixture.appendedEvents[0].data.revision, 2);
    assert.equal(fixture.appendedEvents[0].data.parentRevision, 1);
    assert.equal(fixture.appendedEvents[0].data.planHash, fixture.current.revision.planHash);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("rejects invalid direct amendment inputs before reading a revision", async () => {
  const fixture = await amendmentHarness();
  try {
    const valid = { expectedProjectionVersion: 7, baseRevision: 1, requestId: "request-2", reason: "approved scope change", source: fixture.source };
    for (const input of [
      { ...valid, expectedProjectionVersion: 0 }, { ...valid, source: "" }, { ...valid, source: " \n\t " },
      { ...valid, reason: "x".repeat(4097) }, { ...valid, source: "x".repeat(1024 * 1024 + 1) },
    ]) await assert.rejects(fixture.service.amend(input), /invalid Plan amendment (projection version|source|reason)/);
    assert.deepEqual(fixture.calls, []);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

for (const [label, mutateRevision] of [
  ["planId", (revision) => { revision.planId = "other-plan"; }],
  ["revision", (revision) => { revision.revision = 9; }],
  ["manifestSha256", (revision) => { revision.manifestSha256 = hash("f"); }],
  ["manifest.planId", (revision) => { revision.manifest.planId = "other-plan"; }],
  ["manifest.revision", (revision) => { revision.manifest.revision = 9; }],
  ["manifest.sourceBytesSha256", (revision) => { revision.manifest.sourceBytesSha256 = hash("f"); }],
  ["manifest.planHash", (revision) => { revision.manifest.planHash = hash("f"); }],
  ["manifest.irVersion", (revision) => { revision.manifest.irVersion = "other-version"; }],
  ["manifest.irHash", (revision) => { revision.manifest.irHash = hash("f"); }],
  ["ir.version", (revision) => { revision.ir.version = "other-version"; }],
  ["ir.hash", (revision) => { revision.ir.hash = hash("f"); }],
]) {
  test(`rejects a mismatched current revision ${label} before preparation`, async () => {
    const fixture = await amendmentHarness({ mutateRevision });
    try {
      await assert.rejects(fixture.service.amend({ expectedProjectionVersion: 7, baseRevision: 1, requestId: "request-2", reason: "approved scope change", source: fixture.source }), /revision identity mismatch/);
      assert.deepEqual(fixture.calls, ["read"]);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });
}

test("fails closed before preparation for invalid input, authorization, and revision chains", async () => {
  const fixture = await amendmentHarness();
  try {
    await assert.rejects(fixture.service.amend({ expectedProjectionVersion: 7, baseRevision: 1, requestId: "request-2", reason: "x", source: fixture.source, ir: {} }), /input keys/);
    fixture.current.attempts.get("attempt-2").attention = { requestId: "request-2", status: "pending", blocking: true };
    await assert.rejects(fixture.service.amend({ expectedProjectionVersion: 7, baseRevision: 1, requestId: "request-2", reason: "x", source: fixture.source }), /resolved blocking/);
    fixture.current.attempts.get("attempt-2").attention = { requestId: "request-2", status: "resolved", blocking: true };
    await assert.rejects(fixture.service.amend({ expectedProjectionVersion: 7, baseRevision: 1, requestId: "request-2", reason: "x", source: fixture.source.replace('"revision":2', '"revision":3') }), /revision chain/);
    assert.deepEqual(fixture.calls, ["read"]);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

for (const [label, options, expected] of [
  ["append rejection", { appendError: new Error("append rejected") }, ["read", "prepare", "append"]],
  ["pointer rejection", { pointerError: new Error("pointer rejected") }, ["read", "prepare", "append", "writeCurrent"]],
  ["supersede rejection", { supersedeError: (input) => input.attemptId === "attempt-1" ? new Error("stop rejected") : null }, ["read", "prepare", "append", "writeCurrent"]],
]) {
  test(`preserves commit ordering on ${label}`, async () => {
    const fixture = await amendmentHarness(options);
    try {
      await assert.rejects(fixture.service.amend({ expectedProjectionVersion: 7, baseRevision: 1, requestId: "request-2", reason: "approved scope change", source: fixture.source }), ["pointer rejection", "supersede rejection"].includes(label) ? AggregateError : new RegExp(label.split(" ")[0]));
      assert.deepEqual(fixture.calls.slice(0, expected.length), expected);
      if (["pointer rejection", "supersede rejection"].includes(label)) assert.deepEqual(fixture.calls.slice(4).map((call) => call.split(":").slice(0, 2).join(":")), ["supersede:attempt-1", "supersede:attempt-2"]);
      else assert.equal(fixture.calls.some((call) => call.startsWith("supersede:")), false);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });
}
