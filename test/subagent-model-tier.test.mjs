import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MODEL_TIER,
  EXECUTOR_MODEL_BY_TIER,
  executorModelForTier,
  normalizeModelTier,
} from "../scripts/lib/subagent-dispatch/model-tier.ts";

import { CodingDispatchContractError } from "../scripts/lib/subagent-dispatch/ir.ts";

test("normalizes missing model tier to luna", () => {
  assert.equal(DEFAULT_MODEL_TIER, "luna");
  assert.equal(normalizeModelTier(undefined), "luna");
});

test("maps executor model tiers to concrete Codex models", () => {
  assert.deepEqual(EXECUTOR_MODEL_BY_TIER, {
    luna: "openai-codex/gpt-5.6-luna",
    terra: "openai-codex/gpt-5.6-terra",
  });
  assert.equal(executorModelForTier("luna"), "openai-codex/gpt-5.6-luna");
  assert.equal(executorModelForTier("terra"), "openai-codex/gpt-5.6-terra");
});

test("rejects unsupported model tiers with coding contract errors", () => {
  assert.throws(
    () => normalizeModelTier("sol"),
    (error) => {
      assert.equal(error instanceof CodingDispatchContractError, true);
      assert.equal(error.code, "INVALID_CONTRACT");
      assert.equal(error.detail, "modelTier");
      return true;
    },
  );
});
