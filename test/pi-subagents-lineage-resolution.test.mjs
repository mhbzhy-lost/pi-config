// 计划 docs/plans/2026-11-04-goal-runtime-usability-bugfix.md Task T2 步骤 4：
// 直接 import 模块级导出纯函数 resolvePlanExecutionLineage(intents, record, ref)，
// 覆盖计划列明的全部场景（单跳 / 多跳 / failed·preserved 不构成跳 / 环与深度
// 截断 / ledger 复核不一致 null / ownerScope 过滤 / 无有效跳 superseded=false）。
// intents 形态参考持久 resume intent（integration-resume-intent.v1）的 ledger/
// recoveryStatus 模拟投影；record 为 workspace ledger readOwned 的 receipt 投影。
import assert from "node:assert/strict";
import test from "node:test";

import { resolvePlanExecutionLineage } from "../packages/pi-subagents-enhanced/extensions/subagent-runtime.ts";

const ref = (runId, workspaceId = "ws-1", rootSessionId = "root-1") => ({ runId, workspaceId, rootSessionId });

const hop = ({ sourceRunId, resumedRunId, state = "activated", attempt = 1, workspaceId = "ws-1", leaseId = "lease-1", rootSessionId = "root-1", version = "integration-resume-intent.v1" }) => ({
  version,
  resumeIntentId: `intent-${sourceRunId}-${attempt}`,
  queueItemId: "queue-1",
  sourceRunId,
  sourceProofId: "p".repeat(64),
  sourceAsyncDir: "/var/tmp/async-source",
  resumedRun: resumedRunId === undefined ? null : { runId: resumedRunId, asyncDir: "/var/tmp/async", sessionId: "session-1", pid: 4242, agentProfile: "default" },
  state,
  attempt,
  generation: 1,
  workspaceId,
  leaseId,
  ownerScope: { kind: "standalone-subagent", rootSessionId },
  delivery: { state: "delivered", attempts: 1 },
});

const ledger = ({ runId, workspaceId = "ws-1", leaseId = "lease-1", rootSessionId = "root-1" }) => ({
  workspaceId,
  leaseId,
  owner: { kind: "standalone-subagent", rootSessionId },
  run: { runId, asyncDir: "/var/tmp/async" },
});

test("单跳：superseded=true 返回最终 run 与完整链", () => {
  const resolution = resolvePlanExecutionLineage(
    [hop({ sourceRunId: "run-1", resumedRunId: "run-2" })],
    ledger({ runId: "run-2" }),
    ref("run-1"),
  );
  assert.deepEqual(resolution, {
    run: { runId: "run-2", workspaceId: "ws-1", rootSessionId: "root-1" },
    chain: ["run-1", "run-2"],
    superseded: true,
  });
});

test("多跳：链路逐跳延伸至 ledger 当前 owner run", () => {
  const resolution = resolvePlanExecutionLineage(
    [
      hop({ sourceRunId: "run-1", resumedRunId: "run-2" }),
      hop({ sourceRunId: "run-2", resumedRunId: "run-3", attempt: 2 }),
      hop({ sourceRunId: "run-3", resumedRunId: "run-4", state: "completed", attempt: 3 }),
    ],
    ledger({ runId: "run-4" }),
    ref("run-1"),
  );
  assert.equal(resolution.superseded, true);
  assert.deepEqual(resolution.chain, ["run-1", "run-2", "run-3", "run-4"]);
  assert.equal(resolution.run.runId, "run-4");
  assert.equal(resolution.run.workspaceId, "ws-1");
  assert.equal(resolution.run.rootSessionId, "root-1");
});

test("failed/preserved 的 intent 不构成跳：返回 superseded=false", () => {
  for (const state of ["failed", "preserved"]) {
    const resolution = resolvePlanExecutionLineage(
      [hop({ sourceRunId: "run-1", resumedRunId: "run-2", state })],
      ledger({ runId: "run-1" }),
      ref("run-1"),
    );
    assert.deepEqual(resolution, { run: ref("run-1"), chain: ["run-1"], superseded: false });
  }
  // activated 但 resumedRun.runId 非 string（resumedRun=null）同样不构成跳。
  const malformed = resolvePlanExecutionLineage(
    [hop({ sourceRunId: "run-1", resumedRunId: undefined })],
    ledger({ runId: "run-1" }),
    ref("run-1"),
  );
  assert.deepEqual(malformed, { run: ref("run-1"), chain: ["run-1"], superseded: false });
});

