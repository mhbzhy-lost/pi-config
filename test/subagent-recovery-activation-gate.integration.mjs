import assert from "node:assert/strict";
import { unlink } from "node:fs/promises";
import test from "node:test";

import integrationQueue, { awaitIntegrationActivationGate, resetIntegrationCompletionGuardsForTest, ACTIVATION_GATE_TIMEOUT_MS } from "../packages/pi-subagents-enhanced/child-extensions/integration-queue.ts";
import { brokerGrantPath, writeBrokerGrant } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-protocol.ts";

const TOKEN = "b".repeat(64);

class Bus {
  handlers = new Map();
  on(type, fn) { const list = this.handlers.get(type) ?? []; list.push(fn); this.handlers.set(type, list); return () => list.splice(list.indexOf(fn), 1); }
  async emit(type) { for (const fn of [...this.handlers.get(type) ?? []]) await fn({}); }
}

function fakePi() {
  const bus = new Bus();
  return {
    bus,
    registerTool: () => undefined,
    getActiveTools: () => [],
    setActiveTools: () => undefined,
    on: bus.on.bind(bus),
    sendMessage: async () => undefined,
  };
}

function fakeCoordinator({ inspectImpl } = {}) {
  const calls = [];
  return {
    calls,
    async inspectAutoIntegration(input) { calls.push(["inspect", input]); return inspectImpl ? inspectImpl(calls) : { queueState: "absent" }; },
    async prepareAutoIntegration() { calls.push(["prepare"]); return { queueState: "queued", workspaceState: "active" }; },
    async advanceAutoIntegration(input) { calls.push(["advance", input]); return { queueState: "completed", workspaceState: "active", integrationReceipt: true }; },
    async inspectIntegrationState() { calls.push(["inspect_state"]); return { queueState: "completed", workspaceState: "released", integrationReceipt: true, proofState: "accepted" }; },
    async preserveIntegrationDebt(_binding, reason) { calls.push(["preserve", reason]); },
  };
}

async function writeGrant(rootSessionId, runId, capabilities = ["root.subscribe"]) {
  await writeBrokerGrant({ schemaVersion: "pi-root-subagent-broker-grant.v2", rootSessionId, runId, callerToken: TOKEN, capabilities });
  return brokerGrantPath(rootSessionId, runId);
}

function install(options) {
  const pi = fakePi();
  const extension = integrationQueue(pi, {
    coordinator: options.coordinator,
    resolveBinding: () => ({ runId: options.runId }),
    completionGuardKey: `gate/${options.runId}`,
    activationGateTimeoutMs: options.timeoutMs ?? 2000,
    activationGateRetryDelayMs: options.retryDelayMs ?? 10,
  });
  return { pi, extension };
}

test("默认 gate 超时独立且长于 root-session-owner 的 5s GRANT_NOT_READY 窗口", () => {
  assert.equal(ACTIVATION_GATE_TIMEOUT_MS, 30000);
});

test("grant 先/activation 后：binding 解析延迟时 gate 有界重试后收敛", async (t) => {
  resetIntegrationCompletionGuardsForTest();
  const rootSessionId = "root-gate-a"; const runId = "run-gate-a";
  t.after(async () => { await unlink(brokerGrantPath(rootSessionId, runId)).catch(() => undefined); });
  await writeGrant(rootSessionId, runId);
  process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID = rootSessionId;
  process.env.PI_SUBAGENT_RUN_ID = runId;

  const coordinator = fakeCoordinator();
  let bindingFailures = 0;
  coordinator.inspectAutoIntegration = async (input) => {
    coordinator.calls.push(["inspect", input]);
    if (bindingFailures++ < 2) throw Object.assign(new Error("trusted run binding is unavailable"), { code: "CHILD_BINDING_UNAVAILABLE" });
    return { queueState: "resolving-conflict", workspaceState: "active" };
  };
  const { pi, extension } = install({ coordinator, runId });
  t.after(() => extension.dispose());

  await pi.bus.emit("session_start");
  assert.ok(bindingFailures >= 3, "gate 必须重试 binding 解析");
  const inspects = coordinator.calls.filter(([name]) => name === "inspect");
  assert.equal(inspects.length, bindingFailures);
  // gate 收敛后 lifecycle 创建：agent_end 驱动 prepare+advance。
  await pi.bus.emit("agent_end");
  assert.ok(coordinator.calls.some(([name]) => name === "prepare"));
  assert.ok(coordinator.calls.some(([name]) => name === "advance"));
  assert.equal(coordinator.calls.some(([name]) => name === "preserve"), false);
});

