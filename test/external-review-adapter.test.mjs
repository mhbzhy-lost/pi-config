import assert from "node:assert/strict";
import test from "node:test";

import { createExternalReviewAdapter } from "../scripts/lib/plan/external-review-adapter.mjs";

test("adapter returns unavailable when reviewer script does not exist", async () => {
  const review = createExternalReviewAdapter({ reviewerPath: "/nonexistent/reviewer.py" });
  const result = await review({ cwd: process.cwd(), inputHead: "HEAD" });
  assert.equal(result.available, false);
  assert.ok(Array.isArray(result.findings));
  assert.equal(result.findings.length, 0);
});

test("adapter returns the expected interface shape", async () => {
  const review = createExternalReviewAdapter({ reviewerPath: "/nonexistent/reviewer.py" });
  const result = await review({ cwd: process.cwd(), inputHead: "HEAD" });
  assert.equal(typeof result.available, "boolean");
  assert.ok(Array.isArray(result.findings));
});
