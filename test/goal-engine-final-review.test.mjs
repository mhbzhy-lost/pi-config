import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeFinalReview, persistFinalReviewIntent, recoverFinalReview } from "../scripts/lib/goal-engine/final-review.mjs";

test("final review intent and result recover after reload without a writer lock", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "goal-final-review-"));
  try {
    const intent = { goalId: "g1", reviewId: "r1", manifestHash: "a".repeat(64), approvalEntryId: "entry-1" };
    await persistFinalReviewIntent({ stateRoot, intent });
    const result = await executeFinalReview({ stateRoot, intent, provider: async ({ writerLockHeld }) => {
      assert.equal(writerLockHeld, false);
      return { severity: "none", summary: "ok" };
    } });
    assert.equal(result.status, "recorded");
    assert.deepEqual(await recoverFinalReview({ stateRoot, reviewId: "r1" }), { intent, result });
  } finally { await rm(stateRoot, { recursive: true, force: true }); }
});

test("final review provider failure is redacted", async () => {
  const result = await executeFinalReview({ intent: { goalId: "g", reviewId: "r", manifestHash: "b".repeat(64), approvalEntryId: "entry" }, provider: async () => { throw new Error("secret=top-secret full prompt full response"); } });
  assert.deepEqual(result, { status: "failed", code: "FINAL_REVIEW_PROVIDER_FAILED" });
});