test("activation 先/grant 后：grant 延迟写入时 gate 有界等待后收敛", async (t) => {
  resetIntegrationCompletionGuardsForTest();
  const rootSessionId = "root-gate-b"; const runId = "run-gate-b";
  t.after(async () => { await unlink(brokerGrantPath(rootSessionId, runId)).catch(() => undefined); });
  process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID = rootSessionId;
  process.env.PI_SUBAGENT_RUN_ID = runId;

  const coordinator = fakeCoordinator({ inspectImpl: () => ({ queueState: "queued", workspaceState: "active" }) });
  const { pi, extension } = install({ coordinator, runId });
  t.after(() => extension.dispose());

  const starting = pi.bus.emit("session_start");
  await new Promise((resolve) => setTimeout(resolve, 40));
  await writeGrant(rootSessionId, runId);
  await starting;

  await pi.bus.emit("agent_end");
  assert.ok(coordinator.calls.some(([name]) => name === "prepare"));
  assert.ok(coordinator.calls.some(([name]) => name === "advance"));
  assert.equal(coordinator.calls.some(([name]) => name === "preserve"), false);
});

test("gate 超时 fail closed：无 lifecycle、preserve 记债、不恢复 source 绑定", async (t) => {
  resetIntegrationCompletionGuardsForTest();
  const rootSessionId = "root-gate-c"; const runId = "run-gate-c";
  t.after(async () => { await unlink(brokerGrantPath(rootSessionId, runId)).catch(() => undefined); });
  process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID = rootSessionId;
  process.env.PI_SUBAGENT_RUN_ID = runId;

  const coordinator = fakeCoordinator();
  const { pi, extension } = install({ coordinator, runId, timeoutMs: 60 });
  t.after(() => extension.dispose());

  await pi.bus.emit("session_start");
  const preserves = coordinator.calls.filter(([name]) => name === "preserve");
  assert.equal(preserves.length, 1);
  await pi.bus.emit("agent_end");
  assert.equal(coordinator.calls.some(([name]) => name === "prepare"), false, "超时后不得创建 lifecycle");
  assert.equal(coordinator.calls.some(([name]) => name === "advance"), false);
});

test("acceptance grant 不创建 lifecycle 也不 preserve", async (t) => {
  resetIntegrationCompletionGuardsForTest();
  const rootSessionId = "root-gate-d"; const runId = "run-gate-d";
  t.after(async () => { await unlink(brokerGrantPath(rootSessionId, runId)).catch(() => undefined); });
  await writeGrant(rootSessionId, runId, ["acceptance.submit", "root.subscribe"]);
  process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID = rootSessionId;
  process.env.PI_SUBAGENT_RUN_ID = runId;

  const coordinator = fakeCoordinator();
  const { pi, extension } = install({ coordinator, runId });
  t.after(() => extension.dispose());

  await pi.bus.emit("session_start");
  await pi.bus.emit("agent_end");
  assert.equal(coordinator.calls.some(([name]) => name === "inspect"), false, "acceptance child 不触发 binding 检查");
  assert.equal(coordinator.calls.some(([name]) => name === "preserve"), false);
  assert.equal(coordinator.calls.some(([name]) => name === "advance"), false);
});

test("普通首次 spawn：grant 与 binding 立即可用时 gate 一次通过", async (t) => {
  resetIntegrationCompletionGuardsForTest();
  const rootSessionId = "root-gate-e"; const runId = "run-gate-e";
  t.after(async () => { await unlink(brokerGrantPath(rootSessionId, runId)).catch(() => undefined); });
  await writeGrant(rootSessionId, runId);
  process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID = rootSessionId;
  process.env.PI_SUBAGENT_RUN_ID = runId;

  const coordinator = fakeCoordinator({ inspectImpl: () => ({ queueState: "absent" }) });
  const { pi, extension } = install({ coordinator, runId });
  t.after(() => extension.dispose());

  await pi.bus.emit("session_start");
  assert.equal(coordinator.calls.filter(([name]) => name === "inspect").length, 1, "无重试");
  await pi.bus.emit("agent_end");
  assert.ok(coordinator.calls.some(([name]) => name === "prepare"));
});

