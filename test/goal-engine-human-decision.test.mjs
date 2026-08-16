import assert from "node:assert/strict";
import test from "node:test";
import {
  createRuntimeActivationChallenge,
  hashGoalMetadataProposal,
  recordHumanChoice,
  createExecutionAmendmentChallenge,
  issueUserExecutionCapability,
} from "../scripts/lib/goal-engine/human-decision.mjs";

function challenge(overrides = {}) {
  return {
    id: "decision-1",
    kind: "orphan_disposition",
    sessionId: "session-1",
    requestedAt: "2026-08-05T00:00:00.000Z",
    choices: ["discard", "preserve"],
    ...overrides,
  };
}

function inputEvent(overrides = {}) {
  return {
    id: "entry-1",
    role: "user",
    source: "interactive",
    sessionId: "session-1",
    occurredAt: "2026-08-05T00:00:01.000Z",
    text: "discard",
    ...overrides,
  };
}

test("records only an exact post-challenge orphan choice from the same real user session", () => {
  assert.deepEqual(recordHumanChoice({
    inputEvent: inputEvent(), challenge: challenge(), sessionId: "session-1",
  }), {
    challengeId: "decision-1",
    kind: "orphan_disposition",
    choice: "discard",
    userEntryId: "entry-1",
    sessionId: "session-1",
    source: "interactive",
  });

  assert.equal(recordHumanChoice({
    inputEvent: inputEvent({ id: "entry-2", source: "rpc", text: "保留" }),
    challenge: challenge(), sessionId: "session-1",
  }).choice, "preserve");
});

test("rejects extension messages cross-session input stale input and ambiguous prose", () => {
  const cases = [
    [inputEvent({ source: "extension" }), /interactive|rpc/],
    [inputEvent({ role: "assistant" }), /user/],
    [inputEvent({ sessionId: "session-2" }), /session/],
    [inputEvent({ occurredAt: "2026-08-04T23:59:59.000Z" }), /after.*challenge/],
    [inputEvent({ text: "discard or preserve" }), /exactly one|exact/],
    [inputEvent({ text: "Earlier I said discard" }), /exactly one|exact/],
    [inputEvent({ text: "discard\npreserve" }), /exactly one|exact/],
  ];
  for (const [input, pattern] of cases) {
    assert.throws(() => recordHumanChoice({ inputEvent: input, challenge: challenge(), sessionId: "session-1" }), pattern);
  }
});

test("runtime activation approval is bound to its post-challenge interactive or RPC user decision", () => {
  const activation = createRuntimeActivationChallenge({
    goalId: "goal-1", contractHash: "a".repeat(64), baseHead: "b".repeat(40), sessionId: "session-1", proposalId: "proposal-1",
  });
  assert.equal(activation.kind, "runtime_activation_approval");
  assert.deepEqual(recordHumanChoice({
    inputEvent: inputEvent({ text: "approve", occurredAt: new Date(Date.parse(activation.requestedAt) + 1).toISOString() }), challenge: activation, sessionId: "session-1",
  }), {
    challengeId: activation.id, kind: "runtime_activation_approval", choice: "approve", goalId: "goal-1",
    contractHash: "a".repeat(64), baseHead: "b".repeat(40), proposalId: "proposal-1", userEntryId: "entry-1", sessionId: "session-1", source: "interactive",
  });
  assert.throws(() => recordHumanChoice({ inputEvent: inputEvent({ occurredAt: activation.requestedAt }), challenge: activation, sessionId: "session-1" }), /after/);
  assert.throws(() => recordHumanChoice({ inputEvent: inputEvent({ sessionId: "other" }), challenge: activation, sessionId: "session-1" }), /session/);
  assert.throws(() => recordHumanChoice({ inputEvent: inputEvent({ source: "extension" }), challenge: activation, sessionId: "session-1" }), /interactive|rpc/);
});

test("execution amendment capability is challenge-bound and single-use", () => {
  const projection = { goalId: "goal-1", executionRevision: 2, sessionId: "session-1" };
  const proposal = { proposalId: "proposal-1", proposalHash: "a".repeat(64), goalId: "goal-1", revision: 2, sessionId: "session-1" };
  const challenge = createExecutionAmendmentChallenge({ projection, proposal });
  const decision = recordHumanChoice({ inputEvent: inputEvent({ text: "approve", occurredAt: new Date(Date.parse(challenge.requestedAt) + 1).toISOString() }), challenge, sessionId: "session-1" });
  const used = new Set(); const capability = issueUserExecutionCapability({ challenge, decision, projection, proposal, nonce: "nonce-1", consumedNonces: used });
  assert.equal(capability.prefix, "goal-user-capability.v1"); assert.equal(used.size, 0);
  assert.equal(issueUserExecutionCapability({ challenge, decision, projection, proposal, nonce: "nonce-1", consumedNonces: used }).nonce, "nonce-1");
  assert.throws(() => issueUserExecutionCapability({ challenge, decision: { ...decision, source: "extension" }, projection, proposal, nonce: "n2" }), /interactive|rpc/);
});

test("hashes normalized goal metadata deterministically and preserves semantic array order", () => {
  const proposal = {
    objective: "  Harden Goal Engine  ",
    scope: ["src", "test"],
    nonGoals: ["Plan Runner"],
    dod: ["All tests pass"],
  };
  const first = hashGoalMetadataProposal(proposal);
  const second = hashGoalMetadataProposal({
    dod: ["All tests pass"], nonGoals: ["Plan Runner"], scope: ["src", "test"], objective: "Harden Goal Engine",
  });
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, second);
  assert.notEqual(first, hashGoalMetadataProposal({ ...proposal, scope: ["test", "src"] }));
});

test("session transfer approval accepts only exact approved choices", () => {
  const transfer = challenge({ kind: "session_transfer_approval", choices: ["approve", "reject"] });
  assert.equal(recordHumanChoice({
    inputEvent: inputEvent({ text: "批准" }), challenge: transfer, sessionId: "session-1",
  }).choice, "approve");
  assert.throws(() => recordHumanChoice({
    inputEvent: inputEvent({ text: "同意" }), challenge: transfer, sessionId: "session-1",
  }), /exact/);
});

test("metadata approval requires a presented proposal hash and explicit approval after challenge", () => {
  const proposalHash = hashGoalMetadataProposal({
    objective: "Harden Goal Engine", scope: ["src"], nonGoals: [], dod: ["Tests pass"],
  });
  const metadataChallenge = challenge({
    kind: "goal_metadata_approval",
    choices: ["approve", "reject"],
    proposalHash,
    proposalPresented: true,
  });

  assert.deepEqual(recordHumanChoice({
    inputEvent: inputEvent({ text: "批准" }), challenge: metadataChallenge, sessionId: "session-1",
  }), {
    challengeId: "decision-1",
    kind: "goal_metadata_approval",
    choice: "approve",
    proposalHash,
    userEntryId: "entry-1",
    sessionId: "session-1",
    source: "interactive",
  });
  assert.throws(() => recordHumanChoice({
    inputEvent: inputEvent({ text: "继续" }), challenge: metadataChallenge, sessionId: "session-1",
  }), /exact/);
  assert.throws(() => recordHumanChoice({
    inputEvent: inputEvent({ text: "批准" }),
    challenge: { ...metadataChallenge, proposalPresented: false }, sessionId: "session-1",
  }), /presented/);
  assert.throws(() => recordHumanChoice({
    inputEvent: inputEvent({ text: "批准" }),
    challenge: { ...metadataChallenge, proposalHash: undefined }, sessionId: "session-1",
  }), /proposalHash/);
});
