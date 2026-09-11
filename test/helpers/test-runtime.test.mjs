import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { relative } from "node:path";
import test from "node:test";

import { createTestRuntime } from "./test-runtime.mjs";

test("createTestRuntime gives each test a tmp root and scoped runtime environment", async (t) => {
  const first = await createTestRuntime(t, "runtime-helper-");
  const second = await createTestRuntime(t, "runtime-helper-");
  assert.notEqual(first.root, second.root);
  assert.ok(relative(tmpdir(), first.root) && !relative(tmpdir(), first.root).startsWith(".."));
  assert.deepEqual(first.env(), {
    PI_CODING_AGENT_DIR: first.agentDir,
    PI_CODING_AGENT_SESSION_DIR: first.sessionDir,
    PI_SESSION_OWNER_REGISTRY: first.registryDir,
    PI_CODING_WORKSPACE_DIR: first.workspaceDir,
    PI_CODING_GOAL_DIR: first.goalDir,
  });
});
