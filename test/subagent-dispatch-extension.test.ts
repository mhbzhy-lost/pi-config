import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { createTypedSubagentExtension } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts";
import { compileCodingDispatchIR } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/ir.ts";
import { bindGoalRunCoordinator, bindGoalRunCoordinatorSession, unbindGoalRunCoordinatorSession } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-registry.ts";

const contract = {
  version: "dispatch-ir.v1", taskId: "identity-ledger", title: "Bind durable spawn identity", agent: "executor", risk: "normal",
  objective: "Bind coding calls to durable identities.", workflow: { mode: "tdd" }, requirements: ["Preserve the exact contract."],
  context: { knownFacts: [], decisions: [], relevantFiles: ["test/subagent-dispatch-extension.test.ts"] },
  boundaries: { writePaths: ["test/subagent-dispatch-extension.test.ts"], excludedWork: [], forbiddenActions: [] },
  acceptance: { criteria: ["Identity is trusted."] }, execution: { cwd: "/repo", timeoutMs: 1_000 },
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
  const pi = { events, registerTool(tool) { tools.push(tool); }, on() {} };
  const rpc = {
    async ping() { return { version: 1, methods: ["spawn"], session: { sessionId, cwd: "/repo" } }; },
    async spawn(params, options) {
      calls.push({ params, options });
      const match = params.workflowScript.match(/^return await runs\.run\(([^,]+), (.*)\);$/);
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

function workflowLeaf(params: any) {
  const match = String(params.workflowScript).match(/runs\.run\("[^"]+", (.*)\);/);
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
    mode: "coding",
    writePaths: ["test/subagent-dispatch-extension.test.ts"],
  };
}

function workspaceReceipt(workspaceRequest: any, run: any = null) {
  return {
    schemaVersion: "managed-workspace.v1",
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
    disposition: null,
    cleanupDebt: null,
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
    const result = await tools[0].execute("goal-wrapper-bridge", { ...contract, execution: { ...contract.execution, worktree: true } }, undefined, undefined, { cwd: "/repo", sessionManager: {} });
    assert.equal(result.isError, false, result.content[0]?.text);
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0].ticket.ticketId, "a".repeat(64));
    assert.deepEqual(bindings[0].binding, { runId: "leaf-1", asyncDir: "/tmp/leaf-1", sessionId: "root-shared", pid: 123, agentProfile: "executor" });
  } finally {
    unbindGoalRunCoordinatorSession(goalPi, "root-shared", coordinator);
  }
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

  const result = await tools[0].execute("goal-unified", {
    ...contract,
    execution: { ...contract.execution, worktree: true },
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
  assert.equal(calls[0].params.cwd, activeReceipt.dispatchCwd);
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
      assert.equal(request.contractHash, compileCodingDispatchIR({ ...contract, execution: { ...contract.execution, worktree: true } }, { cwd: "/repo" }).hash);
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

  const result = await tools[0].execute("standalone-call", {
    ...contract,
    execution: { ...contract.execution, worktree: true },
  }, undefined, undefined, { cwd: "/repo", sessionManager: {} });

  assert.equal(result.isError, false, result.content[0]?.text);
  assert.deepEqual(order, ["ensureAllocated", "spawn", "bindRun"]);
  assert.equal(result.details.dispatch_cwd, "/managed/goal-workspace-1");
  assert.equal(result.details.workspace_state, "active");
  assert.equal(Object.hasOwn(allocated.run, "kind"), false);
  assert.equal(Object.hasOwn(result.details, "kind"), false);
  assert.deepEqual(registered, []);
});

test("generic worktree uses the unified service without enabling upstream worktrees", async () => {
  const { pi, rpc, calls, tools } = setup({ sessionId: "root-generic" });
  const registered: any[] = [];
  let allocated: any;
  const workspaceService = {
    ensureAllocated(request: any) {
      assert.equal(request.mode, "generic");
      assert.equal(request.owner.kind, "standalone-subagent");
      assert.deepEqual(request.writePaths, []);
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

  const result = await tools[0].execute("generic-call", {
    agent: "reviewer",
    title: "Review",
    task: "Inspect the managed workspace.",
    worktree: true,
  }, undefined, undefined, { cwd: "/repo", sessionManager: {} });

  assert.equal(result.isError, false, result.content[0]?.text);
  assert.equal(calls[0].params.cwd, allocated.dispatchCwd);
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

  const coding = await tools[0].execute("plain-coding", contract, undefined, undefined, { cwd: "/repo" });
  const generic = await tools[0].execute("plain-generic", { agent: "executor", title: "Review", task: "Inspect." }, undefined, undefined, { cwd: "/repo" });

  assert.equal(coding.isError, false, coding.content[0]?.text);
  assert.equal(generic.isError, false, generic.content[0]?.text);
  assert.equal(registrations.length, 0);
  assert.equal(workflowLeaf(calls[0].params).subagentOnlyExtensions.length, 1);
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
    const result = await tools[0].execute(`renamed-${agent}`, { ...contract, agent }, undefined, undefined, { cwd: "/repo" });
    assert.equal(result.isError, false, result.content[0]?.text);
  }
  const generic = await tools[0].execute("same-profile-generic", { agent: "coder-alpha", title: "Inspect", task: "Read only." }, undefined, undefined, { cwd: "/repo" });

  assert.equal(generic.isError, false, generic.content[0]?.text);
  assert.deepEqual(registrations, []);
});

test("Goal coding registers exact ticket authority before returning a handle", async () => {
  const { pi, rpc, tools } = setup();
  let workspaceRequest: any;
  const registered: any[] = [];
  createTestExtension(pi, {
    rpc,
    cleanupStore: {},
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

  const result = await tools[0].execute("goal-authority", { ...contract, agent: "coder-alpha", execution: { ...contract.execution, worktree: true } }, undefined, undefined, { cwd: "/repo", sessionManager: {} });

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

test("standalone coding does not depend on Goal authorization registration", async () => {
  const { pi, rpc, tools } = setup();
  createTestExtension(pi, {
    rpc,
    cleanupStore: {},
    registerAuthorizedRun() { throw Object.assign(new Error("broker unavailable"), { code: "BROKER_UNAVAILABLE" }); },
  });

  const result = await tools[0].execute("registration-failure", { ...contract, agent: "coder-alpha" }, undefined, undefined, { cwd: "/repo" });

  assert.equal(result.isError, false);
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

  const result = await tools[0].execute("session-mismatch", { ...contract, agent: "coder-alpha" }, undefined, undefined, { cwd: "/repo", sessionManager: {} });

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

  const result = await tools[0].execute("unsafe-session", { ...contract, agent: "coder-alpha" }, undefined, undefined, { cwd: "/repo" });

  assert.equal(result.isError, false);
  assert.equal(registrations, 0);
});

test("coding spawn leaves executor model selection to ordered agent metadata", async () => {
  const { pi, rpc, calls, tools } = setup();
  createTestExtension(pi, { rpc, cleanupStore: {} });
  const result = await tools[0].execute("ordered-models", contract, undefined, undefined, { cwd: "/repo" });
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
  const result = await tools[0].execute("model-luna", { ...contract, model: "gpt-5.6-luna" }, undefined, undefined, {
    cwd: "/repo",
    modelRegistry: { getAvailable() { return [{ provider: "openai-codex", id: "gpt-5.6-luna" }]; } },
  });
  assert.equal(workflowLeaf(calls[0]?.params).model, "openai-codex/gpt-5.6-luna");
  assert.deepEqual(result.details.modelSelection, { requestedModel: "gpt-5.6-luna", resolvedModel: "openai-codex/gpt-5.6-luna", source: "agent-candidates" });
  assert.equal(Object.hasOwn(result.details, "warnings"), false);
  assert.equal(discoveryCalls, 1);
});

test("coding spawn resolves durable metadata exactly once", async () => {
  const { pi, rpc, calls, tools } = setup(); const resolved = [];
  createTestExtension(pi, { rpc, cleanupStore: {}, resolveCodingSpawnIdentity(value) { resolved.push(value); return { requestId: "durable-dispatch-1", spawnKey: "durable-dispatch-1" }; } });
  const result = await tools[0].execute("tool-call-identity-1", contract, undefined, undefined, { cwd: "/repo" });
  assert.equal(result.isError, false, result.content[0]?.text); assert.equal(resolved.length, 1); assert.equal(calls.length, 1);
  assert.equal(result.details.dispatchId, "durable-dispatch-1");
  assert.equal(result.details.runId, "leaf-1");
  assert.equal(result.details.asyncDir, "/tmp/leaf-1");
});

test("coding spawn resolver receives the raw contract", async () => {
  const { pi, rpc, tools } = setup(); const resolved = [];
  createTestExtension(pi, { rpc, cleanupStore: {}, resolveCodingSpawnIdentity(value) { resolved.push(value); return { requestId: "durable-dispatch-2", spawnKey: "durable-dispatch-2" }; } });
  await tools[0].execute("tool-call-identity-2", contract, undefined, undefined, { cwd: "/repo" });
  assert.strictEqual(resolved[0]?.contract, contract);
});

test("coding spawn resolver receives the tool call id", async () => {
  const { pi, rpc, tools } = setup(); const resolved = [];
  createTestExtension(pi, { rpc, cleanupStore: {}, resolveCodingSpawnIdentity(value) { resolved.push(value); return { requestId: "durable-dispatch-2", spawnKey: "durable-dispatch-2" }; } });
  await tools[0].execute("tool-call-identity-2", contract, undefined, undefined, { cwd: "/repo" });
  assert.equal(resolved[0]?.toolCallId, "tool-call-identity-2");
});

test("coding spawn resolver receives the exact compiled hash", async () => {
  const { pi, rpc, tools } = setup(); const resolved = [];
  createTestExtension(pi, { rpc, cleanupStore: {}, resolveCodingSpawnIdentity(value) { resolved.push(value); return { requestId: "durable-dispatch-2", spawnKey: "durable-dispatch-2" }; } });
  await tools[0].execute("tool-call-identity-2", contract, undefined, undefined, { cwd: "/repo" });
  assert.equal(resolved[0]?.contractHash, compileCodingDispatchIR(contract, { cwd: "/repo" }).hash);
});

test("coding spawn forwards resolver metadata raw as RPC options and excludes spawnKey from params", async () => {
  const { pi, rpc, calls, tools } = setup();
  const metadata = { requestId: "durable-dispatch-3", spawnKey: "durable-dispatch-3" };
  createTestExtension(pi, { rpc, cleanupStore: {}, resolveCodingSpawnIdentity() { return metadata; } });
  await tools[0].execute("tool-call-identity-3", contract, undefined, undefined, { cwd: "/repo" });
  assert.strictEqual(calls[0]?.options, metadata);
  assert.equal(Object.hasOwn(calls[0]?.params ?? {}, "spawnKey"), false);
});

test("coding prepare runs after ping and before spawn", async () => {
  const { pi, rpc, tools } = setup(); const order = [];
  rpc.ping = async () => { order.push("ping"); return { version: 1, methods: ["spawn"], session: { sessionId: "s", cwd: "/repo" } }; };
  const spawn = rpc.spawn;
  rpc.spawn = async (...args) => { order.push("spawn"); return spawn(...args); };
  createTestExtension(pi, { rpc, cleanupStore: {}, async prepareCodingSpawn() { order.push("prepare"); } });
  await tools[0].execute("prepare-call", contract, undefined, undefined, { cwd: "/repo" });
  assert.deepEqual(order, ["ping", "prepare", "spawn"]);
});

test("coding prepare runs before durable identity resolution", async () => {
  const { pi, rpc, tools } = setup(); const order = [];
  rpc.ping = async () => { order.push("ping"); return { version: 1, methods: ["spawn"], session: { sessionId: "s", cwd: "/repo" } }; };
  const spawn = rpc.spawn;
  rpc.spawn = async (...args) => { order.push("spawn"); return spawn(...args); };
  createTestExtension(pi, { rpc, cleanupStore: {}, async prepareCodingSpawn() { order.push("prepare"); }, resolveCodingSpawnIdentity() { order.push("resolveIdentity"); return { requestId: "x", spawnKey: "x" }; } });
  await tools[0].execute("prepare-resolver-call", contract, undefined, undefined, { cwd: "/repo" });
  assert.deepEqual(order, ["ping", "prepare", "resolveIdentity", "spawn"]);
});

test("coding prepare failure prevents identity resolution and spawn", async () => {
  const { pi, rpc, calls, tools } = setup(); let resolved = 0;
  createTestExtension(pi, { rpc, cleanupStore: {}, async prepareCodingSpawn() { throw new Error("owner wrapper failed"); }, resolveCodingSpawnIdentity() { resolved += 1; return { requestId: "x", spawnKey: "x" }; } });
  const result = await tools[0].execute("prepare-fail", contract, undefined, undefined, { cwd: "/repo" });
  assert.equal(result.isError, true); assert.match(result.content[0].text, /owner wrapper failed/);
  assert.equal(calls.length, 0); assert.equal(resolved, 0);
});

test("generic and control dispatches never prepare or resolve coding spawn identity", async () => {
  const { pi, rpc, tools } = setup(); let resolved = 0; let prepared = 0;
  createTestExtension(pi, { rpc, cleanupStore: {}, async prepareCodingSpawn() { prepared += 1; }, resolveCodingSpawnIdentity() { resolved += 1; return { requestId: "x", spawnKey: "x" }; } });
  await tools[0].execute("generic-call", { agent: "reviewer", title: "Review", task: "Inspect." }, undefined, undefined, { cwd: "/repo" });
  await tools[0].execute("control-call", { action: "status", id: "run-1" }, undefined, undefined, { cwd: "/repo" });
  assert.equal(resolved, 0); assert.equal(prepared, 0);
});
