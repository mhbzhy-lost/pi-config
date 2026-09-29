import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { piHostAliases, piHostJitiUrl } from "./helpers/pi-host.mjs";

import { createTypedSubagentExtension as createTypedSubagentExtensionProduction } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts";
import { RootBrokerServer } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts";
import { createManagedWorkspaceLedger } from "../packages/pi-subagents-enhanced/src/workspace/ledger.ts";
import { createManagedWorkspaceService } from "../packages/pi-subagents-enhanced/src/workspace/service.ts";

const { createJiti } = await import(piHostJitiUrl);
const runtimeJiti = createJiti(import.meta.url, { moduleCache: false, alias: piHostAliases });
const { projectManagedWorkspaceTerminalProof } = await runtimeJiti.import("../packages/pi-subagents-enhanced/extensions/subagent-runtime.ts");

function createTypedSubagentExtension(pi, options = {}) {
  return createTypedSubagentExtensionProduction(pi, {
    registerAuthorizedRun() {},
    discoverAgents() { return { agents: [{ name: "executor" }, { name: "reviewer" }] }; },
    ...options,
  });
}

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
// The service validates proofs against the v2 ledger schema, so the fixture
// provider projects the v2 seven-field identity shape.
const v2TerminalProof = (run) => ({ state: "observed", conflict: false, runId: run.runId, rootSessionId: "root-session", asyncDir: run.asyncDir, processInstance: `runner-${run.runId}`, proofId: "e".repeat(64) });

async function fixture(t, { terminalProofProvider = ({ run }) => run?.runId ? v2TerminalProof(run) : { state: "pending" } } = {}) {
  const root = await mkdtemp(join(tmpdir(), "typed-managed-workspace-"));
  const originRoot = join(root, "origin");
  const stateRoot = join(root, "state");
  execFileSync("mkdir", [originRoot]);
  git(originRoot, "init", "-b", "main");
  git(originRoot, "config", "user.email", "test@example.invalid");
  git(originRoot, "config", "user.name", "Test");
  await writeFile(join(originRoot, "allowed.txt"), "base\n");
  git(originRoot, "add", "allowed.txt");
  git(originRoot, "commit", "-m", "base");
  const service = createManagedWorkspaceService({ stateRoot, terminalProofProvider });
  const ledger = createManagedWorkspaceLedger({ stateRoot });
  const workspaceIds = new Set();
  t.after(async () => {
    for (const workspaceId of workspaceIds) {
      try {
        const record = ledger.load(workspaceId).record;
        const proof = record.run ? v2TerminalProof(record.run) : undefined;
        const current = service.status({ workspaceId, ...(proof ? { terminalProof: proof } : {}) });
        if (current.receipt.state === "preserved") service.release({ workspaceId });
        else if (current.receipt.state === "active") {
          const issued = service.issueDisposition({ workspaceId, ...(proof ? { terminalProof: proof } : {}) });
          service.dispose({ workspaceId, ...(proof ? { terminalProof: proof } : {}), disposition: record.run ? "discard" : "preserve", actionToken: issued.actionToken });
          if (!record.run) service.release({ workspaceId });
        }
      } catch {}
    }
    await rm(root, { recursive: true, force: true });
  });
  return { root, originRoot, stateRoot, service, ledger, workspaceIds };
}

function piHarness(originRoot) {
  const sessionRoot = realpathSync(originRoot);
  const tools = [];
  const listeners = new Map();
  const events = {
    on(type, listener) {
      const current = listeners.get(type) ?? new Set();
      current.add(listener);
      listeners.set(type, current);
      return () => current.delete(listener);
    },
    emit(type, value) { for (const listener of listeners.get(type) ?? []) listener(value); },
  };
  const pi = { events, registerTool(tool) { tools.push(tool); }, on() {} };
  const calls = [];
  const rpc = {
    async ping() { return { version: 1, methods: ["spawn"], session: { sessionId: "root-session", sessionFile: "root-session", cwd: sessionRoot } }; },
    async spawn(params) {
      calls.push(params);
      const match = params.workflowScript.match(/^return await runs\.run\(([^,]+), (.*)\);$/);
      const workflowKey = JSON.parse(match[1]);
      const leaf = JSON.parse(match[2]);
      queueMicrotask(() => events.emit("subagent:async-started", {
        parentWorkflowRunId: "workflow-root",
        runId: "leaf-run",
        asyncDir: join(originRoot, "async-leaf"),
        sessionId: "root-session",
        pid: process.pid,
        agent: leaf.agent,
        workflowKey,
      }));
      return { details: { runId: "workflow-root", asyncDir: join(originRoot, "async-root") } };
    },
    dispose() {},
  };
  return { pi, tools, calls, rpc };
}

