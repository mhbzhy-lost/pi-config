import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createManagedWorkspaceRequestV2 } from "../packages/pi-subagents-enhanced/src/workspace/contract.ts";
import { createManagedWorkspaceService } from "../packages/pi-subagents-enhanced/src/workspace/service.ts";
import { createSubagentWorkspaceTool } from "../packages/pi-subagents-enhanced/src/workspace/tool.ts";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

test("subagent_worktree derives standalone ownership from live context and exposes only public actions", async () => {
  const calls = [];
  const service = {
    listOwned(input) { calls.push(["listOwned", input]); return []; },
    statusOwned(input) { calls.push(["statusOwned", input]); return { receipt: { workspaceId: "workspace-a", state: "active", leaseId: "lease-a" } }; },
    issueOwnedDisposition(input) {
      calls.push(["issueOwnedDisposition", input]);
      return {
        receipt: { workspaceId: "workspace-a", state: "active", leaseId: "lease-a" },
        terminalProof: { state: "observed" }, actionToken: "token-a",
        allowedDispositions: ["integrate", "discard", "preserve"], blockedReasons: [],
      };
    },
    disposeOwned(input) { calls.push(["disposeOwned", input]); return { workspaceId: input.workspaceId, state: "released", leaseId: "lease-a" }; },
    releaseOwned(input) { calls.push(["releaseOwned", input]); return { workspaceId: input.workspaceId, state: "released", leaseId: "lease-a" }; },
  };
  const tool = createSubagentWorkspaceTool({
    service,
    resolveRootSessionId(sessionManager) { return sessionManager.rootSessionId; },
  });

  assert.equal(tool.name, "subagent_worktree");
  assert.deepEqual(tool.parameters.anyOf.map((branch) => branch.properties.action.const), ["list", "status", "dispose", "release"]);
  assert.equal(JSON.stringify(tool.parameters).includes("rootSessionId"), false);
  const status = await tool.execute("call", { action: "status", workspace_id: "workspace-a" }, undefined, undefined, { sessionManager: { rootSessionId: "session-a" } });
  assert.equal(status.isError, false);
  assert.equal(status.details.action_token, "token-a");
  assert.deepEqual(calls, [
    ["statusOwned", { workspaceId: "workspace-a", ownerScope: { kind: "standalone-subagent", rootSessionId: "session-a" } }],
    ["issueOwnedDisposition", { workspaceId: "workspace-a", ownerScope: { kind: "standalone-subagent", rootSessionId: "session-a" } }],
  ]);
});

test("subagent_worktree fails closed before disposition issuance for a foreign receipt", async () => {
  let issued = 0;
  const tool = createSubagentWorkspaceTool({
    resolveRootSessionId() { return "session-b"; },
    service: {
      listOwned() { throw new Error("not reached"); },
      statusOwned() { throw Object.assign(new Error("foreign workspace"), { code: "MANAGED_WORKSPACE_OWNER_SCOPE" }); },
      issueOwnedDisposition() { issued += 1; },
      disposeOwned() { throw new Error("not reached"); },
      releaseOwned() { throw new Error("not reached"); },
    },
  });

  const result = await tool.execute("call", { action: "status", workspace_id: "workspace-a" }, undefined, undefined, { sessionManager: {} });
  assert.equal(result.isError, true);
  assert.equal(result.details.code, "MANAGED_WORKSPACE_OWNER_SCOPE");
  assert.equal(issued, 0);
});

