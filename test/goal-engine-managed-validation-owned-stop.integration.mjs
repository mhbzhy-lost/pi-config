import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { stopOwnedManagedValidation } from "../scripts/lib/goal-engine/managed-validation.mjs";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const process = { pid: 17, pidBirthIdentity: "a".repeat(64), processGroupId: 17, processIdentityHash: hash({ pid: 17, pidBirthIdentity: "a".repeat(64), processGroupId: 17 }) };
const request = { stateRoot: "/state", goalId: "goal", runId: "run", conditionId: "condition", allocationId: "allocation", processIdentityHash: process.processIdentityHash, executionRevision: 1, executionContractHash: hash("contract"), baseHead: "2".repeat(40) };
const terminal = { status: "passed", code: 0, signal: null, output: "ok", outputBytes: 2, truncated: false, terminal: true, pid: 17, pidBirthIdentity: "a".repeat(64), processGroupTerminalProof: "b".repeat(64), workspaceClean: true };

test("stopOwnedManagedValidation leaves unknown identity untouched and returns attention", async () => {
  let calls = 0;
  const result = await stopOwnedManagedValidation(request, { readReceipt() { return { process: { ...process, processIdentityHash: "c".repeat(64) } }; }, recover() { calls++; }, preserveWorkspace() { calls++; }, preserveResource() { calls++; } });
  assert.deepEqual(result, { state: "attention", code: "OWNED_STOP_IDENTITY_UNKNOWN" });
  assert.equal(calls, 0);
});

test("stopOwnedManagedValidation recovers exact owner then durably preserves once", async () => {
  let kills = 0, writes = 0, closure = null;
  const services = {
    readReceipt() { return { process, terminal: null }; },
    async recover() { kills++; return { terminal }; },
    async preserveWorkspace() { return { proofHash: hash("workspace") }; },
    async preserveResource() { return { proofHash: hash("resource") }; },
    async writeClosure(value) { writes++; closure = value; if (writes === 1) throw Error("durable then throw"); return value; },
    readClosure() { return closure; },
  };
  await assert.rejects(() => stopOwnedManagedValidation(request, services), /durable then throw/);
  const result = await stopOwnedManagedValidation(request, services);
  assert.deepEqual(result, { state: "observed", terminalProofHash: hash(terminal), resourceProofHash: hash("resource"), resourceState: "quarantined", debt: true });
  assert.equal(kills, 1);
});

// RED: production must use the typed managed-worktree authority, never the retired
// high-level preserveWorkspace/preserveResource test doubles.
test("stopOwnedManagedValidation preserves the exact managed worktree receipt through typed authorities", async () => {
  const ownerToken = `worktree-owner.v1:${"a".repeat(64)}`;
  const workspaceReceipt = { id: "validation-lease", ownerKind: "goal-validation", ownerId: "run", ownerToken, originRoot: "/origin", headCommit: "2".repeat(40), state: "preserved", disposition: { state: "preserved", reason: "Goal quarantine after owned validation stop" } };
  const record = { id: "managed-receipt", process, workspaceLease: workspaceReceipt, terminal: null };
  const calls = [];
  const result = await stopOwnedManagedValidation(request, {
    readReceipt() { return record; },
    async recover() { calls.push("recover"); return { terminal }; },
    async preserveManagedWorktree(binding) { calls.push(["preserve", binding]); assert.deepEqual(binding, { originRoot: workspaceReceipt.originRoot, id: workspaceReceipt.id, ownerToken: workspaceReceipt.ownerToken, reason: "Goal quarantine after owned validation stop" }); return workspaceReceipt; },
    async markValidationLeaseDebt(value) { calls.push(["debt", value]); return { ...value, state: "cleanup-debt" }; },
    async writeRecord(value) { calls.push(["record", value]); return { ...value, phase: "cleanup_debt", cleanupDebt: true, terminal }; },
    readClosure() { return null; },
  });
  assert.deepEqual(result, { state: "observed", terminalProofHash: hash(terminal), resourceProofHash: hash({ receiptId: record.id, terminal, workspaceReceipt, debt: true }), resourceState: "quarantined", debt: true });
  assert.deepEqual(calls.map((value) => Array.isArray(value) ? value[0] : value), ["recover", "preserve", "debt", "record"]);
});

test("stopOwnedManagedValidation durable typed preservation retries from closure without another recovery", async () => {
  const ownerToken = `worktree-owner.v1:${"a".repeat(64)}`, workspaceReceipt = { id: "validation-lease", ownerKind: "goal-validation", ownerId: "run", ownerToken, originRoot: "/origin", headCommit: "2".repeat(40), state: "preserved", disposition: { state: "preserved", reason: "Goal quarantine after owned validation stop" } }, record = { id: "managed-receipt", process, workspaceLease: workspaceReceipt, terminal: null };
  let closure = null, recoveries = 0, preserves = 0, debts = 0, records = 0;
  const services = {
    readReceipt() { return record; }, readClosure() { return closure; },
    async recover() { recoveries++; return { terminal }; },
    async preserveManagedWorktree() { preserves++; return workspaceReceipt; },
    async markValidationLeaseDebt() { debts++; },
    async writeRecord() { records++; closure = { terminalProofHash: hash(terminal), resourceProofHash: hash({ receiptId: record.id, terminal, workspaceReceipt, debt: true }) }; throw Error("durable typed record then throw"); },
  };
  await assert.rejects(() => stopOwnedManagedValidation(request, services), /durable typed record then throw/);
  const result = await stopOwnedManagedValidation(request, services);
  assert.equal(result.state, "observed"); assert.equal(recoveries, 1); assert.equal(preserves, 1); assert.equal(debts, 1); assert.equal(records, 1);
});
