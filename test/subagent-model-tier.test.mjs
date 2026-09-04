import assert from "node:assert/strict";
import test from "node:test";

import { EXECUTOR_MODEL_BY_TIER, executorModelForTier, normalizeOptionalModelTier } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/model-tier.ts";

test("keeps model tier optional so ordered agent metadata remains the default", () => {
  assert.equal(normalizeOptionalModelTier(undefined), undefined);
});

test("maps explicit tiers to codex-pool primary overrides", () => {
  assert.deepEqual(EXECUTOR_MODEL_BY_TIER, {
    luna: "codex-pool/gpt-5.6-luna",
    terra: "codex-pool/gpt-5.6-terra",
  });
  assert.equal(executorModelForTier("luna"), "codex-pool/gpt-5.6-luna");
  assert.equal(executorModelForTier("terra"), "codex-pool/gpt-5.6-terra");
});

test("rejects unsupported explicit tiers", () => {
  assert.throws(() => normalizeOptionalModelTier("sol"), /modelTier.*not supported/);
});
