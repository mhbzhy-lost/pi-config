import assert from "node:assert/strict";
import test from "node:test";
import { applyEvent, createProjection } from "../scripts/lib/goal-engine/events.mjs";

function event(type, data, occurredAt) {
  return { schemaVersion: "planned.v1", eventId: crypto.randomUUID(), goalId: "transfer-goal", type, occurredAt, data };
}

test("approved session transfer advances the owner without exposing a second binding", () => {
  let projection = applyEvent(createProjection(), event("goal.created", {
    objective: "Transfer fixture", scope: [], nonGoals: [], dod: [], tasks: ["t"],
    taskDefs: { t: { description: "t", deps: [], writePaths: ["src/a"], workflow: "tdd", acceptance: { criteria: [{ id: "c", statement: "passes", evidenceKinds: ["tests"] }] } } },
  }, "2026-08-10T00:00:00.000Z"));
  projection = applyEvent(projection, event("goal.session_bound", { sessionId: "A", leafId: "a" }, "2026-08-10T00:00:01.000Z"));
  projection = applyEvent(projection, event("goal.session_transferred", {
    fromSessionId: "A", toSessionId: "B", challengeId: "challenge", reason: "approved", ownershipRevision: 2,
  }, "2026-08-10T00:00:02.000Z"));
  assert.equal(projection.sessionBindings[0].sessionId, "B");
  assert.equal(projection.ownershipRevision, 2);
});
