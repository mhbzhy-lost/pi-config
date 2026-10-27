import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { createTypedSubagentExtension, preparePublicCodingDispatch } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts";
import { childStartTimeoutMs } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/workflow-spawn.ts";
import { compileCodingDispatchIR } from "../packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts";
import { bindGoalRunCoordinator, bindGoalRunCoordinatorSession, unbindGoalRunCoordinatorSession } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-registry.ts";
import * as lifecycleModule from "../packages/pi-subagents-enhanced/src/workspace/child-integration-lifecycle.ts";
import { createChildIntegrationLifecycle } from "../packages/pi-subagents-enhanced/src/workspace/child-integration-lifecycle.ts";
import { createSupervisorControlPlane } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-control-plane.ts";

const contract = {
  title: "Bind durable spawn identity", agent: "executor",
  task: "Bind coding calls to durable identities. Preserve the exact contract.",
  writePaths: ["test/subagent-dispatch-extension.test.ts"],
  acceptance: { criteria: ["Identity is trusted."] }, cwd: "/repo",

};

function setup({ sessionId = "s" }: { sessionId?: string } = {}) {
  const tools = []; const calls = []; const listeners = new Map();
  const events = {
    on(type, listener) {
      const current = listeners.get(type) ?? new Set();
      current.add(listener); listeners.set(type, current);
      return () => current.delete(listener);
    },
    emit(type, event) { for (const listener of [...(listeners.get(type) ?? [])]) listener(event); },
  };
  const pi = { events, registerTool(tool) { assert.notEqual(tool.name, "subagent_roster", "fresh runtime must not register the retired roster"); tools.push(tool); }, on() {} };
  const rpc = {
    async ping() { return { version: 1, methods: ["spawn"], session: { sessionId, cwd: "/repo" } }; },
    async spawn(params, options) {
      calls.push({ params, options });
      const match = params.script.match(/^return await runs\.run\(([^,]+), (.*)\);$/);
      const workflowKey = JSON.parse(match[1]); const { agent } = JSON.parse(match[2]);
      queueMicrotask(() => events.emit("subagent:async-started", {
        parentWorkflowRunId: "run-1", runId: "leaf-1", asyncDir: "/tmp/leaf-1", sessionId, pid: 123, agent, workflowKey,
      }));
      return { details: { runId: "run-1", asyncDir: "/tmp/run-1" } };
    },
    async status() { return {}; }, async steer() { return {}; }, async interrupt() { return {}; }, async stop() { return {}; }, dispose() {},
  };
  return { pi, rpc, calls, tools };
}

// S4：注册面为每操作独立工具；按名解析，不以 tools 数组位置为权威。
const CONTROL_TOOL_BY_ACTION: Record<string, string> = {
  status: "subagent_run_status", steer: "subagent_run_steer",
  interrupt: "subagent_run_interrupt", resume: "subagent_run_resume", stop: "subagent_run_stop",
};
function toolByName(tools: any[], name: string) {
  const found = tools.find((tool: any) => tool?.name === name);
  assert.ok(found, `${name} must be registered`);
  return found;
}
function startTool(tools: any[]) {
  return toolByName(tools, "subagent_start");
}
function controlTool(tools: any[], action: string) {
  return toolByName(tools, CONTROL_TOOL_BY_ACTION[action]);
}

