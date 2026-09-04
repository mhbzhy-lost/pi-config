import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createTypedSubagentExtension } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts";
import { createManagedWorkspaceService } from "../packages/pi-subagents-enhanced/src/workspace/service.ts";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const terminalProof = { state: "observed", conflict: false, proofHash: "e".repeat(64) };

async function fixture(t) {
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
  const service = createManagedWorkspaceService({ stateRoot, terminalProofProvider: () => terminalProof });
  const workspaceIds = new Set();
  t.after(async () => {
    for (const workspaceId of workspaceIds) {
      try {
        const current = service.status({ workspaceId });
        if (current.receipt.state === "preserved") service.release({ workspaceId });
        else if (current.receipt.state === "active") {
          const issued = service.issueDisposition({ workspaceId, terminalProof });
          service.dispose({ workspaceId, terminalProof, disposition: "discard", actionToken: issued.actionToken });
        }
      } catch {}
    }
    await rm(root, { recursive: true, force: true });
  });
  return { root, originRoot, stateRoot, service, workspaceIds };
}

function piHarness(originRoot) {
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
    async ping() { return { version: 1, methods: ["spawn"], session: { sessionId: "root-session", cwd: originRoot } }; },
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
    version: "dispatch-ir.v1",
    taskId: "unified-workspace",
    title: "Use unified workspace",
    agent: "executor",
    risk: "normal",
    objective: "Exercise the typed facade against the managed workspace service.",
    workflow: { mode: "tdd" },
    requirements: ["Commit the allowed change."],
    context: { knownFacts: [], decisions: [], relevantFiles: ["allowed.txt"] },
    boundaries: { writePaths: ["allowed.txt"], excludedWork: [], forbiddenActions: [] },
    acceptance: { criteria: ["The committed change is integrated."] },
    execution: { cwd: originRoot, timeoutMs: 10_000, worktree: true },
  };
}

async function execute(tool, input, originRoot) {
  return tool.execute("tool-call", input, undefined, undefined, { cwd: originRoot, sessionManager: {} });
}

test("typed coding facade allocates, binds, reports, integrates, and releases through the unified service", async (t) => {
  const f = await fixture(t);
  const { pi, tools, calls, rpc } = piHarness(f.originRoot);
  const registered = [];
  createTypedSubagentExtension(pi, {
    rpc,
    cleanupStore: {},
    randomUUID: () => "coding-workspace",
    workspaceService: f.service,
    resolveRootSessionId: () => "root-session",
    registerFacadeRun(run) { registered.push(run); },
  });

  const spawned = await execute(tools[0], codingContract(f.originRoot), f.originRoot);
  assert.equal(spawned.isError, false, spawned.content[0]?.text);
  f.workspaceIds.add(spawned.details.workspace_id);
  assert.equal(spawned.details.workspace_state, "active");
  assert.equal(calls[0].cwd, spawned.details.dispatch_cwd);
  assert.equal(calls[0].worktree, false);
  assert.equal(JSON.parse(calls[0].workflowScript.match(/, (.*)\);$/)[1]).worktree, false);
  assert.equal(registered[0].runId, "leaf-run");

  await writeFile(join(spawned.details.dispatch_cwd, "allowed.txt"), "integrated\n");
  git(spawned.details.dispatch_cwd, "add", "allowed.txt");
  git(spawned.details.dispatch_cwd, "commit", "-m", "child change");
  const status = await execute(tools[0], { action: "workspace_status", workspace_id: spawned.details.workspace_id }, f.originRoot);
  assert.ok(status.details.allowed_dispositions.includes("integrate"));
  const disposed = await execute(tools[0], {
    action: "workspace_disposition",
    workspace_id: spawned.details.workspace_id,
    disposition: "integrate",
    action_token: status.details.action_token,
  }, f.originRoot);
  assert.equal(disposed.details.workspace_state, "released");
  assert.equal(await readFile(join(f.originRoot, "allowed.txt"), "utf8"), "integrated\n");
  assert.equal(existsSync(spawned.details.dispatch_cwd), false);
});

test("typed generic facade preserves and explicitly releases through the same service", async (t) => {
  const f = await fixture(t);
  const { pi, tools, rpc } = piHarness(f.originRoot);
  createTypedSubagentExtension(pi, {
    rpc,
    cleanupStore: {},
    randomUUID: () => "generic-workspace",
    workspaceService: f.service,
    resolveRootSessionId: () => "root-session",
    registerFacadeRun() {},
  });

  const spawned = await execute(tools[0], { agent: "reviewer", title: "Review", task: "Inspect.", cwd: f.originRoot, worktree: true }, f.originRoot);
  assert.equal(spawned.isError, false, spawned.content[0]?.text);
  f.workspaceIds.add(spawned.details.workspace_id);
  const status = await execute(tools[0], { action: "workspace_status", workspace_id: spawned.details.workspace_id }, f.originRoot);
  assert.equal(status.details.allowed_dispositions.includes("integrate"), false);
  const preserved = await execute(tools[0], {
    action: "workspace_disposition",
    workspace_id: spawned.details.workspace_id,
    disposition: "preserve",
    action_token: status.details.action_token,
  }, f.originRoot);
  assert.equal(preserved.details.workspace_state, "preserved");
  const released = await execute(tools[0], { action: "workspace_disposition", workspace_id: spawned.details.workspace_id, disposition: "release" }, f.originRoot);
  assert.equal(released.details.workspace_state, "released");
  assert.equal(existsSync(spawned.details.dispatch_cwd), false);
});
