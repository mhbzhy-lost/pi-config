import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "../packages/pi-subagents-enhanced/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const binding = await jiti.import("../packages/pi-subagents-enhanced/src/subagent-dispatch/terminal-proof-binding.ts");
const broker = await jiti.import("../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts");
const { classifyTerminalProofBinding } = binding;
const { deliveryOutcome } = broker;

assert.equal(typeof classifyTerminalProofBinding, "function", "classifyTerminalProofBinding 必须已导出");
assert.equal(typeof deliveryOutcome, "function", "deliveryOutcome 必须已导出");

function deps({ listOwned, readLedger = () => [], buildTerminalProof, readCrossScope }) {
  const calls = { debt: [], enqueue: [], record: [] };
  const value = {
    client: {
      listOwned,
      recordTerminalProof: async (value) => { calls.record.push(value); return { receiptId: "r-1" }; },
    },
    proofOutbox: {
      recordDebt: async (value) => calls.debt.push(value),
      enqueue: async (value) => calls.enqueue.push(value),
    },
    readLedger,
    run: { runId: "run-1", pid: 4242, asyncDir: "/tmp/async/run-1" },
    proof: { runnerProcessInstanceId: "" },
    proofId: "p".repeat(64),
    proofOwnerScope: { kind: "standalone-subagent", rootSessionId: "root-1" },
    rootSessionId: "root-1",
    buildTerminalProof,
  };
  // readCrossScope 仅在显式提供时写入，以便测试「依赖缺失」必须 fail-closed 记债。
  if (readCrossScope !== undefined) value.readCrossScope = readCrossScope;
  return { calls, deps: value };
}

test("deliveryOutcome 显式透传 not-applicable，未知仍为 debt", () => {
  assert.deepEqual(deliveryOutcome({ state: "not-applicable", reason: "no workspace" }), { state: "not-applicable", reason: "no workspace" });
  assert.equal(deliveryOutcome({ state: "not-applicable", reason: " " }).state, "not-applicable");
  assert.equal(deliveryOutcome({ state: "unknown" }).state, "debt");
});

test("合法空绑定为 not-applicable 且不产生 debt/enqueue", async () => {
  // not-applicable 必须建立在一个成功的跨 scope 复查上，而不是依赖缺失/失败。
  const { deps, calls } = depsFor(async () => [], undefined, () => []);
  const result = await classifyTerminalProofBinding(deps);
  assert.equal(result.state, "not-applicable");
  assert.deepEqual(calls.debt, []);
  assert.deepEqual(calls.enqueue, []);
  assert.deepEqual(calls.record, []);
});

test("跨 scope 复查命中其他 owner 的 workspace 时 fail-closed 记债且不投递", async () => {
  const { deps, calls } = depsFor(async () => [], undefined, () => [{ workspaceId: "w-other-owner" }]);
  const result = await classifyTerminalProofBinding(deps);
  assert.equal(result.state, "debt");
  assert.equal(calls.debt.length, 1);
  assert.match(calls.debt[0].reason, /binding/i);
  assert.deepEqual(calls.enqueue, []);
  assert.deepEqual(calls.record, []);
});

test("readCrossScope 依赖缺失时不得静默退化为 not-applicable", async () => {
  // 可选依赖未接线曾使跨 owner 未解析绑定重新静默（B2）。
  const { deps, calls } = depsFor(async () => []);
  const result = await classifyTerminalProofBinding(deps);
  assert.equal(result.state, "debt");
  assert.equal(calls.debt.length, 1);
  assert.match(calls.debt[0].reason, /binding/i);
  assert.deepEqual(calls.enqueue, []);
  assert.deepEqual(calls.record, []);
});

test("readCrossScope 抛异常时 fail-closed 记债（损坏记录不得吞掉终局）", async () => {
  // ledger.list() 会因任一 scope 下的 MANAGED_WORKSPACE_STORAGE/RECORD/IDENTITY 整体抛错。
  const { deps, calls } = depsFor(async () => [], undefined, () => { throw new Error("MANAGED_WORKSPACE_RECORD: records storage contains a non-regular entry"); });
  const result = await classifyTerminalProofBinding(deps);
  assert.equal(result.state, "debt");
  assert.equal(calls.debt.length, 1);
  assert.deepEqual(calls.enqueue, []);
  assert.deepEqual(calls.record, []);
});

test("readCrossScope 返回非法结构时 fail-closed 记债", async () => {
  for (const crossScope of [null, "w-1", 42, [{}], [{ workspaceId: "" }]]) {
    const { deps, calls } = depsFor(async () => [], undefined, () => crossScope);
    const result = await classifyTerminalProofBinding(deps);
    assert.equal(result.state, "debt", `invalid cross-scope result must be debt: ${JSON.stringify(crossScope)}`);
    assert.equal(calls.debt.length, 1);
    assert.deepEqual(calls.enqueue, []);
    assert.deepEqual(calls.record, []);
  }
});

test("单绑定投递时 proof 保持七字段且 workspaceId 在外层", async () => {
  const buildTerminalProof = () => ({ state: "observed", conflict: false, runId: "run-1", rootSessionId: "root-1", asyncDir: "/tmp/async/run-1", processInstance: "4242", proofId: "p".repeat(64) });
  const { deps, calls } = depsFor(async () => [{ workspaceId: "w-1" }], buildTerminalProof);
  const result = await classifyTerminalProofBinding(deps);
  assert.equal(result.state, "delivered");
  assert.deepEqual(Object.keys(calls.record[0].proof).sort(), ["asyncDir", "conflict", "processInstance", "proofId", "rootSessionId", "runId", "state"]);
  assert.equal(calls.record[0].workspaceId, "w-1");
  assert.equal("workspaceId" in calls.record[0].proof, false);
});

test("非法或多绑定 fail closed 为 debt", async () => {
  for (const listOwned of [null, "w-1", [{}], [{ workspaceId: "" }], [{ workspaceId: "w-1" }, { workspaceId: "w-2" }]]) {
    const { deps, calls } = depsFor(async () => listOwned);
    const result = await classifyTerminalProofBinding(deps);
    assert.equal(result.state, "debt");
    assert.equal(calls.debt.length, 1);
  }
});

function depsFor(listOwned, buildTerminalProof, readCrossScope) {
  return deps({ listOwned, buildTerminalProof, readCrossScope });
}