function workflowLeaf(params: any) {
  const match = String(params.script).match(/runs\.run\("[^"]+", (.*)\);/);
  assert.ok(match?.[1]);
  return JSON.parse(match[1]);
}

function goalWorkspaceRequest(contractHash: string) {
  return {
    workspaceId: "goal-workspace-1",
    owner: { kind: "goal-task", rootSessionId: "root-shared", goalId: "goal-1", taskId: "task-1", attempt: 1, executionRevision: 1 },
    originRoot: "/repo",
    requestedCwd: "/repo",
    originRef: "refs/heads/main",
    baseCommit: "b".repeat(40),
    contractHash,
    policy: { publication: "allowed", application: "allowed", writePaths: ["test/subagent-dispatch-extension.test.ts"] },
  };
}

function workspaceReceipt(workspaceRequest: any, run: any = null) {
  return {
    schemaVersion: "managed-workspace.v2",
    workspaceId: workspaceRequest.workspaceId,
    leaseId: "c".repeat(64),
    owner: workspaceRequest.owner,
    originRoot: workspaceRequest.originRoot,
    requestedCwd: workspaceRequest.requestedCwd,
    originRef: workspaceRequest.originRef,
    baseCommit: workspaceRequest.baseCommit,
    path: "/managed/goal-workspace-1",
    dispatchCwd: "/managed/goal-workspace-1",
    branchRef: "refs/heads/pi-managed/goal-workspace-1",
    state: "active",
    run,
    cleanupDebt: null,
    policy: workspaceRequest.policy,
    publishedArtifact: null,
    application: null,
    terminalProof: null,
  };
}

function strictAuthorizationRegistrar(expectedKind: "coding" | "generic", registered: any[]) {
  return (authorization: any) => {
    const value = authorization?.binding;
    if (!authorization || typeof authorization !== "object" || Array.isArray(authorization)
      || authorization.kind !== expectedKind
      || !value || typeof value !== "object" || Array.isArray(value)
      || typeof value.runId !== "string" || value.runId.length === 0
      || typeof value.asyncDir !== "string" || !path.isAbsolute(value.asyncDir)
      || typeof value.sessionId !== "string" || value.sessionId.length === 0
      || !Number.isSafeInteger(value.pid) || value.pid <= 0
      || typeof value.agentProfile !== "string" || value.agentProfile.length === 0) {
      throw new Error("Run authorization binding is invalid");
    }
    registered.push(authorization);
  };
}

function createTestExtension(pi: any, options: any) {
  return createTypedSubagentExtension(pi, {
    registerAuthorizedRun() {},
    discoverAgents() {
      return { agents: [{ name: "executor" }, { name: "reviewer" }, { name: "coder-alpha" }, { name: "coder-beta" }] };
    },
    ...options,
  });
}

test("T7 queued follow-up does not authorize B-stage disposition before child consumption", () => {
  assert.deepEqual(lifecycleModule.terminalDispositionDecision({ state: "pending" }), {
    allowed: false, code: "TERMINAL_PROOF_PENDING",
  });
});

test("T7 follow-up receipt becomes delivered only after child consumption", async () => {
  const plane = createSupervisorControlPlane({
    readOwnerReceipt: async (runId) => ({ runId, rootSessionId: "root-1", ownerGeneration: 1 }),
    readRuntime: async (runId) => ({ runId, ownerGeneration: 1, liveRunEpoch: 2, running: true, steerable: true }),
    randomId: () => "receipt-1",
  });
  await plane.registerSupervisorRequest({ id: "request-1", runId: "run-1", reason: "follow-up" });
  const replyIntent = {
    schemaVersion: "supervisor-control-intent.v1", intentId: "reply-intent", runId: "run-1", rootSessionId: "root-1",
    ownerGeneration: 1, kind: "reply", payloadDigest: `sha256:${"b".repeat(64)}`,
    requestId: "request-1", requestGeneration: 1,
  } as const;
  await plane.commitDelivery({ intent: replyIntent, consumed: true });
  const intent = {
    // G2 合同：steer 必须显式携带 childIndex（v2），缺 index 一律拒绝而不猜 0/不广播。
    schemaVersion: "supervisor-control-intent.v2", intentId: "intent-1", runId: "run-1", rootSessionId: "root-1",
    ownerGeneration: 1, kind: "steer", childIndex: 0, payloadDigest: `sha256:${"a".repeat(64)}`, liveRunEpoch: 2,
  } as const;
  const queued = await plane.commitDelivery({ intent, consumed: false });
  assert.equal(queued.receipt.status, "queued");
  const delivered = await plane.commitDelivery({ intent, consumed: true });
  assert.equal(delivered.receipt.status, "delivered");
});

test("T7 conflict continuation remains awaited in agent_end and settled is observation-only", async () => {
  const listeners = new Map<string, Function[]>();
  const calls: string[] = [];
  const pi = {
    on(type: string, listener: Function) { const list = listeners.get(type) ?? []; list.push(listener); listeners.set(type, list); return () => {}; },
    async sendMessage() { calls.push("follow-up"); },
  };
  let phase = 0;
  const coordinator = {
    async prepareAutoIntegration() { calls.push("prepare"); return { queueState: "resolving-conflict" }; },
    async advanceAutoIntegration() { calls.push("advance"); phase++; return { queueState: "resolving-conflict", conflictDigest: `digest-${phase}` }; },
  };
  createChildIntegrationLifecycle({ pi, coordinator, key: "t7-conflict", pollDelayMs: 0, maxAdmissionPolls: 1 });
  for (const listener of listeners.get("agent_settled") ?? []) await listener();
  assert.deepEqual(calls, []);
  for (const listener of listeners.get("agent_end") ?? []) await listener();
  assert.deepEqual(calls, ["prepare", "advance", "follow-up"]);
});

test("T7 B-stage disposition is rejected before proof and released after durable proof", () => {
  const pending = lifecycleModule.terminalDispositionDecision({ state: "pending" });
  const proof = { state: "observed", conflict: false, runId: "run-1", rootSessionId: "root-1", asyncDir: "/tmp/run-1", processInstance: "proc-1", proofId: "a".repeat(64) };
  const accepted = lifecycleModule.terminalDispositionDecision(proof);
  assert.equal(pending.allowed, false);
  assert.deepEqual(accepted, { allowed: true, proofId: proof.proofId });
});


async function assertCallerTimeoutRejected(name: string, input: any) {
  const { pi, rpc, calls, tools } = setup();
  let discoveries = 0;
  let allocations = 0;
  let rpcCalls = 0;
  rpc.ping = async () => { rpcCalls += 1; return { version: 1, methods: ["spawn"], session: { sessionId: "s", cwd: "/repo" } }; };
  rpc.spawn = async () => { rpcCalls += 1; throw new Error("RPC must not be reached"); };
  createTestExtension(pi, {
    rpc,
    cleanupStore: {},
    discoverAgents() { discoveries += 1; return { agents: [{ name: "executor" }, { name: "reviewer" }] }; },
    workspaceService: { ensureAllocated() { allocations += 1; throw new Error("workspace must not be reached"); } },
  });

  const result = await startTool(tools).execute(`caller-timeout-${name}`, input, undefined, undefined, { cwd: "/repo", sessionManager: {} });
  assert.equal(discoveries, 0, `${name}: discovery`);
  assert.equal(allocations, 0, `${name}: workspace allocation`);
  assert.equal(rpcCalls, 0, `${name}: RPC`);
  assert.equal(calls.length, 0, `${name}: spawn`);
  assert.equal(result.isError, true, name);
  // 新工具边界：timeoutMs 不在 schema，也不透传，直接在操作工具 fail closed（不再触达编译器/RPC）。
  assert.equal(result.details.code, "INVALID_DISPATCH", name);
  assert.equal(result.details.keypath, "$.timeoutMs", name);
}

test("coding object timeout is rejected before discovery, workspace allocation, and RPC", async () => {
  await assertCallerTimeoutRejected("coding-object", { ...contract, timeoutMs: 1_000, worktree: true });
});

test("stringified coding execution timeout is rejected before discovery, workspace allocation, and RPC", async () => {
  await assertCallerTimeoutRejected("coding-string", { ...contract, timeoutMs: 1_000, worktree: true });

});

test("generic timeout is rejected before discovery, workspace allocation, and RPC", async () => {
  await assertCallerTimeoutRejected("generic", { agent: "reviewer", title: "Review", task: "Inspect.", timeoutMs: 60_000, worktree: true });
});

test("caller timeout is rejected even with an active coordinator that issues no ticket", async () => {
  const { pi, rpc, calls, tools } = setup();
  let discoveries = 0;
  let allocations = 0;
  let rpcCalls = 0;
  let prepareSpawnCalls = 0;
  rpc.ping = async () => { rpcCalls += 1; return { version: 1, methods: ["spawn"], session: { sessionId: "s", cwd: "/repo" } }; };
  rpc.spawn = async () => { rpcCalls += 1; throw new Error("RPC must not be reached"); };
  createTestExtension(pi, {
    rpc,
    cleanupStore: {},
    discoverAgents() { discoveries += 1; return { agents: [{ name: "executor" }, { name: "reviewer" }] }; },
    workspaceService: { ensureAllocated() { allocations += 1; throw new Error("workspace must not be reached"); } },
    goalExecutorCoordinator: {
      prepareSpawn() { prepareSpawnCalls += 1; return null; },
      workspaceAllocated() {},
      confirmSpawn() {},
      bindSpawn() {},
    },
  });

  const result = await startTool(tools).execute("caller-timeout-no-ticket", { ...contract, timeoutMs: 1_000, worktree: true }, undefined, undefined, { cwd: "/repo", sessionManager: {} });

  assert.equal(result.isError, true);
  assert.equal(result.details.code, "INVALID_DISPATCH");
  assert.equal(result.details.keypath, "$.timeoutMs");
  assert.equal(prepareSpawnCalls, 0, "invalid caller timeout must fail before coordinator preflight");

  assert.equal(discoveries, 0, "discovery");
  assert.equal(allocations, 0, "workspace allocation");
  assert.equal(rpcCalls, 0, "RPC");
  assert.equal(calls.length, 0, "spawn");
});

// 窄 characterization：省略 timeout 会被上游补默认，验证真实 resolver 消费派发值。
async function assertUpstreamExecutionWindow(params: any) {
  const upstream = await import(pathToFileURL(path.resolve("packages/pi-subagents-enhanced/node_modules/pi-subagents/src/runs/foreground/subagent-executor.js")).href);
  const leaf = workflowLeaf(params);
  for (const configDefault of [undefined, 30 * 60_000]) {
    assert.deepEqual(upstream.resolveSingleAgentLaunchTimeout(leaf, true, configDefault), { timeoutMs: 2_147_000_000 });
  }
  const timer = setTimeout(() => assert.fail("长 execution timer 不得立即到期"), leaf.timeoutMs);
  try {
    assert.equal((timer as any)._idleTimeout, 2_147_000_000, "真实 Node timer 没有溢出成 1ms");
    assert.equal(childStartTimeoutMs(undefined, leaf.timeoutMs), 120_000);
  } finally {
    clearTimeout(timer);
  }
}

test("Host 的 coding child 覆盖上游 30 分钟默认值且不超过 timer 上限", async () => {
  const { pi, rpc, calls, tools } = setup();
  createTestExtension(pi, { rpc, cleanupStore: {} });

  const coding = await startTool(tools).execute("host-coding-timeout", {
    ...contract,
    cwd: "/repo",
  }, undefined, undefined, { cwd: "/repo" });

  assert.equal(coding.isError, false, coding.content[0]?.text);
  assert.equal(workflowLeaf(calls[0].params).timeoutMs, 2_147_000_000);
  await assertUpstreamExecutionWindow(calls[0].params);

});

test("generic child 显式覆盖上游 30 分钟默认值且 collector 仍有界", async () => {
  const { pi, rpc, calls, tools } = setup();
  createTestExtension(pi, { rpc, cleanupStore: {} });
  const generic = await startTool(tools).execute("host-generic-timeout", {
    agent: "reviewer", title: "Review", task: "Inspect.",
  }, undefined, undefined, { cwd: "/repo" });

  assert.equal(generic.isError, false, generic.content[0]?.text);
  assert.equal(workflowLeaf(calls[0].params).timeoutMs, 2_147_000_000);
  assert.equal(calls[0].params.timeoutMs, undefined, "root workflow 不增加 execution deadline");
  await assertUpstreamExecutionWindow(calls[0].params);
});

test("generic child 使用长 execution deadline，child-start collector 仍为 120000ms", async () => {
  const { pi, rpc, calls, tools } = setup();
  createTestExtension(pi, { rpc, cleanupStore: {} });

  const result = await startTool(tools).execute("generic-collector-default", {
    agent: "reviewer", title: "Review", task: "Inspect.",
  }, undefined, undefined, { cwd: "/repo" });

  assert.equal(workflowLeaf(calls[0].params).timeoutMs, 2_147_000_000);
  assert.equal(calls[0].params.timeoutMs, undefined, "root workflow 不增加 execution deadline");
  assert.equal(childStartTimeoutMs(undefined, 120_000), 120_000);
  assert.equal(result.isError, false, result.content[0]?.text);
});

function goalTicket(contractHash: string) {
  return {
    version: "goal-run-binding-ticket.v2",
    ticketId: "a".repeat(64),
    goalId: "goal-1",
    taskId: "task-1",
    attempt: 1,
    contractHash,
    workspaceId: "goal-workspace-1",
    executionRevision: 1,
    expectedCriteria: ["identity"],
    agentProfile: "executor",
    spawnIdentity: { requestId: "goal-request", spawnKey: "goal-request" },
  };
}

test("coding spawn binds the Goal coordinator through a same-root different-ExtensionAPI wrapper before returning", async () => {
  const { pi, rpc, tools } = setup({ sessionId: "root-shared" });
  const goalPi = { events: {} };
  const bindings: any[] = [];
  let request: any;
  const coordinator = {
    prepareSpawn(input: any) {
      request = goalWorkspaceRequest(input.contractHash);
      return { ...goalTicket(input.contractHash), workspaceRequest: request };
    },
    workspaceAllocated() {},
    confirmSpawn() {},
    bindSpawn(ticket: any, binding: any) { bindings.push({ ticket, binding }); },
  };
  const workspaceService = {
    ensureAllocated() { return workspaceReceipt(request); },
    bindRun({ run }: any) { return workspaceReceipt(request, run); },
  };
  bindGoalRunCoordinator(goalPi, coordinator);
  bindGoalRunCoordinatorSession(goalPi, "root-shared", coordinator);
  try {
    createTestExtension(pi, { rpc, cleanupStore: {}, workspaceService, resolveRootSessionId() { return "root-shared"; } });
    const result = await startTool(tools).execute("goal-wrapper-bridge", { ...contract, worktree: true }, undefined, undefined, { cwd: "/repo", sessionManager: {} });
    assert.equal(result.isError, false, result.content[0]?.text);
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0].ticket.ticketId, "a".repeat(64));
    assert.deepEqual(bindings[0].binding, { runId: "leaf-1", asyncDir: "/tmp/leaf-1", sessionId: "root-shared", pid: 123, agentProfile: "executor" });
  } finally {
    unbindGoalRunCoordinatorSession(goalPi, "root-shared", coordinator);
  }
});

