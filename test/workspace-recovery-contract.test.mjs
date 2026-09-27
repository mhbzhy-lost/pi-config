import assert from "node:assert/strict";
import test from "node:test";

test("workspace recovery reference is public managed-workspace.v2 and fail closed", async () => {
  const { parseWorkspaceReference } = await import("../packages/pi-subagents-enhanced/src/subagent-dispatch/authority-contract.ts");
  const reference = { schemaVersion: "managed-workspace.v2", workspaceId: "workspace-1", leaseId: "lease-1", revision: 3, digest: "sha256:" + "b".repeat(64), reference: "sha256:" + "c".repeat(64) };
  assert.deepEqual(parseWorkspaceReference(reference), reference);
  assert.throws(() => parseWorkspaceReference({ ...reference, revision: undefined }), /revision/);
  assert.throws(() => parseWorkspaceReference({ ...reference, schemaVersion: "private-ledger.v1" }), /schemaVersion/);
});

test("heartbeat renewal contract only updates the three lease fields", async () => {
  const { parseRenewLeaseResponse } = await import("../packages/pi-subagents-enhanced/src/subagent-dispatch/authority-contract.ts");
  const response = parseRenewLeaseResponse({ leaseId: "lease-1", lastRenewedAt: 1000, expiresAt: 61000, renewalSequence: 2 });
  assert.deepEqual(Object.keys(response).sort(), ["expiresAt", "lastRenewedAt", "leaseId", "renewalSequence"].sort());
});
