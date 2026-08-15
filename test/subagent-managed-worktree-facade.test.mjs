import assert from "node:assert/strict";
import test from "node:test";
import { createTypedSubagentExtension, TYPED_SUBAGENT_PARAMETERS } from "../scripts/lib/subagent-dispatch/extension.ts";

function pi() { const handlers = new Map(); const events = { on(name, fn) { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); return () => {}; }, emit(name, event) { for (const fn of handlers.get(name) ?? []) fn(event); } }; return { events, tools: [], registerTool(t) { this.tools.push(t); }, on() {} }; }
function rpc(events) { return { calls: [], async ping() { this.calls.push("ping"); return { version: 1, methods: ["spawn"], session: { sessionId: "s", sessionFile: "s", cwd: "/repo" } }; }, async spawn(params) { this.calls.push(params); events.emit("subagent:async-started", { runId: "leaf", asyncDir: "/async", sessionId: "s", pid: 1, agent: "reviewer", workflowKey: "typed-id", parentWorkflowRunId: "root" }); return { details: { runId: "root", asyncDir: "/root" } }; } }; }

test("managed generic dispatch isolates only child cwd and retains public workspace handle", async () => {
  const host = pi(); const client = rpc(host.events); const allocations = [];
  createTypedSubagentExtension(host, { rpc: client, cleanupStore: {}, randomUUID: () => "id", resolveCanonicalOrigin: () => "/repo", resolveRootSessionId: () => "root-session", workspaceController: { allocateManagedSubagentWorkspace(input) { allocations.push(input); return { workspaceId: "ws-1", state: "active", dispatchCwd: "/workspace" }; }, bindManagedSubagentWorkspaceRun() {} }, registerFacadeRun() {} });
  const result = await host.tools[0].execute("call", { agent: "reviewer", title: "Review", task: "review", worktree: true }, undefined, undefined, { cwd: "/repo" });
  assert.equal(result.isError, false); assert.equal(client.calls[1].cwd, "/workspace"); assert.equal(client.calls[1].worktree, false);
  assert.equal(allocations[0].originRoot, "/repo"); assert.equal(allocations[0].rootSessionId, "root-session");
  assert.equal(result.details.workspace_id, "ws-1"); assert.doesNotMatch(JSON.stringify(result), /ownerToken|actionToken/);
});

test("workspace actions are strict local schemas", () => {
  assert.equal(TYPED_SUBAGENT_PARAMETERS.anyOf.some((schema) => schema.properties?.action?.const === "workspace_status"), true);
  assert.equal(TYPED_SUBAGENT_PARAMETERS.anyOf.some((schema) => schema.properties?.action?.const === "workspace_disposition"), true);
});

function coding(overrides = {}) { return { version: "dispatch-ir.v1", taskId: "facade-order", title: "Facade order", agent: "executor", risk: "normal", objective: "Verify facade ordering.", workflow: { mode: "tdd" }, requirements: ["Test the order."], context: { knownFacts: ["A fact."], decisions: ["A decision."], relevantFiles: ["test/x.mjs"] }, boundaries: { writePaths: ["test/x.mjs"], excludedWork: ["none"], forbiddenActions: ["none"] }, acceptance: { criteria: ["works"] }, execution: { timeoutMs: 10_000, worktree: true }, ...overrides, execution: { timeoutMs: 10_000, worktree: true, ...overrides.execution } }; }
function facade({ goal, spawnError, registerError, bindError, pingError } = {}) {
  const host = pi(); const calls = []; const allocated = { workspaceId: "ws-1", state: "active", dispatchCwd: "/workspace" };
  const client = { async ping() { calls.push("ping"); if (pingError) throw pingError; return { version: 1, methods: ["spawn"], session: { sessionId: "s", sessionFile: "s", cwd: "/repo" } }; }, async spawn(params) { calls.push(`spawn:${params.cwd}`); if (spawnError) throw spawnError; host.events.emit("subagent:async-started", { runId: "leaf", asyncDir: "/async", sessionId: "s", pid: 1, agent: params.workflowScript.includes("executor") ? "executor" : "reviewer", workflowKey: "typed-id", parentWorkflowRunId: "root" }); return { details: { runId: "root", asyncDir: "/root" } }; } };
  const controller = { allocateManagedSubagentWorkspace() { calls.push("allocate"); return allocated; }, bindManagedSubagentWorkspaceRun() { calls.push("bind"); if (bindError) throw bindError; } };
  createTypedSubagentExtension(host, { rpc: client, cleanupStore: {}, randomUUID: () => "id", resolveCanonicalOrigin: () => "/repo", resolveRootSessionId: () => "root", registerFacadeRun() { calls.push("register"); if (registerError) throw registerError; }, workspaceController: controller, workflowChildStartTimeoutMs: 50, goalExecutorCoordinator: goal, prepareCodingSpawn(ir) { calls.push(`prepare:${ir.execution.cwd}`); } });
  return { host, calls };
}

