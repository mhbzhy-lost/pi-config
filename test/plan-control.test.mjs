import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPlanControl } from "../scripts/lib/plan/plan-control.mjs";

async function eventually(read) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { return await read(); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for control artifact");
}

test("control persists a constrained cancel request and accepts only a matching cancelled acknowledgement", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-plan-control-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const control = createPlanControl({ stateRoot: root, id: () => "request-1", now: () => "2026-07-15T00:00:00.000Z", intervalMs: 1, timeoutMs: 100 });

  const pending = control.requestCancel({ planId: "plan-1", runId: "run-1" });
  const request = JSON.parse(await eventually(() => readFile(path.join(root, "var", "plan-runs", "plan-1", "control", "cancel-request.json"), "utf8")));
  assert.deepEqual(request, {
    schemaVersion: "pi-plan-control.v1",
    requestId: "request-1",
    planId: "plan-1",
    runId: "run-1",
    type: "cancel",
    occurredAt: "2026-07-15T00:00:00.000Z",
  });
  await control.writeAck({ ...request, lifecycle: "cancelled", result: "accepted", occurredAt: "2026-07-15T00:00:01.000Z" });
  assert.equal((await pending).lifecycle, "cancelled");
});

test("control rejects escaping identifiers and fails closed on invalid acknowledgements", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-plan-control-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const control = createPlanControl({ stateRoot: root, id: () => "request-1", intervalMs: 1, timeoutMs: 10 });
  await assert.rejects(control.requestCancel({ planId: "../escape", runId: "run-1" }), /planId/i);
  const pending = control.requestCancel({ planId: "plan-1", runId: "run-1" });
  await control.writeAck({ schemaVersion: "pi-plan-control.v1", requestId: "wrong", planId: "plan-1", runId: "run-1", type: "cancel", lifecycle: "cancelled", result: "accepted", occurredAt: "now" });
  await assert.rejects(pending, /timeout|acknowledgement/i);
});
