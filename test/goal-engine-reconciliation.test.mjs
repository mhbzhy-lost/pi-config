import assert from "node:assert/strict";
import test from "node:test";
import { buildExecutionAmendmentProposal, reconcileExecutionChange } from "../scripts/lib/goal-engine/reconciliation.mjs";
const hash = "a".repeat(64);
const projection = () => ({ goalId: "goal-1", executionRevision: 4, executionContractHash: hash, baseHead: "b".repeat(40), sessionId: "session-1", tasks: new Map([["accepted", { status: "accepted" }], ["pending", { status: "pending" }]]) });
test("amendment proposal is exact shape and hashes only permitted changes", () => {
 const proposal = buildExecutionAmendmentProposal({ projection: projection(), reason: "user request", changes: { tasks: [{ id: "pending", condition: "changed" }], budget: { max: 2 } } });
 assert.deepEqual(Object.keys(proposal).sort(), ["baseHead", "changes", "changesHash", "contractHash", "goalId", "proposalHash", "proposalId", "reason", "revision", "sessionId"].sort());
 assert.throws(() => buildExecutionAmendmentProposal({ projection: projection(), reason: "x", changes: { objective: "new" } }), /permitted/);
});
test("reconciliation changes applicability not accepted history and blocks active resources", () => {
 const proposal = buildExecutionAmendmentProposal({ projection: projection(), reason: "user request", changes: { tasks: [{ id: "pending", condition: "changed" }] } });
 const capability = { prefix: "goal-user-capability.v1", goalId: "goal-1", executionRevision: 4, proposalId: proposal.proposalId, proposalHash: proposal.proposalHash, sessionId: "session-1", userEntryId: "entry-1", nonce: "n", singleUse: true };
 const result = reconcileExecutionChange({ projection: projection(), proposal, capability, inventories: { activeRuns: [], workspaces: [], resources: [] } });
 assert.equal(result.actions.find((x) => x.taskId === "accepted").action, "keep"); assert.ok(result.actions.every((x) => ["keep", "supersede", "add", "reverify", "block_until_terminal"].includes(x.action)));
 assert.throws(() => reconcileExecutionChange({ projection: projection(), proposal, capability, inventories: { activeRuns: [{ runId: "run" }], workspaces: [], resources: [] } }), /terminal/);
});