// RED: Goal-bound managed runs must not materialize the origin child entry or allocate.
test("coding Goal worktree rejection precedes prepare and allocation", async () => {
  const goal = { async prepareSpawn() { return { ticketId: "goal" }; } }; const { host, calls } = facade({ goal });
  const result = await host.tools[0].execute("call", coding(), undefined, undefined, { cwd: "/repo" });
  assert.equal(result.details.code, "WORKSPACE_GOAL_BOUND_FORBIDDEN"); assert.deepEqual(calls, ["ping"]);
});

test("coding managed non-Goal prepares exactly the runtime cwd before spawn", async () => {
  const { host, calls } = facade(); const result = await host.tools[0].execute("call", coding(), undefined, undefined, { cwd: "/repo" });
  assert.equal(result.isError, false); assert.deepEqual(calls, ["ping", "allocate", "prepare:/workspace", "spawn:/workspace", "register", "bind"]); assert.equal(calls.filter((x) => x.startsWith("prepare:")).length, 1);
});

test("managed leaf registers its complete collector identity before durable binding", async () => {
  const host = pi(); const calls = []; let registered;
  const client = { async ping() { return { version: 1, methods: ["spawn"], session: { sessionId: "s", sessionFile: "s", cwd: "/repo" } }; }, async spawn() { calls.push("spawn"); host.events.emit("subagent:async-started", { runId: "leaf", asyncDir: "/async", sessionId: "s", pid: 1, agent: "reviewer", workflowKey: "typed-id", parentWorkflowRunId: "root" }); return { details: { runId: "root", asyncDir: "/root" } }; } };
  createTypedSubagentExtension(host, { rpc: client, cleanupStore: {}, randomUUID: () => "id", resolveCanonicalOrigin: () => "/repo", resolveRootSessionId: () => "root", registerFacadeRun(binding) { calls.push("register"); registered = binding; assert.deepEqual(binding, { runId: "leaf", asyncDir: "/async", sessionId: "s", pid: 1, agent: "reviewer", kind: "generic" }); }, workspaceController: { allocateManagedSubagentWorkspace() { return { workspaceId: "ws-1", state: "active", dispatchCwd: "/workspace" }; }, bindManagedSubagentWorkspaceRun(_workspace, binding) { calls.push("bind"); assert.deepEqual(binding, { runId: "leaf", asyncDir: "/async" }); } }, workflowChildStartTimeoutMs: 50 });
  const result = await host.tools[0].execute("call", { agent: "reviewer", title: "Review", task: "review", worktree: true }, undefined, undefined, { cwd: "/repo" });
  assert.equal(result.isError, false); assert.deepEqual(calls, ["spawn", "register", "bind"]); assert.equal(registered.pid, 1);
});

for (const [name, options] of [["spawn", { spawnError: new Error("spawn failed") }], ["register", { registerError: new Error("register failed") }], ["bind", { bindError: new Error("bind failed") }]]) {
  test(`managed coding ${name} failure retains allocated workspace id`, async () => {
    const { host, calls } = facade(options); const result = await host.tools[0].execute("call", coding(), undefined, undefined, { cwd: "/repo" });
    assert.equal(result.isError, true, JSON.stringify({ calls, result })); assert.deepEqual(result.details.detail, { workspace_id: "ws-1", workspace_state: "active" });
  });
}

test("managed register failure returns the workspace identity without durable binding", async () => {
  const { host, calls } = facade({ registerError: new Error("register failed") });
  const result = await host.tools[0].execute("call", coding(), undefined, undefined, { cwd: "/repo" });
  assert.equal(result.isError, true); assert.deepEqual(result.details.detail, { workspace_id: "ws-1", workspace_state: "active" }); assert.equal(calls.includes("bind"), false);
});