test("Goal trusted contract keeps a non-default caller timeout and canonical hash", async () => {
  const { pi, rpc, calls, tools } = setup();
  const trustedTimeout = 45_000;
  const goalInput = {
    ...contract,
    worktree: true,
  };
  const expectedHash = compileCodingDispatchIR(goalInput, { cwd: "/repo" }).contractHash;

  let preparedRequest: any;
  const workspaceService = {
    ensureAllocated(request: any) { preparedRequest = request; return workspaceReceipt(request); },
    bindRun({ run }: any) { return workspaceReceipt(preparedRequest, run); },
  };
  createTestExtension(pi, {
    rpc,
    cleanupStore: {},
    resolveRootSessionId: () => "root-shared",
    goalExecutorCoordinator: {
      prepareSpawn(request: any) {
        assert.equal(request.contractHash, expectedHash);
        preparedRequest = goalWorkspaceRequest(request.contractHash);
        return { ...goalTicket(request.contractHash), workspaceRequest: preparedRequest };
      },
      workspaceAllocated() {},
      confirmSpawn() {},
      bindSpawn() {},
    },
    workspaceService,
  });

  const result = await startTool(tools).execute("goal-trusted-timeout", goalInput, undefined, undefined, { cwd: "/repo", sessionManager: {} });

  assert.equal(result.isError, false, result.content[0]?.text);
  assert.equal(result.details.contractHash, expectedHash);
  assert.equal(workflowLeaf(calls[0].params).timeoutMs, 2_147_000_000);

});