function codingContract(originRoot) {
  return {
    title: "Use unified workspace",
    agent: "executor",
    task: "Exercise the typed facade against the managed workspace service. Commit the allowed change. Known facts: none. Decisions: none. Relevant files: allowed.txt.",
    writePaths: ["allowed.txt"],
    acceptance: { criteria: ["The committed change is integrated."] },
    cwd: originRoot,
    worktree: true,
  };
}

async function execute(tool, input, originRoot, toolCallId = "tool-call") {
  return tool.execute(toolCallId, input, undefined, undefined, { cwd: originRoot, sessionManager: {} });
}

function strictAuthorizationRegistrar(expectedKind, registered) {
  return (authorization) => {
    const value = authorization?.binding;
    if (!authorization || typeof authorization !== "object" || Array.isArray(authorization)
      || authorization.kind !== expectedKind
      || !value || typeof value !== "object" || Array.isArray(value)
      || typeof value.runId !== "string" || value.runId.length === 0
      || typeof value.asyncDir !== "string" || !isAbsolute(value.asyncDir)
      || value.sessionId !== "root-session"
      || !Number.isSafeInteger(value.pid) || value.pid <= 0
      || typeof value.agentProfile !== "string" || value.agentProfile.length === 0) {
      throw new Error("Run authorization binding is invalid");
    }
    registered.push(authorization);
  };
}

function observedFacadeProof(runId) {
  const observedAt = 1_700_000_000_000;
  const runnerProcessInstanceId = `${runId}-runner`;
  return {
    version: 1,
    runId,
    runnerProcessInstanceId,
    state: "observed",
    observedAt,
    instances: [{ processInstanceId: runnerProcessInstanceId, kind: "runner", closeObservedAt: observedAt, exitCode: 0, signal: null }],
  };
}

