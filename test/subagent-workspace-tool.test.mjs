import assert from "node:assert/strict";
import test from "node:test";

import { createSubagentWorkspaceTool } from "../packages/pi-subagents-enhanced/src/workspace/tool.ts";

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