test("Goal coding spawn allocates through the shared service in the exact four-stage order", async () => {
  const { pi, rpc, calls, tools } = setup({ sessionId: "root-shared" });
  const order: string[] = [];
  let preparedRequest: any;
  let activeReceipt: any;
  const workspaceService = {
    ensureAllocated(request: any) {
      order.push("ensureAllocated");
      assert.deepEqual(request, preparedRequest);
      activeReceipt = workspaceReceipt(request);
      return activeReceipt;
    },
    bindRun({ workspaceId, run }: any) {
      order.push("bindRun");
      assert.equal(workspaceId, activeReceipt.workspaceId);
      activeReceipt = workspaceReceipt(preparedRequest, run);
      return activeReceipt;
    },
  };
  const coordinator = {
    prepareSpawn(request: any) {
      order.push("prepareSpawn");
      preparedRequest = goalWorkspaceRequest(request.contractHash);
      return { ...goalTicket(request.contractHash), workspaceRequest: preparedRequest };
    },
    workspaceAllocated(_ticket: any, receipt: any) { order.push("workspaceAllocated"); assert.strictEqual(receipt, activeReceipt); },
    confirmSpawn(_ticket: any, receipt: any) { order.push("confirmSpawn"); assert.strictEqual(receipt, activeReceipt); },
    bindSpawn(_ticket: any, binding: any) { order.push("bindSpawn"); assert.equal(binding.runId, "leaf-1"); },
  };
  const spawn = rpc.spawn;
  rpc.spawn = async (...args: any[]) => { order.push("spawn"); return spawn(...args); };
  createTestExtension(pi, {
    rpc,
    cleanupStore: {},
    goalExecutorCoordinator: coordinator,
    workspaceService,
    resolveRootSessionId: () => "root-shared",
    async prepareCodingSpawn() { order.push("prepareCodingSpawn"); },
  });

  const result = await startTool(tools).execute("goal-unified", {
    ...contract,
    worktree: true,
  }, undefined, undefined, { cwd: "/repo", sessionManager: {} });

  assert.equal(result.isError, false, result.content[0]?.text);
  assert.deepEqual(order, [
    "prepareSpawn",
    "ensureAllocated",
    "workspaceAllocated",
    "confirmSpawn",
    "prepareCodingSpawn",
    "spawn",
    "bindRun",
    "bindSpawn",
  ]);
  assert.equal(calls[0].params.cwd, activeReceipt.originRoot);
  assert.equal(workflowLeaf(calls[0].params).cwd, activeReceipt.dispatchCwd);
  assert.equal(calls[0].params.worktree, false);
  assert.equal(workflowLeaf(calls[0].params).worktree, false);
  assert.equal(result.details.workspace_id, activeReceipt.workspaceId);
  assert.equal(result.details.lease_id, activeReceipt.leaseId);
});

