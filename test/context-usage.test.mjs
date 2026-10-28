import test from "node:test";
import assert from "node:assert/strict";
import {
  ContextUsageOutputSchema,
  createContextUsageSnapshot,
  createContextUsageToolResult,
} from "../src/context-usage/snapshot.ts";

test("计算当前上下文剩余 token 和观测状态", () => {
  const snapshot = createContextUsageSnapshot(
    { tokens: 102400, contextWindow: 128000, percent: 80 },
  );

  assert.equal(snapshot.tokens, 102400);
  assert.equal(snapshot.remainingTokens, 25600);
  assert.equal(snapshot.percent, 80);
  assert.equal(snapshot.status, "known");
  assert.equal(snapshot.estimated, true);
});

test("高占用时仅返回观测量，不提供 handoff 策略", () => {
  const snapshot = createContextUsageSnapshot(
    { tokens: 115200, contextWindow: 128000, percent: 90 },
  );

  assert.equal(snapshot.status, "known");
  assert.equal(snapshot.remainingTokens, 12800);
  assert.equal("shouldPrepareHandoff" in snapshot, false);
  assert.equal("shouldUrgentlyPrepareHandoff" in snapshot, false);
});

test("上下文使用量未知时不伪造剩余量或阈值状态", () => {
  const snapshot = createContextUsageSnapshot(
    { tokens: null, contextWindow: 128000, percent: null },
  );

  assert.equal(snapshot.tokens, null);
  assert.equal(snapshot.percent, null);
  assert.equal(snapshot.remainingTokens, null);
  assert.equal(snapshot.status, "unknown");
  assert.equal("shouldPrepareHandoff" in snapshot, false);
});

test("工具结果保留完整结构化快照并标记估计值", () => {
  const result = createContextUsageToolResult(
    { tokens: 64000, contextWindow: 128000, percent: 50 },
  );
  const payload = JSON.parse(result.content[0].text);

  assert.equal(result.details.estimated, true);
  assert.equal(payload.contextWindow, 128000);
  assert.equal(payload.remainingTokens, 64000);
  assert.match(result.content[0].text, /估计/);
  assert.equal("totalTokens" in payload, false);
  assert.deepEqual(result.structuredContent, payload);
  assert.equal("note" in result.details, false);
  assert.deepEqual([...ContextUsageOutputSchema.required].sort(), Object.keys(payload).sort());
  for (const field of ["tokens", "percent", "remainingTokens", "remainingRatio"]) {
    assert.deepEqual(ContextUsageOutputSchema.properties[field].anyOf.map((schema) => schema.type), ["number", "null"]);
  }
  assert.equal(ContextUsageOutputSchema.properties.contextWindow.type, "number");
  assert.equal(ContextUsageOutputSchema.properties.estimated.const, true);
  assert.deepEqual(ContextUsageOutputSchema.properties.status.anyOf.map((schema) => schema.const), ["known", "unknown"]);
  for (const field of ["shouldPrepareHandoff", "shouldUrgentlyPrepareHandoff", "handoffPath", "tokensBeforeHandoff", "tokensBeforeUrgentHandoff"]) {
    assert.equal(field in payload, false);
    assert.equal(field in ContextUsageOutputSchema.properties, false);
  }
  assert.equal(ContextUsageOutputSchema.properties.note.type, "string");
});