test("resolving-conflict 恢复后的 lifecycle 首次 advance 发送空 wire 输入，continue 由 durable queue 状态推导", async (t) => {
  resetIntegrationCompletionGuardsForTest();
  const rootSessionId = "root-gate-f"; const runId = "run-gate-f";
  t.after(async () => { await unlink(brokerGrantPath(rootSessionId, runId)).catch(() => undefined); });
  await writeGrant(rootSessionId, runId);
  process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID = rootSessionId;
  process.env.PI_SUBAGENT_RUN_ID = runId;

  const coordinator = fakeCoordinator({ inspectImpl: () => ({ queueState: "resolving-conflict", workspaceState: "active" }) });
  coordinator.advanceAutoIntegration = async (input) => {
    coordinator.calls.push(["advance", input]);
    return { queueState: "resolving-conflict", workspaceState: "active", conflictDigest: "a".repeat(64), continuationAttempt: 1 };
  };
  const { pi, extension } = install({ coordinator, runId });
  t.after(() => extension.dispose());

  await pi.bus.emit("session_start");
  await pi.bus.emit("agent_end");
  const advances = coordinator.calls.filter(([name]) => name === "advance");
  assert.equal(advances.length, 1);
  assert.deepEqual(advances[0][1], {}, "child wire 输入为空；continue 必须由 coordinator 的 durable resolving-conflict 状态推导");
  // lifecycle 记录 conflict 后进入冲突解决语义（CONFLICT follow-up 或 durable 等待）。
  await pi.bus.emit("agent_settled");
});

test("lifecycle 诊断日志：agent_end→advance 链路打点到 stderr（供真实验收现场定位）", async (t) => {
  resetIntegrationCompletionGuardsForTest();
  const rootSessionId = "root-gate-log"; const runId = "run-gate-log";
  t.after(async () => { await unlink(brokerGrantPath(rootSessionId, runId)).catch(() => undefined); });
  await writeGrant(rootSessionId, runId);
  process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID = rootSessionId;
  process.env.PI_SUBAGENT_RUN_ID = runId;

  const stderrLines = [];
  const coordinator = fakeCoordinator({ inspectImpl: () => ({ queueState: "queued", workspaceState: "active" }) });
  coordinator.advanceAutoIntegration = async (input) => {
    coordinator.calls.push(["advance", input]);
    return { queueState: "completed", workspaceState: "active", integrationReceipt: true };
  };
  const bus = new Bus();
  const pi = {
    registerTool: () => undefined,
    getActiveTools: () => [],
    setActiveTools: () => undefined,
    on: bus.on.bind(bus),
    emit: (type) => bus.emit(type),
    sendMessage: async () => undefined,
    stderr: { write: (line) => stderrLines.push(line) },
  };
  const extension = integrationQueue(pi, {
    coordinator,
    resolveBinding: () => ({ runId }),
    completionGuardKey: `gate-log/${runId}`,
    activationGateTimeoutMs: 500,
    activationGateRetryDelayMs: 10,
  });
  t.after(() => extension.dispose());

  await bus.emit("session_start");
  await bus.emit("agent_end");
  await bus.emit("session_shutdown");

  const phases = stderrLines.map((line) => { try { return JSON.parse(line).phase; } catch { return `raw:${line.slice(0, 40)}`; } });
  assert.ok(phases.includes("integration-gate-passed"), `gate 通过必须打点，实际 ${JSON.stringify(phases)}`);
  assert.ok(phases.some((phase) => String(phase).startsWith("integration-lifecycle-agent-end")), `agent_end 触发必须打点，实际 ${JSON.stringify(phases)}`);
  assert.ok(phases.some((phase) => String(phase).startsWith("integration-lifecycle-advance-result")), `advance 结果必须打点，实际 ${JSON.stringify(phases)}`);
  // 日志不得携带 prompt/凭据。
  for (const line of stderrLines) assert.doesNotMatch(line, /prompt|token|credential|authorization/i);
});