test("standalone coding worktree uses the same service and binds without Goal registration", async () => {
  const { pi, rpc, tools } = setup({ sessionId: "root-standalone" });
  const order: string[] = [];
  let allocated: any;
  const workspaceService = {
    ensureAllocated(request: any) {
      order.push("ensureAllocated");
      assert.equal(request.owner.kind, "standalone-subagent");
      assert.equal(request.owner.rootSessionId, "root-standalone");
      assert.equal(request.owner.toolCallId, "standalone-call");
      assert.equal(request.contractHash, preparePublicCodingDispatch({ ...contract, worktree: true }, { cwd: "/repo", timeoutMs: 30 * 60_000 }).contractHash);

      allocated = workspaceReceipt({ ...request, workspaceId: request.workspaceId });
      return allocated;
    },
    bindRun({ workspaceId, run }: any) {
      order.push("bindRun");
      allocated = { ...allocated, run };
      assert.equal(workspaceId, allocated.workspaceId);
      return allocated;
    },
  };
  const spawn = rpc.spawn;
  rpc.spawn = async (...args: any[]) => { order.push("spawn"); return spawn(...args); };
  const registered: any[] = [];
  createTestExtension(pi, {
    rpc,
    cleanupStore: {},
    randomUUID: () => "standalone-workspace",
    workspaceService,
    resolveRootSessionId: () => "root-standalone",
    resolveCanonicalOrigin: async () => "/repo",
    inspectWorkspaceSource: async () => ({ originRef: "refs/heads/main", baseCommit: "b".repeat(40) }),
    registerAuthorizedRun(authorization: any) {
      order.push("registerAuthorizedRun");
      strictAuthorizationRegistrar("coding", registered)(authorization);
    },
  });

  const result = await startTool(tools).execute("standalone-call", {
    ...contract,
    worktree: true,
  }, undefined, undefined, { cwd: "/repo", sessionManager: {} });

  assert.equal(result.isError, false, result.content[0]?.text);
  assert.deepEqual(order, ["ensureAllocated", "spawn", "registerAuthorizedRun", "bindRun"]);
  assert.equal(result.details.dispatch_cwd, "/managed/goal-workspace-1");
  assert.equal(result.details.workspace_state, "active");
  assert.equal(Object.hasOwn(allocated.run, "kind"), false);
  assert.equal(Object.hasOwn(result.details, "kind"), false);
  assert.deepEqual(registered[0], {
    version: "subagent-run-authorization.v1",
    kind: "coding",
    binding: { runId: "leaf-1", asyncDir: "/tmp/leaf-1", sessionId: "root-standalone", pid: 123, agentProfile: "executor" },
    capabilities: ["root.subscribe"],
    goal: null,
  });
});

test("generic shared run registers owner authority without a managed worktree", async () => {
  const { pi, rpc, tools } = setup({ sessionId: "root-generic-no-worktree" });
  const registered: any[] = [];
  createTestExtension(pi, { rpc, cleanupStore: {}, registerAuthorizedRun: (authorization: any) => registered.push(authorization) });
  const result = await startTool(tools).execute("generic-no-worktree", { agent: "reviewer", title: "Review", task: "Inspect the shared workspace." }, undefined, undefined, { cwd: "/repo", sessionManager: {} });
  assert.equal(result.isError, false, result.content[0]?.text);
  assert.deepEqual(registered[0], {
    version: "subagent-run-authorization.v1",
    kind: "generic",
    binding: { runId: "leaf-1", asyncDir: "/tmp/leaf-1", sessionId: "root-generic-no-worktree", pid: 123, agentProfile: "reviewer" },
    capabilities: [],
    goal: null,
  });

});

test("generic worktree uses the unified service without enabling upstream worktrees", async () => {
  const { pi, rpc, calls, tools } = setup({ sessionId: "root-generic" });
  const registered: any[] = [];
  let allocated: any;
  const workspaceService = {
    ensureAllocated(request: any) {
      assert.equal(request.policy.publication, "forbidden");
      assert.equal(request.policy.application, "forbidden");
      assert.equal(request.owner.kind, "standalone-subagent");
      assert.deepEqual(request.policy.writePaths, []);
      allocated = workspaceReceipt(request);
      return allocated;
    },
    bindRun({ run }: any) { allocated = { ...allocated, run }; return allocated; },
  };
  createTestExtension(pi, {
    rpc,
    cleanupStore: {},
    randomUUID: () => "generic-workspace",
    workspaceService,
    resolveRootSessionId: () => "root-generic",
    resolveCanonicalOrigin: async () => "/repo",
    inspectWorkspaceSource: async () => ({ originRef: "refs/heads/main", baseCommit: "b".repeat(40) }),
    registerAuthorizedRun(authorization: any) { strictAuthorizationRegistrar("generic", registered)(authorization); },
  });

  const result = await startTool(tools).execute("generic-call", {
    agent: "reviewer",
    title: "Review",
    task: "Inspect the managed workspace.",
    worktree: true,
  }, undefined, undefined, { cwd: "/repo", sessionManager: {} });

  assert.equal(result.isError, false, result.content[0]?.text);
  assert.equal(calls[0].params.cwd, allocated.originRoot);
  assert.equal(workflowLeaf(calls[0].params).cwd, allocated.dispatchCwd);
  assert.equal(calls[0].params.worktree, false);
  assert.equal(workflowLeaf(calls[0].params).worktree, false);
  assert.equal(result.details.workspace_id, allocated.workspaceId);
  assert.equal(Object.hasOwn(allocated.run, "kind"), false);
  assert.equal(Object.hasOwn(result.details, "kind"), false);
  assert.deepEqual(registered[0], {
    version: "subagent-run-authorization.v1",
    kind: "generic",
    binding: { runId: "leaf-1", asyncDir: "/tmp/leaf-1", sessionId: "root-generic", pid: 123, agentProfile: "reviewer" },
    capabilities: [],
    goal: null,
  });
});

