import assert from "node:assert/strict";
import test from "node:test";

import { createManualIntegrationHandoff } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/recovery-resume-contract.ts";

// 产品语义：结束 child 的 queue 检查与 durable intent 仍保留，但不再自动拉起 child；
// 主 Agent 根据 handoff 接管 worktree，完成提交和 merge queue 收尾。
test("ended child with unfinished merge queue produces an actionable main-agent handoff", () => {
  const handoff = createManualIntegrationHandoff({
    resumeIntentId: "intent-ended-child",
    sourceRunId: "run-ended-child",
    workspaceId: "workspace-ended-child",
    queueItemId: "queue-ended-child",
  });
  assert.equal(handoff.customType, "subagent-integration-handoff");
  assert.match(handoff.content, /不会自动恢复/);
  assert.match(handoff.content, /主 Agent/);
  assert.match(handoff.content, /接管 worktree/);
  assert.deepEqual(handoff.details, {
    resumeIntentId: "intent-ended-child",
    sourceRunId: "run-ended-child",
    workspaceId: "workspace-ended-child",
    queueItemId: "queue-ended-child",
  });
});