test("managed workspace fails closed for missing proof dependencies before allocation", async () => {
  for (const [missing, code] of [["resolveRootSessionId", "WORKSPACE_SESSION_ID_UNAVAILABLE"], ["registerFacadeRun", "FACADE_PROOF_UNAVAILABLE"]]) {
    const host = pi(); let allocations = 0;
    createTypedSubagentExtension(host, { rpc: { async ping() { return { version: 1, methods: ["spawn"], session: { sessionId: "s", sessionFile: "s", cwd: "/repo" } }; } }, cleanupStore: {}, randomUUID: () => "id", resolveCanonicalOrigin: () => "/repo", ...(missing === "resolveRootSessionId" ? {} : { resolveRootSessionId: () => "root" }), ...(missing === "registerFacadeRun" ? {} : { registerFacadeRun() {} }), workspaceController: { allocateManagedSubagentWorkspace() { allocations += 1; } } });
    const result = await host.tools[0].execute("call", { agent: "reviewer", title: "Review", task: "review", worktree: true }, undefined, undefined, { cwd: "/repo" });
    assert.equal(result.details.code, code); assert.equal(allocations, 0);
  }
});

test("managed generic ping failure does not allocate", async () => {
  const { host, calls } = facade({ pingError: new Error("offline") }); const result = await host.tools[0].execute("call", { agent: "reviewer", title: "Review", task: "review", worktree: true }, undefined, undefined, { cwd: "/repo" });
  assert.equal(result.isError, true); assert.deepEqual(calls, ["ping"]);
});

test("managed generic orders ping then allocation then spawn and title preparation", async () => {
  const { host, calls } = facade(); const result = await host.tools[0].execute("call", { agent: "reviewer", title: "Review", task: "review", worktree: true }, undefined, undefined, { cwd: "/repo" });
  assert.equal(result.isError, false); assert.deepEqual(calls, ["ping", "allocate", "spawn:/workspace", "register", "bind"]);
});

function workspaceActions({ cleanupStore = {}, resolveCanonicalOrigin = () => "/repo", load, status, dispose, inspect } = {}) {
  const host = pi(); const calls = []; let proof = 0;
  const controller = {
    allocateManagedSubagentWorkspace() { return { workspaceId: "ws-1", state: "active", dispatchCwd: "/workspace" }; },
    bindManagedSubagentWorkspaceRun(_input, binding) { calls.push(["bind", binding]); },
    loadManagedSubagentWorkspace(input) { calls.push(["load", input]); return load ? load(input) : { workspaceId: "ws-1", state: "active", runId: "leaf" }; },
    statusManagedSubagentWorkspace(input) { calls.push(["status", input]); return status ? status(input) : { workspaceId: "ws-1", state: "active", allowedDispositions: ["integrate", "discard"], actionToken: "public-token", ownerToken: "private" }; },
    disposeManagedSubagentWorkspace(input) { calls.push(["dispose", input]); return dispose ? dispose(input) : { workspaceId: "ws-1", state: "released", allowedDispositions: ["preserve"], actionToken: "next-token", ownerToken: "private" }; },
  };
  const client = rpc(host.events);
  createTypedSubagentExtension(host, { rpc: client, cleanupStore, randomUUID: () => "id", resolveCanonicalOrigin, resolveRootSessionId: () => "root", registerFacadeRun() {}, inspectFacadeTerminalProof(runId) { calls.push(["proof", runId]); proof += 1; return inspect ? inspect(runId) : { state: proof === 1 ? "running" : "succeeded", privateProof: "secret" }; }, workspaceController: controller, workflowChildStartTimeoutMs: 50 });
  return { host, calls, client };
}

