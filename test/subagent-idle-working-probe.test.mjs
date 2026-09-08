import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readWorkingStateTrace } from "../scripts/probes/subagent-working-state.ts";

test("idle working probe keeps delivery and lifecycle observations unproven without an actual causal identity", () => {
  const directory = mkdtempSync(join(tmpdir(), "subagent-working-probe-"));
  const file = join(directory, "trace.jsonl");
  writeFileSync(file, [
    JSON.stringify({ version: 1, hostSessionId: "host-1", completionOwnerId: "owner-1", event: "host-idle", monotonicMs: 10 }),
    JSON.stringify({ version: 1, hostSessionId: "host-1", completionOwnerId: "owner-1", event: "completion-received", monotonicMs: 12, source: "async", runId: "run-1", eventSessionId: "host-1", eventCompletionOwnerId: "owner-1" }),
    JSON.stringify({ version: 1, hostSessionId: "host-1", completionOwnerId: "owner-1", event: "delivery-result", monotonicMs: 13, runId: "run-1", deliveryResult: "sent", triggerTurn: true }),
    JSON.stringify({ version: 1, hostSessionId: "host-1", completionOwnerId: "owner-1", event: "agent-start", monotonicMs: 14, runId: "run-1" }),
    JSON.stringify({ version: 1, hostSessionId: "host-1", completionOwnerId: "owner-1", event: "agent-settled", monotonicMs: 15, runId: "run-1" }),
    JSON.stringify({ version: 1, hostSessionId: "other", completionOwnerId: "owner-2", event: "agent-start", monotonicMs: 15 }),
  ].join("\n") + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);

  const result = readWorkingStateTrace({ file, hostSessionId: "host-1", maxBytes: 4096, maxRecords: 8, windowMs: 20, outputBudget: 4096 });

  assert.deepEqual(result.records.map((record) => record.event), ["host-idle", "completion-received", "delivery-result", "agent-start", "agent-settled"]);
  assert.equal(result.cause, "unproven");
});

test("idle working probe discards a truncated first line and rejects malformed identity and time order", () => {
  const directory = mkdtempSync(join(tmpdir(), "subagent-working-probe-"));
  const file = join(directory, "trace.jsonl");
  const complete = JSON.stringify({ version: 1, hostSessionId: "host-1", completionOwnerId: "owner-1", event: "host-idle", monotonicMs: 20 });
  writeFileSync(file, `partial\n${complete}\n`, { mode: 0o600 });
  const truncated = readWorkingStateTrace({ file, hostSessionId: "host-1", maxBytes: Buffer.byteLength(complete) + 3, maxRecords: 4, windowMs: 20, outputBudget: 1024 });
  assert.deepEqual(truncated.records, [{ version: 1, hostSessionId: "host-1", completionOwnerId: "owner-1", event: "host-idle", monotonicMs: 20 }]);
  assert.equal(truncated.partialLeadingLine, true);

  writeFileSync(file, `${JSON.stringify({ version: 1, hostSessionId: "host-1", completionOwnerId: "owner-1", event: "queue-update", monotonicMs: 20 })}\n`, { mode: 0o600 });
  assert.equal(readWorkingStateTrace({ file, hostSessionId: "host-1" }).invalidTrace, "invalid-event");

  writeFileSync(file, `${JSON.stringify({ version: 1, hostSessionId: "host-1", completionOwnerId: "owner-1", event: "host-idle", monotonicMs: 20 })}\n${JSON.stringify({ version: 1, hostSessionId: "host-1", completionOwnerId: "owner-1", event: "host-idle", monotonicMs: 19 })}\n`, { mode: 0o600 });
  assert.equal(readWorkingStateTrace({ file, hostSessionId: "host-1" }).invalidTrace, "non-monotonic-time");
});

test("idle working probe ignores a partial final line and returns unproven without a complete causal chain", () => {
  const directory = mkdtempSync(join(tmpdir(), "subagent-working-probe-"));
  const file = join(directory, "trace.jsonl");
  writeFileSync(file, `${JSON.stringify({ version: 1, hostSessionId: "host-1", completionOwnerId: "owner-1", event: "host-idle", monotonicMs: 10 })}\n{`, { mode: 0o600 });
  const result = readWorkingStateTrace({ file, hostSessionId: "host-1", maxBytes: 1024, maxRecords: 4, windowMs: 20, outputBudget: 1024 });
  assert.equal(result.cause, "unproven");
  assert.equal(result.partialTrailingLine, true);
});
