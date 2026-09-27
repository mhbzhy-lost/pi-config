import assert from "node:assert/strict";
import test from "node:test";
import { recoverOrphanRun } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/recovery-resume-orchestrator.ts";

const REQUIRED_FIELDS = ["injectionPoint", "initialFacts", "expectedOutcome", "retainedEvidence", "forbiddenMutations", "provenance", "clockStrategy", "processStrategy"];
const GATE_ORDER = ["runAuthorization", "sessionEligibility", "identity", "broker", "workspace", "inventory", "rebind", "lease", "barrier", "replay", "ack"];
const MATRIX = [
  ["resume-before", "runAuthorization"], ["async-started-before", "sessionEligibility"], ["async-started-after", "identity"],
  ["owner-durable-commit-before", "broker"], ["owner-commit-after", "workspace"], ["workspace-validation-before", "workspace"],
  ["workspace-after", "inventory"], ["inventory-read", "inventory"], ["CAS-rebind-before", "rebind"], ["CAS-rebind-after", "rebind"],
  ["lease-commit-before", "lease"], ["lease-after", "lease"], ["barrier-before", "barrier"], ["barrier-after", "barrier"],
  ["transport-ACK-before", "replay"], ["processing-ACK-after", "ack"],
].map(([injectionPoint, gate]) => ({
  injectionPoint,
  initialFacts: { runId: "matrix-run", ownerReceiptId: "receipt", injectionGate: gate },
  expectedOutcome: { kind: "blocked-unknown", runId: "matrix-run" },
  retainedEvidence: "redacted provenance",
  forbiddenMutations: ["terminal", "stopped", "disposition"],
  provenance: { source: "trusted fixture", sensitive: false },
  clockStrategy: "injected fixed clock",
  processStrategy: "fixture capture seam，不模拟 OS PID reuse",
}));
const MATRIX_GATES = [
  "runAuthorization", "sessionEligibility", "identity", "broker", "workspace", "workspace", "inventory", "inventory",
  "rebind", "rebind", "lease", "lease", "barrier", "barrier", "replay", "ack",
];

function gatesFor(overrides = {}) {
  return Object.fromEntries(GATE_ORDER.map((name) => [name, overrides[name] ?? (() => undefined)]));
}

test("crash matrix is serial, enumerable, and every row has the eight required fields", () => {
  assert.equal(MATRIX.length, 16);
  for (const row of MATRIX) {
    assert.deepEqual(Object.keys(row).filter((key) => key !== "gate").sort(), [...REQUIRED_FIELDS].sort());
    assert.equal(row.processStrategy, "fixture capture seam，不模拟 OS PID reuse");
  }
});

test("each injection point fails closed at its corresponding gate without terminal fabrication", async () => {
  for (const [index, row] of MATRIX.entries()) {
    const gate = MATRIX_GATES[index];
    const calls = [];
    const result = await recoverOrphanRun({
      runId: row.initialFacts.runId, ownerReceiptId: row.initialFacts.ownerReceiptId,
      recoveryCache: new Map(), gates: gatesFor({ [gate]: () => { calls.push(gate); return false; } }),
    });
    assert.equal(result.kind, row.expectedOutcome.kind, row.injectionPoint);
    assert.equal(result.runId, row.expectedOutcome.runId, row.injectionPoint);
    assert.equal(calls.length, 1, row.injectionPoint);
    assert.equal(Object.hasOwn(result, "terminal"), false);
    assert.equal(Object.hasOwn(result, "stopped"), false);
    assert.equal(Object.hasOwn(result, "disposition"), false);
    assert.match(result.provenance, /redacted|rejected|gate/i);
  }
});

test("debt injection returns the exact debt branch and retains only safe evidence", async () => {
  const result = await recoverOrphanRun({ runId: "debt-fixture", ownerReceiptId: "receipt", recoveryCache: new Map(), gates: gatesFor({
    replay: () => ({ kind: "debt", debtId: "debt-1" }),
  }) });
  assert.deepEqual(result, { kind: "debt", runId: "debt-fixture", debtId: "debt-1" });
});

test("same PID with a different processBirth from trusted capture seam is blocked-unknown", async () => {
  const result = await recoverOrphanRun({ runId: "pid-reuse-fixture", ownerReceiptId: "receipt", recoveryCache: new Map(), gates: gatesFor({
    identity: () => ({ kind: "blocked-unknown", provenance: "processBirth mismatch" }),
  }) });
  assert.equal(result.kind, "blocked-unknown");
  assert.match(result.provenance, /processBirth/);
});

test("expired lease records an independent authority_lease_expired reason", async () => {
  const result = await recoverOrphanRun({ runId: "expired", ownerReceiptId: "receipt", lease: { expiresAt: 1 }, recoveryCache: new Map(), gates: gatesFor() });
  assert.equal(result.kind, "blocked-unknown");
  assert.equal(result.reason, "authority_lease_expired");
  assert.notEqual(result.reason, "normal_stop");
  assert.notEqual(result.reason, "progress_stalled");
  assert.notEqual(result.reason, "explicit_stop");
});

test("duplicate recovery shares its promise and executes gates once", async () => {
  const recoveryCache = new Map();
  let count = 0;
  const gates = gatesFor({ runAuthorization: async () => { count += 1; } });
  const input = { runId: "duplicate", ownerReceiptId: "receipt", recoveryCache, gates };
  const [first, second] = await Promise.all([recoverOrphanRun(input), recoverOrphanRun(input)]);
  assert.deepEqual(first, second);
  assert.equal(count, 1);
});

test("heartbeat/progress-stall spies remain untouched and identity is immutable", async () => {
  const identity = { runId: "heartbeat", ownerGeneration: 3, processIncarnationId: "inc-1", sessionFile: "/tmp/session" };
  const calls = Object.fromEntries(["send", "sendUserMessage", "triggerTurn", "followUp", "steer", "reply", "resume", "spawn"].map((name) => [name, 0]));
  const spies = Object.fromEntries(Object.keys(calls).map((name) => [name, () => { calls[name] += 1; }]));
  const before = structuredClone(identity);
  const result = await recoverOrphanRun({ runId: identity.runId, ownerReceiptId: "receipt", recoveryCache: new Map(), gates: gatesFor({
    identity: () => ({ identity }),
    lease: () => ({ kind: "blocked-unknown", provenance: "progress_stalled" }),
  }) });
  assert.equal(result.kind, "blocked-unknown");
  assert.deepEqual(identity, before);
  assert.deepEqual(calls, { send: 0, sendUserMessage: 0, triggerTurn: 0, followUp: 0, steer: 0, reply: 0, resume: 0, spawn: 0 });
});