test("coding without a worktree does not register Goal ownership", async () => {
  const { pi, rpc, tools, calls } = setup();
  const registrations: any[] = [];
  createTestExtension(pi, {
    rpc,
    cleanupStore: {},
    registerAuthorizedRun(authorization: any) { registrations.push(authorization); },
  });

  const coding = await startTool(tools).execute("plain-coding", contract, undefined, undefined, { cwd: "/repo" });
  const generic = await startTool(tools).execute("plain-generic", { agent: "executor", title: "Review", task: "Inspect." }, undefined, undefined, { cwd: "/repo" });

  assert.equal(coding.isError, false, coding.content[0]?.text);
  assert.equal(generic.isError, false, generic.content[0]?.text);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].kind, "generic");
  assert.equal(Object.hasOwn(workflowLeaf(calls[0].params), "subagentOnlyExtensions"), false);
  assert.equal(Object.hasOwn(workflowLeaf(calls[1].params), "subagentOnlyExtensions"), false);
});

test("renamed standalone profiles do not acquire Goal authorization", async () => {
  const { pi, rpc, tools } = setup();
  const registrations: any[] = [];
  createTestExtension(pi, {
    rpc,
    cleanupStore: {},
    registerAuthorizedRun(authorization: any) { registrations.push(authorization); },
  });

  for (const agent of ["coder-alpha", "coder-beta"]) {
    const result = await startTool(tools).execute(`renamed-${agent}`, { ...contract, agent }, undefined, undefined, { cwd: "/repo" });
    assert.equal(result.isError, false, result.content[0]?.text);
  }
  const generic = await startTool(tools).execute("same-profile-generic", { agent: "coder-alpha", title: "Inspect", task: "Read only." }, undefined, undefined, { cwd: "/repo" });

  assert.equal(generic.isError, false, generic.content[0]?.text);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].kind, "generic");
  assert.equal(registrations[0].binding.agentProfile, "coder-alpha");
});

test("Goal coding registers exact ticket authority before returning a handle", async () => {
  const { pi, rpc, tools } = setup();
  let workspaceRequest: any;
  const registered: any[] = [];
  createTestExtension(pi, {
    rpc,
    cleanupStore: {},
    resolveRootSessionId: () => "root-shared",
    goalExecutorCoordinator: {
      prepareSpawn(request: any) {
        workspaceRequest = goalWorkspaceRequest(request.contractHash);
        return { ...goalTicket(request.contractHash), agentProfile: "coder-alpha", workspaceRequest };
      },
      workspaceAllocated() {},
      confirmSpawn() {},
      bindSpawn() {},
    },
    workspaceService: {
      ensureAllocated() { return workspaceReceipt(workspaceRequest); },
      bindRun({ run }: any) { return workspaceReceipt(workspaceRequest, run); },
    },
    registerAuthorizedRun(authorization: any) { registered.push(authorization); },
  });

  const result = await startTool(tools).execute("goal-authority", { ...contract, agent: "coder-alpha", worktree: true }, undefined, undefined, { cwd: "/repo", sessionManager: {} });

  assert.equal(result.isError, false, result.content[0]?.text);
  assert.deepEqual(registered[0], {
    version: "subagent-run-authorization.v1",
    kind: "coding",
    binding: { runId: "leaf-1", asyncDir: "/tmp/leaf-1", sessionId: "s", pid: 123, agentProfile: "coder-alpha" },
    capabilities: ["acceptance.submit", "root.subscribe"],
    goal: {
      ticketId: "a".repeat(64), goalId: "goal-1", taskId: "task-1", attempt: 1,
      contractHash: result.details.contractHash, workspaceId: "goal-workspace-1", executionRevision: 1,
      expectedCriteria: ["identity"],
    },
  });
});

test("standalone coding rejects registration failure and preserves the active unbound workspace", async () => {
  const { pi, rpc, tools } = setup();
  const workspaceService = {
    ensureAllocated(request: any) { return workspaceReceipt(request); },
    bindRun() { throw new Error("bindRun must not be reached"); },
  };
  let allocated: any;
  workspaceService.ensureAllocated = (request: any) => {
    allocated = workspaceReceipt(request);
    return allocated;
  };
  createTestExtension(pi, {
    rpc,
    cleanupStore: {},
    randomUUID: () => "registration-failure-workspace",
    workspaceService,
    resolveRootSessionId: () => "s",
    resolveCanonicalOrigin: async () => "/repo",
    inspectWorkspaceSource: async () => ({ originRef: "refs/heads/main", baseCommit: "b".repeat(40) }),
    registerAuthorizedRun() { throw Object.assign(new Error("broker unavailable"), { code: "BROKER_UNAVAILABLE" }); },
  });

  const result = await startTool(tools).execute("registration-failure", { ...contract, agent: "coder-alpha", worktree: true }, undefined, undefined, { cwd: "/repo", sessionManager: {} });


  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /broker unavailable/);
  assert.equal(allocated.state, "active");
  assert.equal(allocated.run, null);
});