test("Root broker rich terminal snapshot reaches managed workspace status through the runtime adapter", async (t) => {
  let broker;
  const f = await fixture(t, {
    terminalProofProvider({ run }) {
      return projectManagedWorkspaceTerminalProof(run, run?.runId ? broker?.inspectExecutionProof(run.runId) : null);
    },
  });
  broker = new RootBrokerServer({
    rootSessionId: "root-session",
    lifecycleSessionId: "root-session",
    upstream: { async ping() { return {}; }, async stop() {}, async dispose() {} },
  });
  const { pi, tools, rpc } = piHarness(f.originRoot);
  // Bounded Host adapter: it issues the same Goal ticket consumed by the
  // public coding facade, rather than manufacturing a Broker snapshot.
  const bound = [];
  const goalExecutorCoordinator = {
    async prepareSpawn({ contractHash }) {
      const baseCommit = git(f.originRoot, "rev-parse", "HEAD");
      return {
        version: "goal-run-binding-ticket.v2",
        ticketId: "a".repeat(64), goalId: "fixture-goal", taskId: "unified-workspace", attempt: 1,
        contractHash, workspaceId: "broker-proof-workspace", executionRevision: 1,
        expectedCriteria: ["managed-workspace"], agentProfile: "executor",
        workspaceRequest: {
          workspaceId: "broker-proof-workspace",
          owner: { kind: "goal-task", rootSessionId: "root-session", goalId: "fixture-goal", taskId: "unified-workspace", attempt: 1, executionRevision: 1 },
          originRoot: f.originRoot, requestedCwd: f.originRoot, originRef: "refs/heads/main", baseCommit, contractHash,
          policy: { publication: "allowed", application: "allowed", writePaths: ["allowed.txt"] },
        },
      };
    },
    async workspaceAllocated(ticket, receipt) { assert.equal(receipt.workspaceId, ticket.workspaceId); },
    async confirmSpawn() {},
    async bindSpawn(ticket, binding) { bound.push({ ticket, binding }); },
  };
  const registered = [];
  createTypedSubagentExtension(pi, {
    rpc,
    cleanupStore: {},
    randomUUID: () => "broker-proof-workspace",
    workspaceService: f.service,
    goalExecutorCoordinator,
    resolveRootSessionId: () => "root-session",
    registerAuthorizedRun(authorization) { registered.push(authorization); return broker.registerAuthorizedRun(authorization); },
  });

  const spawned = await execute(tools[0], codingContract(f.originRoot), f.originRoot);
  assert.equal(spawned.isError, false, spawned.content[0]?.text);
  f.workspaceIds.add(spawned.details.workspace_id);
  assert.deepEqual(bound.map(({ ticket, binding }) => [ticket.goalId, binding.runId, binding.asyncDir]), [["fixture-goal", "leaf-run", join(f.originRoot, "async-leaf")]]);
  assert.equal(Object.isFrozen(registered[0]), true);
  assert.equal(Object.isFrozen(registered[0].binding), true);
  assert.equal(Object.isFrozen(registered[0].capabilities), true);
  assert.equal(Object.isFrozen(registered[0].goal), true);
  assert.equal(Object.isFrozen(registered[0].goal.expectedCriteria), true);
  assert.deepEqual(registered[0].goal, { ticketId: "a".repeat(64), goalId: "fixture-goal", taskId: "unified-workspace", attempt: 1, contractHash: bound[0].ticket.contractHash, workspaceId: "broker-proof-workspace", executionRevision: 1, expectedCriteria: ["managed-workspace"] });
  broker.observeTerminal({
    ...observedFacadeProof("leaf-run"),
    sessionId: "root-session",
    pid: process.pid,
    asyncDir: join(f.originRoot, "async-leaf"),
    agent: "executor",
  });
  const richSnapshot = broker.inspectExecutionProof("leaf-run");
  assert.equal(richSnapshot.schemaVersion, "root-broker.execution-proof.v2");
  assert.equal(richSnapshot.binding.runId, "leaf-run");
  assert.equal(richSnapshot.authorization.state, "verified");
  assert.deepEqual(richSnapshot.capabilities, ["acceptance.submit", "root.subscribe"]);
  assert.match(richSnapshot.terminal.proofId, /^[a-f0-9]{64}$/);

  const status = f.service.status({ workspaceId: spawned.details.workspace_id });
  assert.equal(status.terminalProof.state, "observed");
  assert.ok(status.allowedDispositions.includes("discard"));
  assert.deepEqual(f.service.status({ workspaceId: spawned.details.workspace_id }).terminalProof, {
    state: "observed",
    conflict: false,
    runId: "leaf-run",
    rootSessionId: "root-session",
    asyncDir: join(f.originRoot, "async-leaf"),
    processInstance: "leaf-run-runner",
    proofId: richSnapshot.terminal.proofId,
  });
});

