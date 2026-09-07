import assert from "node:assert/strict";
import test from "node:test";

import {
  ModelSelectionError,
  resolveModelSelection,
} from "../packages/pi-subagents-enhanced/src/subagent-dispatch/model-selection.ts";

const availableModels = [
  { provider: "codex-pool", id: "gpt-5.6-sol" },
  { provider: "openai", id: "gpt-5.6-sol" },
  { provider: "codex-pool", id: "gpt-5.6-luna" },
];

function selection(overrides = {}) {
  return resolveModelSelection({
    agentName: "delegate",
    availableModels,
    ...overrides,
  });
}

function expectModelSelectionFailure(operation) {
  assert.throws(operation, (error) => {
    assert.equal(error instanceof ModelSelectionError, true);
    assert.equal(error.code, "MODEL_NOT_AVAILABLE");
    return true;
  });
}

test("leaves model unset when no request is supplied", () => {
  assert.deepEqual(selection(), { source: "default" });
  assert.deepEqual(selection({ requestedModel: "   " }), { source: "default" });
});

test("accepts only an exact qualified model from the available catalog", () => {
  assert.deepEqual(selection({ requestedModel: " codex-pool/gpt-5.6-sol " }), {
    model: "codex-pool/gpt-5.6-sol",
    source: "qualified",
  });

  expectModelSelectionFailure(() => selection({ requestedModel: "other-pool/gpt-5.6-sol" }));
  expectModelSelectionFailure(() => selection({ requestedModel: "codex-pool/gpt-5.6-solar" }));
});

test("uses the first currently available declared agent candidate for a bare model ID", () => {
  assert.deepEqual(selection({
    requestedModel: "gpt-5.6-luna",
    agentModels: ["codex-pool/gpt-5.6-luna", "openai-codex/gpt-5.6-luna", "alpha/gpt-5.6-luna"],
    availableModels: [
      { provider: "alpha", id: "gpt-5.6-luna" },
      { provider: "openai-codex", id: "gpt-5.6-luna" },
    ],
  }), {
    model: "openai-codex/gpt-5.6-luna",
    source: "agent-candidates",
  });
});

test("fails a bare candidate miss without selecting outside the agent candidates", () => {
  expectModelSelectionFailure(() => resolveModelSelection({
    requestedModel: "gpt-5.6-sol",
    agentName: "delegate",
    agentModels: ["codex-pool/gpt-5.6-luna"],
    availableModels: [{ provider: "openai-codex", id: "gpt-5.6-sol" }],
  }));
});

test("resolves bare IDs from a canonically sorted global catalog and warns", () => {
  assert.deepEqual(resolveModelSelection({
    requestedModel: "gpt-5.6-sol",
    agentName: "delegate",
    availableModels: [
      { provider: "openai", id: "gpt-5.6-sol" },
      { provider: "codex-pool", id: "gpt-5.6-sol" },
    ],
  }), {
    model: "codex-pool/gpt-5.6-sol",
    source: "global-catalog",
    warnings: [{
      code: "MODEL_MATCH_USED_GLOBAL_CATALOG",
      agent: "delegate",
      requestedModel: "gpt-5.6-sol",
      resolvedModel: "codex-pool/gpt-5.6-sol",
    }],
  });
});

test("fails when a bare ID has no agent candidates or global catalog match", () => {
  expectModelSelectionFailure(() => selection({ requestedModel: "gpt-5.6-terra" }));
});