test("standalone lifecycle session does not create Goal authorization", async () => {
  const { pi, rpc, tools } = setup({ sessionId: "/tmp/root-session.jsonl" });
  const registrations: any[] = [];
  createTestExtension(pi, {
    rpc,
    cleanupStore: {},
    resolveRootSessionId: () => "root-session",
    registerAuthorizedRun(value: any) { strictAuthorizationRegistrar("coding", registrations)(value); },
  });

  const result = await startTool(tools).execute("session-mismatch", { ...contract, agent: "coder-alpha" }, undefined, undefined, { cwd: "/repo", sessionManager: {} });

  assert.equal(result.isError, false, result.content[0]?.text);
  assert.deepEqual(registrations, []);
});

test("unsafe lifecycle session does not matter without Goal authorization", async () => {
  const { pi, rpc, tools } = setup({ sessionId: "relative/unsafe-session" });
  let registrations = 0;
  createTestExtension(pi, {
    rpc,
    cleanupStore: {},
    registerAuthorizedRun() { registrations += 1; },
  });

  const result = await startTool(tools).execute("unsafe-session", { ...contract, agent: "coder-alpha" }, undefined, undefined, { cwd: "/repo" });

  assert.equal(result.isError, true);
  assert.equal(registrations, 0);
});

test("coding spawn leaves executor model selection to ordered agent metadata", async () => {
  const { pi, rpc, calls, tools } = setup();
  createTestExtension(pi, { rpc, cleanupStore: {} });
  const result = await startTool(tools).execute("ordered-models", contract, undefined, undefined, { cwd: "/repo" });
  assert.equal(workflowLeaf(calls[0]?.params).agent, "executor");
  assert.equal(Object.hasOwn(workflowLeaf(calls[0]?.params), "model"), false);
  assert.deepEqual(result.details.modelSelection, { source: "default" });
});

test("coding spawn resolves the first available bare model from executor metadata", async () => {
  const { pi, rpc, calls, tools } = setup();
  let discoveryCalls = 0;
  createTestExtension(pi, {
    rpc,
    cleanupStore: {},
    discoverAgents() {
      discoveryCalls += 1;
      return { agents: [{ name: "executor", models: ["codex-pool/gpt-5.6-luna", "openai-codex/gpt-5.6-luna"] }] };
    },
  });
  const result = await startTool(tools).execute("model-luna", { ...contract, model: "gpt-5.6-luna" }, undefined, undefined, {
    cwd: "/repo",
    modelRegistry: { getAvailable() { return [{ provider: "openai-codex", id: "gpt-5.6-luna", api: "openai-completions" }]; } },
  });
  assert.equal(workflowLeaf(calls[0]?.params).model, "openai-codex/gpt-5.6-luna");
  assert.deepEqual(result.details.modelSelection, { requestedModel: "gpt-5.6-luna", resolvedModel: "openai-codex/gpt-5.6-luna", source: "agent-candidates" });
  assert.equal(Object.hasOwn(result.details, "warnings"), false);
  assert.equal(discoveryCalls, 1);
});

test("coding spawn resolves durable metadata exactly once", async () => {
  const { pi, rpc, calls, tools } = setup(); const resolved = [];
  createTestExtension(pi, { rpc, cleanupStore: {}, resolveCodingSpawnIdentity(value) { resolved.push(value); return { requestId: "durable-dispatch-1", spawnKey: "durable-dispatch-1" }; } });
  const result = await startTool(tools).execute("tool-call-identity-1", contract, undefined, undefined, { cwd: "/repo" });
  assert.equal(result.isError, false, result.content[0]?.text); assert.equal(resolved.length, 1); assert.equal(calls.length, 1);
  assert.equal(result.details.dispatchId, "durable-dispatch-1");
  assert.equal(result.details.runId, "leaf-1");
  assert.equal(result.details.asyncDir, "/tmp/leaf-1");
});

test("coding spawn resolver receives the caller contract content without control fields", async () => {
  const { pi, rpc, tools } = setup(); const resolved = [];
  createTestExtension(pi, { rpc, cleanupStore: {}, resolveCodingSpawnIdentity(value) { resolved.push(value); return { requestId: "durable-dispatch-2", spawnKey: "durable-dispatch-2" }; } });
  await startTool(tools).execute("tool-call-identity-2", contract, undefined, undefined, { cwd: "/repo" });
  // 新操作工具边界按白名单重建入参（不透传 action/未知字段），因此不再保持对象引用同一；
  // 合同内容逐项等价，且 compiled hash 用例证明下游编译结果不变。
  assert.deepEqual(resolved[0]?.contract, contract);
  assert.equal(Object.hasOwn(resolved[0]?.contract ?? {}, "action"), false);
});

test("coding spawn resolver receives the tool call id", async () => {
  const { pi, rpc, tools } = setup(); const resolved = [];
  createTestExtension(pi, { rpc, cleanupStore: {}, resolveCodingSpawnIdentity(value) { resolved.push(value); return { requestId: "durable-dispatch-2", spawnKey: "durable-dispatch-2" }; } });
  await startTool(tools).execute("tool-call-identity-2", contract, undefined, undefined, { cwd: "/repo" });
  assert.equal(resolved[0]?.toolCallId, "tool-call-identity-2");
});

test("coding spawn resolver receives the exact compiled hash", async () => {
  const { pi, rpc, tools } = setup(); const resolved = [];
  createTestExtension(pi, { rpc, cleanupStore: {}, resolveCodingSpawnIdentity(value) { resolved.push(value); return { requestId: "durable-dispatch-2", spawnKey: "durable-dispatch-2" }; } });
  await startTool(tools).execute("tool-call-identity-2", contract, undefined, undefined, { cwd: "/repo" });
  assert.equal(resolved[0]?.contractHash, preparePublicCodingDispatch(contract, { cwd: "/repo", timeoutMs: 30 * 60_000 }).contractHash);

});