test("typed coding facade allocates, binds, reports, discards, and releases through the unified v2 service", async (t) => {
  const f = await fixture(t);
  const { pi, tools, calls, rpc } = piHarness(f.originRoot);
  const registered = [];
  createTypedSubagentExtension(pi, {
    rpc,
    cleanupStore: {},
    randomUUID: () => "coding-workspace",
    workspaceService: f.service,
    resolveRootSessionId: () => "root-session",
    registerAuthorizedRun: strictAuthorizationRegistrar("coding", registered),
  });

  const spawned = await execute(tools[0], codingContract(f.originRoot), f.originRoot);
  assert.equal(spawned.isError, false, spawned.content[0]?.text);
  f.workspaceIds.add(spawned.details.workspace_id);
  assert.equal(spawned.details.workspace_state, "active");
  assert.equal(f.ledger.load(spawned.details.workspace_id).record.schemaVersion, "managed-workspace-ledger.v2");
  assert.equal(f.service.status({ workspaceId: spawned.details.workspace_id }).receipt.owner.toolCallId, "tool-call");
  assert.equal(calls[0].cwd, realpathSync(f.originRoot));
  assert.equal(calls[0].worktree, false);
  assert.equal(JSON.parse(calls[0].workflowScript.match(/, (.*)\);$/)[1]).worktree, false);
  assert.equal(Object.hasOwn(f.service.status({ workspaceId: spawned.details.workspace_id }).receipt.run, "kind"), false);
  assert.equal(Object.hasOwn(spawned.details, "kind"), false);
  assert.equal(registered.length, 1);
  assert.deepEqual(registered[0].capabilities, ["root.subscribe"]);

  await writeFile(join(spawned.details.dispatch_cwd, "allowed.txt"), "integrated\n");
  git(spawned.details.dispatch_cwd, "add", "allowed.txt");
  git(spawned.details.dispatch_cwd, "commit", "-m", "child change");
  const status = await execute(tools[1], { action: "status", workspace_id: spawned.details.workspace_id }, f.originRoot);
  // v2 workspaces own integration in the child queue; the root tool only
  // offers destructive or preserving dispositions plus release.
  assert.equal(status.details.allowed_dispositions.includes("integrate"), false);
  assert.ok(status.details.allowed_dispositions.includes("discard"));
  assert.ok(status.details.allowed_dispositions.includes("preserve"));
  const childOwned = await execute(tools[1], {
    action: "dispose",
    workspace_id: spawned.details.workspace_id,
    disposition: "integrate",
    action_token: status.details.action_token,
  }, f.originRoot);
  assert.equal(childOwned.isError, true);
  assert.equal(childOwned.details.code, "CHILD_OWNS_INTEGRATION");
  const disposed = await execute(tools[1], {
    action: "dispose",
    workspace_id: spawned.details.workspace_id,
    disposition: "discard",
    action_token: status.details.action_token,
  }, f.originRoot);
  assert.equal(disposed.details.workspace_state, "released");
  assert.equal(await readFile(join(f.originRoot, "allowed.txt"), "utf8"), "base\n");
  assert.equal(existsSync(spawned.details.dispatch_cwd), false);
});

test("typed generic facade preserves and explicitly releases through the same service", async (t) => {
  const f = await fixture(t);
  const { pi, tools, rpc } = piHarness(f.originRoot);
  const registered = [];
  createTypedSubagentExtension(pi, {
    rpc,
    cleanupStore: {},
    randomUUID: () => "generic-workspace",
    workspaceService: f.service,
    resolveRootSessionId: () => "root-session",
    registerAuthorizedRun: strictAuthorizationRegistrar("generic", registered),
  });

  const spawned = await execute(tools[0], { agent: "reviewer", title: "Review", task: "Inspect.", cwd: f.originRoot, worktree: true }, f.originRoot);
  assert.equal(spawned.isError, false, spawned.content[0]?.text);
  assert.equal(Object.hasOwn(f.service.status({ workspaceId: spawned.details.workspace_id }).receipt.run, "kind"), false);
  assert.equal(Object.hasOwn(spawned.details, "kind"), false);
  assert.deepEqual(registered[0].capabilities, []);
  assert.equal(registered[0].binding.agentProfile, "reviewer");
  f.workspaceIds.add(spawned.details.workspace_id);
  const status = await execute(tools[1], { action: "status", workspace_id: spawned.details.workspace_id }, f.originRoot);
  assert.equal(status.details.allowed_dispositions.includes("integrate"), false);
  const preserved = await execute(tools[1], {
    action: "dispose",
    workspace_id: spawned.details.workspace_id,
    disposition: "preserve",
    action_token: status.details.action_token,
  }, f.originRoot);
  assert.equal(preserved.details.workspace_state, "preserved");
  const released = await execute(tools[1], { action: "release", workspace_id: spawned.details.workspace_id }, f.originRoot);
  assert.equal(released.details.workspace_state, "released");
  assert.equal(existsSync(spawned.details.dispatch_cwd), false);
});

