import assert from "node:assert/strict";
import test from "node:test";
import {
  issueActionOffer,
  verifyAndConsumeActionOffer,
} from "../src/goal-engine/action-offer.ts";

function projection(overrides = {}) {
  return {
    goalId: "goal-1",
    version: 4,
    actionOffer: null,
    ...overrides,
  };
}

function offeredProjection(offer, overrides = {}) {
  return projection({ version: offer.projectionVersion, actionOffer: offer, ...overrides });
}

const machineAction = {
  tool: "goal_dispatch",
  params: { goal_id: "goal-1", task_id: "t1" },
};

test("issues a persisted action offer bound to goal version session tool and params", () => {
  const offer = issueActionOffer(projection(), machineAction, "session-1");

  assert.match(offer.id, /^[0-9a-f-]{36}$/i);
  assert.match(offer.nonce, /^[0-9a-f-]{36}$/i);
  assert.match(offer.token, /^goal-action\.v1:[a-f0-9]{64}$/);
  assert.equal(offer.goalId, "goal-1");
  assert.equal(offer.projectionVersion, 5);
  assert.equal(offer.sessionId, "session-1");
  assert.deepEqual(offer.params, machineAction.params);
  assert.equal(offer.consumed, false);

  const consumed = verifyAndConsumeActionOffer(offeredProjection(offer), {
    token: offer.token,
    tool: "goal_dispatch",
    params: { task_id: "t1", goal_id: "goal-1" },
    sessionId: "session-1",
  });
  assert.deepEqual(consumed, {
    offerId: offer.id,
    token: offer.token,
    tool: "goal_dispatch",
    sessionId: "session-1",
  });
});

test("rejects replay after the offer was consumed even when the mutation failed later", () => {
  const offer = issueActionOffer(projection(), machineAction, "session-1");
  const consumedProjection = offeredProjection({ ...offer, consumed: true });

  assert.throws(() => verifyAndConsumeActionOffer(consumedProjection, {
    token: offer.token,
    tool: machineAction.tool,
    params: machineAction.params,
    sessionId: "session-1",
  }), /already consumed/);
});

test("rejects token tool params session goal and projection version drift", () => {
  const offer = issueActionOffer(projection(), machineAction, "session-1");
  const current = offeredProjection(offer);
  const valid = { token: offer.token, tool: machineAction.tool, params: machineAction.params, sessionId: "session-1" };

  assert.throws(() => verifyAndConsumeActionOffer(current, { ...valid, token: `${offer.token}0` }), /token/);
  assert.throws(() => verifyAndConsumeActionOffer(current, { ...valid, tool: "goal_accept" }), /tool/);
  assert.throws(() => verifyAndConsumeActionOffer(current, { ...valid, params: { goal_id: "goal-1", task_id: "t2" } }), /params/);
  assert.throws(() => verifyAndConsumeActionOffer(current, { ...valid, sessionId: "session-2" }), /session/);
  assert.throws(() => verifyAndConsumeActionOffer({ ...current, goalId: "goal-2" }, valid), /goal/);
  assert.throws(() => verifyAndConsumeActionOffer({ ...current, version: current.version + 1 }, valid), /version/);
});

test("uses a fresh nonce so repeated status calls supersede stale tokens", () => {
  const first = issueActionOffer(projection(), machineAction, "session-1");
  const second = issueActionOffer(projection(), machineAction, "session-1");

  assert.notEqual(first.nonce, second.nonce);
  assert.notEqual(first.token, second.token);
  assert.throws(() => verifyAndConsumeActionOffer(offeredProjection(second), {
    token: first.token,
    tool: machineAction.tool,
    params: machineAction.params,
    sessionId: "session-1",
  }), /token/);
});
