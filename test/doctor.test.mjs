import assert from "node:assert/strict";
import test from "node:test";
import { inspectCoordinatorDoctor } from "../scripts/doctor.ts";

test("doctor rejects split brain, unknown queue schema, and unresolved debts", () => {
  const issues = inspectCoordinatorDoctor({
    schemaVersion: "managed-workspace-administration.v1",
    coordinator: { status: "observed", protocol: "old" },
    queue: { items: [] },
    debts: [
      { kind: "state-root-split-brain" },
      { kind: "queue-schema" },
      { kind: "proof" },
      { kind: "delivery" },
      { kind: "cleanup" },
    ],
  });
  assert.match(issues.join("\n"), /protocol|split-brain|schema|proof|delivery|cleanup/);
});

test("doctor accepts an empty isolated coordinator audit", () => {
  assert.deepEqual(inspectCoordinatorDoctor({
    schemaVersion: "managed-workspace-administration.v1",
    coordinator: { status: "missing" }, queue: { items: [] }, debts: [],
  }), []);
});