test("环截断：链尾停在被再次指向的 run，不进入死循环", () => {
  const resolution = resolvePlanExecutionLineage(
    [
      hop({ sourceRunId: "run-1", resumedRunId: "run-2" }),
      hop({ sourceRunId: "run-2", resumedRunId: "run-1", attempt: 2 }),
    ],
    ledger({ runId: "run-2" }),
    ref("run-1"),
  );
  assert.equal(resolution.superseded, true);
  assert.deepEqual(resolution.chain, ["run-1", "run-2"]);
});

test("深度超限截断：最多 16 跳；ledger 指向截断点之外返回 null", () => {
  const intents = Array.from({ length: 20 }, (_, index) => hop({ sourceRunId: `run-${index}`, resumedRunId: `run-${index + 1}` }));
  const truncated = resolvePlanExecutionLineage(intents, ledger({ runId: "run-16" }), ref("run-0"));
  assert.equal(truncated.superseded, true);
  assert.equal(truncated.chain.length, 17);
  assert.equal(truncated.run.runId, "run-16");
  const beyond = resolvePlanExecutionLineage(intents, ledger({ runId: "run-20" }), ref("run-0"));
  assert.equal(beyond, null);
});

test("与首跳 workspace/lease 不一致的跳被截断", () => {
  const resolution = resolvePlanExecutionLineage(
    [
      hop({ sourceRunId: "run-1", resumedRunId: "run-2", leaseId: "lease-1" }),
      hop({ sourceRunId: "run-2", resumedRunId: "run-3", leaseId: "lease-other", attempt: 2 }),
    ],
    ledger({ runId: "run-2" }),
    ref("run-1"),
  );
  assert.equal(resolution.superseded, true);
  assert.deepEqual(resolution.chain, ["run-1", "run-2"]);
});

test("ledger 复核：record.run 与链尾不一致、record 缺失、owner 或 lease 不匹配返回 null", () => {
  const intents = [hop({ sourceRunId: "run-1", resumedRunId: "run-2" })];
  assert.equal(resolvePlanExecutionLineage(intents, ledger({ runId: "run-9" }), ref("run-1")), null);
  assert.equal(resolvePlanExecutionLineage(intents, null, ref("run-1")), null);
  assert.equal(resolvePlanExecutionLineage(intents, ledger({ runId: "run-2", rootSessionId: "root-other" }), ref("run-1")), null);
  assert.equal(resolvePlanExecutionLineage(intents, ledger({ runId: "run-2", leaseId: "lease-other" }), ref("run-1")), null);
  assert.equal(resolvePlanExecutionLineage(intents, ledger({ runId: "run-2", workspaceId: "ws-other" }), ref("run-1")), null);
});

test("ownerScope 不匹配（及 workspaceId/version 不匹配）的 intent 被过滤", () => {
  const resolution = resolvePlanExecutionLineage(
    [
      hop({ sourceRunId: "run-1", resumedRunId: "run-2", rootSessionId: "root-other" }),
      hop({ sourceRunId: "run-1", resumedRunId: "run-3", workspaceId: "ws-other", attempt: 2 }),
    ],
    ledger({ runId: "run-1" }),
    ref("run-1"),
  );
  assert.deepEqual(resolution, { run: ref("run-1"), chain: ["run-1"], superseded: false });
  const wrongVersion = resolvePlanExecutionLineage(
    [{ ...hop({ sourceRunId: "run-1", resumedRunId: "run-2" }), version: "other.v1" }],
    ledger({ runId: "run-1" }),
    ref("run-1"),
  );
  assert.deepEqual(wrongVersion, { run: ref("run-1"), chain: ["run-1"], superseded: false });
});

test("无有效跳且复核通过：返回 superseded=false 且非 null", () => {
  const resolution = resolvePlanExecutionLineage([], ledger({ runId: "run-1" }), ref("run-1"));
  assert.notEqual(resolution, null);
  assert.deepEqual(resolution, { run: ref("run-1"), chain: ["run-1"], superseded: false });
  // 非 intents 数组输入与空数组同语义（闭包收集结果恒为数组，此处为纯函数容错）。
  const empty = resolvePlanExecutionLineage(undefined, ledger({ runId: "run-1" }), ref("run-1"));
  assert.deepEqual(empty, { run: ref("run-1"), chain: ["run-1"], superseded: false });
});

test("同一 sourceRunId 取 attempt 最大者", () => {
  const resolution = resolvePlanExecutionLineage(
    [
      hop({ sourceRunId: "run-1", resumedRunId: "run-2", attempt: 1 }),
      hop({ sourceRunId: "run-1", resumedRunId: "run-3", attempt: 2 }),
    ],
    ledger({ runId: "run-3" }),
    ref("run-1"),
  );
  assert.equal(resolution.superseded, true);
  assert.deepEqual(resolution.chain, ["run-1", "run-3"]);
});
