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
