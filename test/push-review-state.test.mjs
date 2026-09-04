import assert from "node:assert/strict";
import test from "node:test";
import { createPushReviewState } from "../src/security-gates/push-review-state.ts";

test("首次 push 返回 needs-review round 1", () => {
  const state = createPushReviewState();
  const action = state.determine({ repoKey: "my-repo", diffHash: "abc123" });
  assert.deepEqual(action, { action: "run", round: 1 });
});

test("review 通过后相同 diffHash 返回 allow", () => {
  const state = createPushReviewState();
  state.record({ repoKey: "my-repo", diffHash: "abc123", hasCritical: false, hasImportant: false, round: 1 });
  const action = state.determine({ repoKey: "my-repo", diffHash: "abc123" });
  assert.deepEqual(action, { action: "allow" });
});

test("review 有 critical 且 diffHash 未变返回 deny", () => {
  const state = createPushReviewState();
  state.record({ repoKey: "my-repo", diffHash: "abc123", hasCritical: true, hasImportant: false, round: 1 });
  const action = state.determine({ repoKey: "my-repo", diffHash: "abc123" });
  assert.deepEqual(action, { action: "deny" });
});

test("review 有 important 且 diffHash 未变返回 deny", () => {
  const state = createPushReviewState();
  state.record({ repoKey: "my-repo", diffHash: "abc123", hasCritical: false, hasImportant: true, round: 1 });
  const action = state.determine({ repoKey: "my-repo", diffHash: "abc123" });
  assert.deepEqual(action, { action: "deny" });
});

test("deny 后 diffHash 变化触发 round 2", () => {
  const state = createPushReviewState();
  state.record({ repoKey: "my-repo", diffHash: "abc123", hasCritical: true, hasImportant: false, round: 1 });
  const action = state.determine({ repoKey: "my-repo", diffHash: "def456" });
  assert.deepEqual(action, { action: "run", round: 2 });
});

test("round 2 仍有问题且 diffHash 未变返回 deny", () => {
  const state = createPushReviewState();
  state.record({ repoKey: "my-repo", diffHash: "abc123", hasCritical: true, hasImportant: false, round: 1 });
  state.record({ repoKey: "my-repo", diffHash: "def456", hasCritical: true, hasImportant: false, round: 2 });
  const action = state.determine({ repoKey: "my-repo", diffHash: "def456" });
  assert.deepEqual(action, { action: "allow", reason: "budget-exhausted" });
});

test("round 2 通过后 diffHash 未变返回 allow", () => {
  const state = createPushReviewState();
  state.record({ repoKey: "my-repo", diffHash: "abc123", hasCritical: true, hasImportant: false, round: 1 });
  state.record({ repoKey: "my-repo", diffHash: "def456", hasCritical: false, hasImportant: false, round: 2 });
  const action = state.determine({ repoKey: "my-repo", diffHash: "def456" });
  assert.deepEqual(action, { action: "allow" });
});

test("TTL 过期后重新 review", () => {
  const state = createPushReviewState({ ttlMs: 50 });
  state.record({ repoKey: "my-repo", diffHash: "abc123", hasCritical: false, hasImportant: false, round: 1 });
  state._entries.get("my-repo").timestamp = Date.now() - 100;
  const action = state.determine({ repoKey: "my-repo", diffHash: "abc123" });
  assert.deepEqual(action, { action: "run", round: 1 });
});

test("不同 repo 互不影响", () => {
  const state = createPushReviewState();
  state.record({ repoKey: "repo-a", diffHash: "aaa", hasCritical: true, hasImportant: false, round: 1 });
  const action = state.determine({ repoKey: "repo-b", diffHash: "bbb" });
  assert.deepEqual(action, { action: "run", round: 1 });
});

test("allow 后 diffHash 变化触发新 round 1", () => {
  const state = createPushReviewState();
  state.record({ repoKey: "my-repo", diffHash: "abc123", hasCritical: false, hasImportant: false, round: 1 });
  const action = state.determine({ repoKey: "my-repo", diffHash: "new-hash" });
  assert.deepEqual(action, { action: "run", round: 1 });
});