test("root cannot directly integrate a public child workspace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "child-owns-integration-"));
  const originRoot = join(root, "origin");
  await mkdir(originRoot);
  git(originRoot, "init", "-b", "main");
  git(originRoot, "config", "user.email", "test@example.com");
  git(originRoot, "config", "user.name", "Test");
  await writeFile(join(originRoot, "base.txt"), "base\n");
  git(originRoot, "add", ".");
  git(originRoot, "commit", "-m", "base");
  t.after(() => rm(root, { recursive: true, force: true }));

  const service = createManagedWorkspaceService({ stateRoot: join(root, "state") });
  const owner = { kind: "standalone-subagent", rootSessionId: "root-child", toolCallId: "tool-child" };
  const active = service.ensureAllocated(createManagedWorkspaceRequestV2({
    workspaceId: "workspace-child", owner, originRoot, requestedCwd: originRoot,
    originRef: "refs/heads/main", baseCommit: git(originRoot, "rev-parse", "HEAD"), contractHash: "a".repeat(64),
    policy: { publication: "allowed", application: "allowed", writePaths: ["result.txt"] },
  }));
  service.bindRun({ workspaceId: active.workspaceId, run: { runId: "run-child", asyncDir: join(root, "async") } });
  await writeFile(join(active.path, "result.txt"), "result\n");
  git(active.path, "add", "result.txt");
  git(active.path, "commit", "-m", "result");
  const proof = { state: "observed", conflict: false, runId: "run-child", rootSessionId: "root-child", asyncDir: join(root, "async"), processInstance: "process-child", proofId: "e".repeat(64) };
  const issued = service.issueAction({ workspaceId: active.workspaceId, ownerScope: { kind: "standalone-subagent", rootSessionId: "root-child" }, action: "publish", terminalProof: proof });
  assert.throws(() => service.disposeOwned({
    workspaceId: active.workspaceId, ownerScope: { kind: "standalone-subagent", rootSessionId: "root-child" },
    disposition: "integrate", terminalProof: proof, actionToken: issued.actionToken,
  }), (error) => error?.code === "CHILD_OWNS_INTEGRATION");
});

test("child integration tool exposes eight actions and injects trusted identity", async () => {
  // 前序 T10 产物 stale expectation 修复：production 稳定暴露 8 个 action
  // （新增 inspect_integration_state / prepare_auto_integration / inspect_auto_integration）。
  const { createSubagentIntegrationTool } = await import("../packages/pi-subagents-enhanced/child-extensions/integration-queue.ts");
  const calls = [];
  const coordinator = Object.fromEntries([
    ["enqueueIntegration", "enqueue"], ["awaitIntegrationAdmission", "await_admission"],
    ["reportResolvingConflict", "report_conflict"], ["publishRebasedCandidate", "publish"], ["abandonIntegration", "fail"],
    ["inspectIntegrationState", "inspect_integration_state"],
    ["prepareAutoIntegration", "prepare_auto_integration"],
    ["inspectAutoIntegration", "inspect_auto_integration"],
  ].map(([method, action]) => [method, async (input) => { calls.push([action, input]); return { action }; }]));
  const trusted = { workspaceId: "trusted-workspace", leaseId: "trusted-lease", runId: "trusted-run", ownerScope: { kind: "standalone-subagent", rootSessionId: "trusted-root" } };
  const tool = createSubagentIntegrationTool({ coordinator, resolveBinding: () => trusted });
  assert.deepEqual(tool.parameters.properties.action.enum, [
    "enqueue", "await_admission", "report_conflict", "publish", "fail",
    "inspect_integration_state", "prepare_auto_integration", "inspect_auto_integration",
  ]);
  assert.doesNotMatch(JSON.stringify(tool.parameters), /workspace_id|run_id|root_session/i);
  const supplied = { workspaceId: "forged", runId: "forged", ownerScope: { rootSessionId: "forged" }, queue_item_id: "queue-1", queue_lease_id: "queue-lease", candidate_head: "c".repeat(40), authorized_workspace_head: "a".repeat(40), target_ref: "refs/heads/main" };
  for (const action of tool.parameters.properties.action.enum) {
    const response = await tool.execute("call", { ...supplied, action });
    assert.equal(response.isError, false, `${action} should call the coordinator`);
  }
  assert.equal(calls.length, 8);
  for (const [, input] of calls) {
    assert.equal(input.workspaceId, trusted.workspaceId);
    assert.equal(input.runId, trusted.runId);
    assert.deepEqual(input.ownerScope, trusted.ownerScope);
  }
});
