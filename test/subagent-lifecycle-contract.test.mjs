import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "../packages/pi-subagents-enhanced/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url, { moduleCache: false });
let identity;
try { identity = await jiti.import("../packages/pi-subagents-enhanced/src/subagent-dispatch/lifecycle-identity.ts"); }
catch { assert.fail("lifecycle identity contract is not implemented"); }
const { createLifecycleIdentityV1, parseLifecycleIdentityV1, classifyRecoveryEligibility } = identity;

const base = {
  sourceRunId: "run-source", resumedRunId: "run-resumed",
  sourceAsyncDir: "/tmp/async/source", resumedAsyncDir: "/tmp/async/resumed",
  sessionId: "session-binding", sessionFile: "/tmp/sessions/session.jsonl",
  processBirth: { pid: 42, startedAt: 1700000000000 }, processIncarnationId: "inc-1",
  lifecycleSessionId: "life-1", ownerGeneration: 3,
};
const provenance = Object.fromEntries(Object.keys(base).map((field) => [field, {
  source: field === "ownerGeneration" ? "root-receipt" : "poc-observation", capturedAt: "2026-09-20T00:00:00.000Z", persistenceState: "persisted"
}]));

 test("identity 保留 source/resumed 双轨及字段 provenance，并可 JSON 往返", () => {
  const value = createLifecycleIdentityV1({ ...base, provenance });
  assert.equal(value.sourceRunId, "run-source"); assert.equal(value.resumedRunId, "run-resumed");
  assert.equal(value.sourceAsyncDir, "/tmp/async/source"); assert.equal(value.resumedAsyncDir, "/tmp/async/resumed");
  assert.equal(value.processIncarnationId, "inc-1"); assert.equal(value.lifecycleSessionId, "life-1");
  assert.equal(value.provenance.sourceRunId.source, "poc-observation");
  assert.deepEqual(parseLifecycleIdentityV1(JSON.parse(JSON.stringify(value))), value);
 });

test("identity fail-closed：交换 source/resumed、缺 process birth、不可证明 sessionFile", () => {
  assert.throws(() => createLifecycleIdentityV1({ ...base, sourceRunId: base.resumedRunId, provenance }), TypeError);
  assert.throws(() => createLifecycleIdentityV1({ ...base, processBirth: undefined, provenance }), TypeError);
  assert.throws(() => createLifecycleIdentityV1({ ...base, sessionFile: "relative", provenance }), TypeError);
});

test("recovery eligibility 对 no-session/external/incomplete/header mismatch fail closed", () => {
  assert.equal(classifyRecoveryEligibility({ sessionFile: "/tmp/s.jsonl", header: { sourceRunId: "a", sessionId: "s", agentProfile: "x", cwd: "/tmp", result: "ok", status: "done", recoveryDescriptor: "r" }, provenance: { sourceRunId: "a" } }).status, "eligible");
  for (const meta of [{}, { externalCli: true }, { sessionFile: "/tmp/s.jsonl" }, { sessionFile: "/tmp/s.jsonl", header: { sourceRunId: "a" }, provenance: { sourceRunId: "b" } }]) assert.equal(classifyRecoveryEligibility(meta).status, "blocked-unknown");
});

test("方案 A stop/drain 与显式 continuation 的 identity 边界", () => {
  assert.equal(identity.resolveGracefulShutdownPolicy({ decision: "A" }).action, "stop-drain");
  assert.equal(identity.continueSession({ identity: createLifecycleIdentityV1({ ...base, provenance }), explicit: true }).newProcessIncarnation, true);
  assert.throws(() => identity.continueSession({ identity: createLifecycleIdentityV1({ ...base, provenance }), explicit: false }), TypeError);
});
