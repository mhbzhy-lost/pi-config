import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const retiredRpcClient = ["subagents", "rpc-client.mjs"].join("-");

async function missing(relative) {
  await assert.rejects(access(path.join(root, relative)));
}

test("legacy generic Executor runtime and its tests are absent", async () => {
  for (const relative of [
    "scripts/lib/runtime/spawn.mjs",
    "scripts/lib/runtime/monitor.mjs",
    "scripts/lib/runtime/control.mjs",
    "scripts/lib/runtime/stream.mjs",
    "scripts/lib/runtime/index.mjs",
    "test/plan-runtime-spawn.test.mjs",
    "test/plan-runtime-monitor.test.mjs",
    "test/plan-runtime-control.test.mjs",
  ]) await missing(relative);
});

test("Standalone Plan Host runtime and its test are absent", async () => {
  for (const relative of ["scripts/lib/plan/plan-host-runtime.mjs", "test/plan-host-runtime.test.mjs"]) await missing(relative);
});

test("retired Host parallel harness and RPC client pair are absent", async () => {
  for (const relative of [
    "test/plan-parallel-harness.integration.mjs",
    `scripts/lib/${retiredRpcClient}`,
    "test/subagents-rpc-client.test.mjs",
  ]) await missing(relative);
});

test("amendment Harness uses flat Root crash and revival control", async () => {
  const source = await readFile(path.join(root, "test/plan-amendment-harness.integration.mjs"), "utf8");
  assert.doesNotMatch(source, /plan-host-runtime|createPlanHostRuntime|PI_PLAN_HARNESS_STANDALONE|hostRunId/);
  assert.match(source, /pi\/extensions\/subagent-runtime\.ts/);
  assert.match(source, /pi\/extensions\/plan-launcher\.ts/);
  assert.match(source, /PI_PLAN_FLAT_AMENDMENT_CRASH/);
  assert.match(source, /logicalRunId/);
  assert.match(source, /executorRunId/);
  assert.match(source, /async function waitFor[^\n]*ENOENT/);
  assert.match(source, /attempt\.attemptId === dispatch\.data\.attemptId/);
  assert.match(source, /rev-list[^\n]*--count/);
  assert.match(source, /assertRuntimeClean/);
  assert.match(source, /runnerProcessInstanceId/);
  assert.match(source, /this\.child\.kill\("SIGKILL"\); await this\.exited/);
  assert.match(source, /terminateDetachedRunsUnder/);
  assert.match(source, /await terminateDetachedRunsUnder\(runtimeTmp\)/);
  assert.match(source, /processesReferencing/);
  assert.doesNotMatch(source, /assert\.deepEqual\(superseded\[0\]\.data\.evidence/);
  for (const field of ["kind", "dispatchId", "runId", "asyncDir", "artifactSha256"]) {
    assert.match(source, new RegExp(`superseded\\[0\\]\\.data\\.evidence\\.${field}`));
  }
  for (const field of ["description:", "thinking:", "temperature:"]) assert.match(source, new RegExp(field));
});

test("flat Harness preserves failure evidence and compensates detached runs", async () => {
  const source = await readFile(path.join(root, "test/plan-flat-runtime-harness.integration.mjs"), "utf8");
  for (const boundary of [
    "terminateDetachedRunsUnder",
    "processesReferencing",
    "finalizeHarnessCleanup",
    "removeFixtureWithEvidence",
    "waitForHarnessRunQuiescence",
  ]) assert.match(source, new RegExp(boundary));
  assert.match(source, /await waitForHarnessRunQuiescence\([\s\S]*?\);\s*await rpc\.close\(\)/);
  assert.match(source, /await terminateDetachedRunsUnder\(runtimeTmp\)/);
  assert.match(source, /passed\s*=\s*true/);
  assert.match(source, /brokerSocketPath\(rootSessionId\)/);
});

test("unused Parent lifecycle source and test are absent", async () => {
  for (const relative of ["scripts/lib/plan/parent-lifecycle.mjs", "test/parent-lifecycle.test.mjs"]) await missing(relative);
});

test("Launcher no longer retains Host implementation identifiers", async () => {
  const source = await readFile(path.join(root, "scripts/lib/plan/plan-launcher-extension.mjs"), "utf8");
  assert.doesNotMatch(source, /spawnPlanRunner|processIdentity|host-handle\.json|pi-plan-host-keeper/);
});

test("Plan runtime tools no longer retain Standalone Runner terminology", async () => {
  const source = await readFile(path.join(root, "scripts/lib/plan/plan-runtime-tools.mjs"), "utf8");
  assert.doesNotMatch(source, /Standalone Plan Runner/);
});

test("Widget only projects status and broker-owned Executor facts", async () => {
  const widget = await readFile(path.join(root, "scripts/lib/plan/tui/plan-widget.mjs"), "utf8");
  assert.match(widget, /status\.json/);
  assert.match(widget, /executorRuns/);
  assert.doesNotMatch(widget, /host-handle\.json|hostRunId|Host:/);
});

test("flat runtime architecture document states the seven architecture boundaries", async () => {
  const source = await readFile(path.join(root, "docs/architecture/plan-runner-flat-runtime.md"), "utf8");
  for (const boundary of [
    "领域拓扑: Main -> Plan Runner -> Executor",
    "runtime 拓扑: Root -> [Plan Runner, Executor]",
    "生命周期: Root session 单一 owner，其他 Root 不恢复",
    "dispatch: tool -> child adapter -> Root broker -> local pi-subagents RPC",
    "授权: dispatch event + one-shot contract hash",
    "Supervisor: broker ownership routing",
    "淘汰: Standalone Host、re-root、fanout-child、跨 Root attach",
  ]) assert.match(source, new RegExp(boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("capsule documentation no longer describes the retired Host topology", async () => {
  const source = await readFile(path.join(root, "docs/pi-plan-execution-capsule.md"), "utf8");
  assert.doesNotMatch(source, /thin Host|Standalone runner|host handle/i);
});

test("architecture audit preserves facts and appends its superseding decision", async () => {
  const source = await readFile(path.join(root, "docs/audits/2026-07-29-plan-runner-architecture-audit.md"), "utf8");
  assert.match(source, /`scripts\/lib\/plan\/plan-host-runtime\.mjs` 仍是当前 runtime。Host retirement、flat runtime 和确定性控制面替换是下一份计划，不应宣称已完成。/);
  assert.match(source, /\*\*\[运行时迁移\]\*\*：保留当前 Host，后续单独退役。/);
  assert.match(source, /^## Superseding Decision$/m);
});

test("Root broker is the only Plan process-control adapter", async () => {
  const sources = await Promise.all([
    readFile(path.join(root, "pi/extensions/subagent-runtime.ts"), "utf8"),
    readFile(path.join(root, "scripts/lib/plan/plan-launcher-extension.mjs"), "utf8"),
    readFile(path.join(root, "scripts/lib/plan/coordinator.mjs"), "utf8"),
    readFile(path.join(root, "scripts/lib/plan/plan-runner-dependencies.mjs"), "utf8"),
    readFile(path.join(root, "scripts/lib/plan/pi-subagents-execution-backend.mjs"), "utf8"),
  ]);
  assert.match(sources[0], /new RootBrokerServer\(/);
  assert.match(sources[1], /requireRootBroker\(/);
  for (const source of sources.slice(2)) assert.doesNotMatch(source, /spawnPlanRunner|processIdentity|host-handle\.json|createPlanHostRuntime/);
});

test("remaining fleet modules do not import the retired runtime directory", async () => {
  for (const relative of ["scripts/lib/tui/fleet-extension.mjs", "scripts/lib/tui/process-fleet-view.mjs"]) {
    const source = await readFile(path.join(root, relative), "utf8");
    assert.doesNotMatch(source, /lib\/runtime|\.\.\/runtime/);
  }
});
