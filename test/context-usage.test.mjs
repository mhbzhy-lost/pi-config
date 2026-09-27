import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_HANDOFF_POLICY,
  createContextUsageSnapshot,
  createContextUsageToolResult,
  validateHandoffPolicy,
} from "../src/context-usage/snapshot.ts";

test("计算当前上下文剩余 token 和 handoff 状态", () => {
  const snapshot = createContextUsageSnapshot(
    { tokens: 102400, contextWindow: 128000, percent: 80 },
    DEFAULT_HANDOFF_POLICY,
  );

  assert.equal(snapshot.tokens, 102400);
  assert.equal(snapshot.remainingTokens, 25600);
  assert.equal(snapshot.percent, 80);
  assert.equal(snapshot.status, "prepare-handoff");
  assert.equal(snapshot.estimated, true);
});

test("达到 urgent 阈值时要求立即完成 handoff", () => {
  const snapshot = createContextUsageSnapshot(
    { tokens: 115200, contextWindow: 128000, percent: 90 },
    DEFAULT_HANDOFF_POLICY,
  );

  assert.equal(snapshot.status, "urgent-handoff");
  assert.equal(snapshot.shouldPrepareHandoff, true);
  assert.equal(snapshot.shouldUrgentlyPrepareHandoff, true);
});

test("上下文使用量未知时不伪造剩余量或阈值状态", () => {
  const snapshot = createContextUsageSnapshot(
    { tokens: null, contextWindow: 128000, percent: null },
    DEFAULT_HANDOFF_POLICY,
  );

  assert.equal(snapshot.tokens, null);
  assert.equal(snapshot.percent, null);
  assert.equal(snapshot.remainingTokens, null);
  assert.equal(snapshot.status, "unknown");
  assert.equal(snapshot.shouldPrepareHandoff, false);
});

test("工具结果保留完整结构化快照并标记估计值", () => {
  const result = createContextUsageToolResult(
    { tokens: 64000, contextWindow: 128000, percent: 50 },
    DEFAULT_HANDOFF_POLICY,
  );
  const payload = JSON.parse(result.content[0].text);

  assert.equal(result.details.estimated, true);
  assert.equal(payload.contextWindow, 128000);
  assert.equal(payload.remainingTokens, 64000);
  assert.match(result.content[0].text, /估计/);
  assert.equal("totalTokens" in payload, false);
});

test("拒绝无效 handoff 阈值配置", () => {
  assert.throws(
    () => validateHandoffPolicy({ handoffRatio: 0.9, urgentRatio: 0.8 }),
    /urgentRatio/,
  );
  assert.throws(
    () => validateHandoffPolicy({ handoffRatio: 1.1, urgentRatio: 1.2 }),
    /handoffRatio/,
  );
});