test("typed coding facade canonicalizes composite Host tool call identities for isolated workspaces", async (t) => {
  const f = await fixture(t);
  const { pi, tools, calls, rpc } = piHarness(f.originRoot);
  const registered = [];
  let id = 0;
  createTypedSubagentExtension(pi, {
    rpc,
    cleanupStore: {},
    randomUUID: () => `coding-workspace-${++id}`,
    workspaceService: f.service,
    resolveRootSessionId: () => "root-session",
    registerAuthorizedRun: strictAuthorizationRegistrar("coding", registered),
  });

  const hostToolCallId = `call_${"a".repeat(100)}|fc_${"b".repeat(100)}`;
  const single = await execute(tools[0], codingContract(f.originRoot), f.originRoot, hostToolCallId);
  assert.equal(single.isError, false, single.content[0]?.text);
  f.workspaceIds.add(single.details.workspace_id);
  const singleOwner = f.service.status({ workspaceId: single.details.workspace_id }).receipt.owner.toolCallId;
  assert.match(singleOwner, /^host-tool-call-[a-f0-9]{64}$/);
  assert.ok(singleOwner.length <= 160);
  assert.equal(calls[0].worktree, false);

  const firstHostToolCallId = `call_${"c".repeat(100)}|fc_${"d".repeat(100)}`;
  const secondHostToolCallId = `call_${"e".repeat(100)}|fc_${"f".repeat(100)}`;
  const [first, second] = await Promise.all([
    execute(tools[0], codingContract(f.originRoot), f.originRoot, firstHostToolCallId),
    execute(tools[0], codingContract(f.originRoot), f.originRoot, secondHostToolCallId),
  ]);
  for (const result of [first, second]) {
    assert.equal(result.isError, false, result.content[0]?.text);
    f.workspaceIds.add(result.details.workspace_id);
  }
  assert.notEqual(first.details.workspace_id, second.details.workspace_id);
  const firstOwner = f.service.status({ workspaceId: first.details.workspace_id }).receipt.owner.toolCallId;
  const secondOwner = f.service.status({ workspaceId: second.details.workspace_id }).receipt.owner.toolCallId;
  assert.match(firstOwner, /^host-tool-call-[a-f0-9]{64}$/);
  assert.match(secondOwner, /^host-tool-call-[a-f0-9]{64}$/);
  assert.notEqual(firstOwner, secondOwner);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.worktree === false));
  assert.equal(registered.length, 3);
  assert.ok(registered.every((authorization) => authorization.capabilities.includes("root.subscribe")));

  const empty = await execute(tools[0], codingContract(f.originRoot), f.originRoot, "");
  assert.equal(empty.isError, true);
  assert.equal(empty.details.code, "WORKSPACE_TOOL_CALL_ID_UNAVAILABLE");
});

test("standalone coding and generic dispatch allocate managed-workspace-ledger.v2 records", async (t) => {
  const f = await fixture(t);
  const ledger = createManagedWorkspaceLedger({ stateRoot: f.stateRoot });
  let id = 0;
  const { pi, tools, rpc } = piHarness(f.originRoot);
  const registered = [];
  const registerEitherAuthorization = (authorization) => {
    if (!["coding", "generic"].includes(authorization?.kind)) throw new Error("Run authorization binding is invalid");
    const value = authorization?.binding;
    if (!value || typeof value !== "object" || typeof value.runId !== "string" || value.sessionId !== "root-session") {
      throw new Error("Run authorization binding is invalid");
    }
    registered.push(authorization);
  };
  createTypedSubagentExtension(pi, {
    rpc,
    cleanupStore: {},
    randomUUID: () => `v2-allocation-${++id}`,
    workspaceService: f.service,
    resolveRootSessionId: () => "root-session",
    registerAuthorizedRun: registerEitherAuthorization,
  });

  const coding = await execute(tools[0], codingContract(f.originRoot), f.originRoot, "v2-coding");
  assert.equal(coding.isError, false, coding.content[0]?.text);
  f.workspaceIds.add(coding.details.workspace_id);
  const codingRecord = ledger.load(coding.details.workspace_id).record;
  assert.equal(codingRecord.schemaVersion, "managed-workspace-ledger.v2");
  assert.deepEqual(codingRecord.request.policy, {
    publication: "allowed",
    application: "allowed",
    writePaths: ["allowed.txt"],
  });

  const generic = await execute(tools[0], { agent: "reviewer", title: "Review", task: "Inspect.", cwd: f.originRoot, worktree: true }, f.originRoot, "v2-generic");
  assert.equal(generic.isError, false, generic.content[0]?.text);
  f.workspaceIds.add(generic.details.workspace_id);
  const genericRecord = ledger.load(generic.details.workspace_id).record;
  assert.equal(genericRecord.schemaVersion, "managed-workspace-ledger.v2");
  assert.deepEqual(genericRecord.request.policy, {
    publication: "forbidden",
    application: "forbidden",
    writePaths: [],
  });
});