test("workspace status uses fresh local proof and exposes only snake_case public details", async () => {
  const { host, calls, client } = workspaceActions(); const tool = host.tools[0];
  await tool.execute("call", { agent: "reviewer", title: "Review", task: "review", worktree: true }, undefined, undefined, { cwd: "/repo" });
  const callsBeforeActions = client.calls.length;
  const first = await tool.execute("call", { action: "workspace_status", workspace_id: "ws-1" }, undefined, undefined, { cwd: "/repo" });
  const second = await tool.execute("call", { action: "workspace_status", workspace_id: "ws-1" }, undefined, undefined, { cwd: "/repo" });
  assert.equal(first.details.process_terminal, "running"); assert.equal(second.details.process_terminal, "succeeded");
  assert.deepEqual(Object.keys(second.details).sort(), ["action_token", "allowed_dispositions", "process_terminal", "state", "workspace_id", "workspace_state"]);
  assert.doesNotMatch(JSON.stringify(second.details), /private|proof/i); assert.equal(client.calls.length, callsBeforeActions);
  assert.equal(calls.filter(([name]) => name === "load").length, 2);
});

test("workspace status content exposes the active disposition capability without private fields", async () => {
  const { host } = workspaceActions();
  const result = await host.tools[0].execute("call", { action: "workspace_status", workspace_id: "ws-1" }, undefined, undefined, { cwd: "/repo" });
  const content = JSON.parse(result.content[0].text);

  assert.deepEqual(content, {
    workspace_id: "ws-1",
    state: "active",
    workspace_state: "active",
    process_terminal: "running",
    allowed_dispositions: ["integrate", "discard"],
    action_token: "public-token",
  });
  assert.doesNotMatch(result.content[0].text, /ownerToken|privateProof|private terminal proof/i);
});

test("workspace disposition refreshes proof locally and rejects invalid strategy before every dependency", async () => {
  const { host, calls, client } = workspaceActions(); const tool = host.tools[0];
  const invalid = await tool.execute("call", { action: "workspace_disposition", workspace_id: "ws-1", disposition: "discard", strategy: "merge", action_token: "t" }, undefined, undefined, { cwd: "/repo" });
  assert.equal(invalid.details.code, "INVALID_WORKSPACE_STRATEGY"); assert.deepEqual(calls, []); assert.equal(client.calls.length, 0);
  await tool.execute("call", { agent: "reviewer", title: "Review", task: "review", worktree: true }, undefined, undefined, { cwd: "/repo" });
  const callsBeforeActions = client.calls.length;
  const result = await tool.execute("call", { action: "workspace_disposition", workspace_id: "ws-1", disposition: "integrate", strategy: "merge", action_token: "t" }, undefined, undefined, { cwd: "/repo" });
  const dispose = calls.find(([name]) => name === "dispose")[1]; assert.equal(result.isError, false); assert.equal(dispose.strategy, "merge"); assert.equal(dispose.actionToken, "t"); assert.equal(dispose.terminalProof.state, "running"); assert.equal(client.calls.length, callsBeforeActions);
});

test("workspace reload fallback loads canonical origin, repopulates it, and omits inactive action token", async () => {
  let resolves = 0;
  const { host, calls } = workspaceActions({ cleanupStore: {}, resolveCanonicalOrigin: () => { resolves += 1; return "/reloaded"; }, status: () => ({ workspaceId: "ws-1", state: "inactive", allowedDispositions: ["preserve"], actionToken: "private-action-token" }) });
  const result = await host.tools[0].execute("call", { action: "workspace_status", workspace_id: "ws-1" }, undefined, undefined, { cwd: "/repo" });
  const again = await host.tools[0].execute("call", { action: "workspace_status", workspace_id: "ws-1" }, undefined, undefined, { cwd: "/repo" });
  assert.equal(result.isError, false); assert.equal(calls[0][0], "load"); assert.equal(calls[0][1].originRoot, "/reloaded"); assert.equal(resolves, 1);
  assert.equal(Object.hasOwn(again.details, "action_token"), false);
  assert.equal(Object.hasOwn(JSON.parse(again.content[0].text), "action_token"), false);
});

test("workspace resolver and loader failures return errors without proof or actions", async () => {
  for (const options of [
    { resolveCanonicalOrigin() { throw new Error("no origin"); } },
    { load() { throw new Error("no workspace"); } },
  ]) {
    const { host, calls, client } = workspaceActions(options);
    const result = await host.tools[0].execute("call", { action: "workspace_status", workspace_id: "ws-1" }, undefined, undefined, { cwd: "/repo" });
    assert.equal(result.isError, true); assert.equal(calls.some(([name]) => name === "proof" || name === "status" || name === "dispose"), false); assert.equal(client.calls.length, 0);
  }
});