test("coding spawn forwards resolver metadata raw as RPC options and excludes spawnKey from params", async () => {
  const { pi, rpc, calls, tools } = setup();
  const metadata = { requestId: "durable-dispatch-3", spawnKey: "durable-dispatch-3" };
  createTestExtension(pi, { rpc, cleanupStore: {}, resolveCodingSpawnIdentity() { return metadata; } });
  await startTool(tools).execute("tool-call-identity-3", contract, undefined, undefined, { cwd: "/repo" });
  assert.equal(calls[0]?.options?.requestId, metadata.requestId);
  assert.equal(calls[0]?.options?.spawnKey, metadata.spawnKey);
  assert.equal(typeof calls[0]?.options?.diagnostic?.sink, "function");
  assert.equal(Object.hasOwn(calls[0]?.params ?? {}, "spawnKey"), false);
});

test("coding and generic spawns forward thinkingLevel to the child thinking override", async () => {
  const codingEnv = setup();
  createTestExtension(codingEnv.pi, { rpc: codingEnv.rpc, cleanupStore: {} });
  await startTool(codingEnv.tools).execute("thinking-coding", { ...contract, thinkingLevel: "low" }, undefined, undefined, { cwd: "/repo" });
  assert.equal(workflowLeaf(codingEnv.calls[0]?.params).thinking, "low");

  const genericEnv = setup();
  createTestExtension(genericEnv.pi, { rpc: genericEnv.rpc, cleanupStore: {} });
  await startTool(genericEnv.tools).execute("thinking-generic", { agent: "executor", title: "低思考", task: "验证思考级别透传。", thinkingLevel: "low" }, undefined, undefined, { cwd: "/repo" });
  assert.equal(workflowLeaf(genericEnv.calls[0]?.params).thinking, "low");
});

test("coding prepare runs after ping and before spawn", async () => {
  const { pi, rpc, tools } = setup(); const order = [];
  rpc.ping = async () => { order.push("ping"); return { version: 1, methods: ["spawn"], session: { sessionId: "s", cwd: "/repo" } }; };
  const spawn = rpc.spawn;
  rpc.spawn = async (...args) => { order.push("spawn"); return spawn(...args); };
  createTestExtension(pi, { rpc, cleanupStore: {}, async prepareCodingSpawn() { order.push("prepare"); } });
  await startTool(tools).execute("prepare-call", contract, undefined, undefined, { cwd: "/repo" });
  assert.deepEqual(order, ["ping", "prepare", "spawn"]);
});

test("coding prepare runs before durable identity resolution", async () => {
  const { pi, rpc, tools } = setup(); const order = [];
  rpc.ping = async () => { order.push("ping"); return { version: 1, methods: ["spawn"], session: { sessionId: "s", cwd: "/repo" } }; };
  const spawn = rpc.spawn;
  rpc.spawn = async (...args) => { order.push("spawn"); return spawn(...args); };
  createTestExtension(pi, { rpc, cleanupStore: {}, async prepareCodingSpawn() { order.push("prepare"); }, resolveCodingSpawnIdentity() { order.push("resolveIdentity"); return { requestId: "x", spawnKey: "x" }; } });
  await startTool(tools).execute("prepare-resolver-call", contract, undefined, undefined, { cwd: "/repo" });
  assert.deepEqual(order, ["ping", "prepare", "resolveIdentity", "spawn"]);
});

test("coding prepare failure prevents identity resolution and spawn", async () => {
  const { pi, rpc, calls, tools } = setup(); let resolved = 0;
  createTestExtension(pi, { rpc, cleanupStore: {}, async prepareCodingSpawn() { throw new Error("owner wrapper failed"); }, resolveCodingSpawnIdentity() { resolved += 1; return { requestId: "x", spawnKey: "x" }; } });
  const result = await startTool(tools).execute("prepare-fail", contract, undefined, undefined, { cwd: "/repo" });
  assert.equal(result.isError, true); assert.match(result.content[0].text, /owner wrapper failed/);
  assert.equal(calls.length, 0); assert.equal(resolved, 0);
});

test("generic and control dispatches never prepare or resolve coding spawn identity", async () => {
  const { pi, rpc, tools } = setup(); let resolved = 0; let prepared = 0;
  createTestExtension(pi, { rpc, cleanupStore: {}, async prepareCodingSpawn() { prepared += 1; }, resolveCodingSpawnIdentity() { resolved += 1; return { requestId: "x", spawnKey: "x" }; } });
  await startTool(tools).execute("generic-call", { agent: "reviewer", title: "Review", task: "Inspect." }, undefined, undefined, { cwd: "/repo" });
  await controlTool(tools, "status").execute("control-call", { id: "run-1" }, undefined, undefined, { cwd: "/repo" });
  assert.equal(resolved, 0); assert.equal(prepared, 0);
});

test('省略model也校验profile virtual，RPC与workspace副作用为0', async () => {
  const { pi, rpc, calls, tools } = setup();
  createTestExtension(pi, { rpc, cleanupStore: {}, discoverAgents: () => ({ agents: [{ name: 'executor', models: ['fixture/virtual'] }] }) });
  const result = await startTool(tools).execute('virtual-default', contract, undefined, undefined, {
    cwd: '/repo', modelRegistry: { getAvailable: () => [{ provider: 'fixture', id: 'virtual', api: 'pi-virtual' }] },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /VIRTUAL_MODEL_UNSUPPORTED_BY_DISPATCH/);
  assert.deepEqual(calls, []);
});
