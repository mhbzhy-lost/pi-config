import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createGoalEngineEntry } from "../pi/extensions/goal-engine.ts";

function enabledSettings() {
  const dir = mkdtempSync(join(tmpdir(), "goal-engine-production-host-"));
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ goalEngine: { enabled: true } }));
  return settingsPath;
}
function pi() { return { registerTool() {}, on() {} }; }
async function host(options = {}) {
  const { createProductionGoalRuntimeHost } = await import("../scripts/lib/goal-engine/production-runtime-host.mjs");
  return createProductionGoalRuntimeHost(pi(), options);
}
function exact(keys, value) {
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
}

// The production entry contract is intentionally RED until the real Host is wired.
test("enabled entry default factory constructs Host and passes production options", async () => {
  const calls = [];
  await createGoalEngineEntry(pi(), {
    settingsPath: enabledSettings(),
    async load() { return { createGoalEngineExtension(target, options) { calls.push({ target, options }); } }; },
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].options.runtimeHost);
  assert.equal(calls[0].options.runtimeHostOptions?.settingsPath, undefined);
});

test("enabled entry factory receives target and options", async () => {
  const target = pi();
  const seen = [];
  await createGoalEngineEntry(target, {
    settingsPath: enabledSettings(),
    runtimeHostFactory(...args) { seen.push(args); return Object.freeze({}); },
    async load() { return { createGoalEngineExtension() {} }; },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], target);
  assert.equal(typeof seen[0][1], "object");
});

test("disabled entry does not dynamic import or construct Host", async () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-engine-disabled-"));
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ goalEngine: { enabled: false } }));
  let loadCalls = 0;
  await createGoalEngineEntry(pi(), { settingsPath, runtimeHostFactory() { throw new Error("must not run"); }, async load() { loadCalls++; } });
  assert.equal(loadCalls, 0);
});

test("Host construction failure has load count zero", async () => {
  let loads = 0;
  const expected = new Error("Host unavailable");
  await assert.rejects(createGoalEngineEntry(pi(), { settingsPath: enabledSettings(), runtimeHostFactory() { throw expected; }, async load() { loads++; } }), (e) => e === expected);
  assert.equal(loads, 0);
});

test("production Host exposes the complete frozen capability boundary", async () => {
  const h = await host({});
  const names = ["registries", "adapterRegistry", "captureCurrentWorld", "artifactRefForRun", "prepareManagedValidation", "startManagedValidation", "recoverManagedValidation", "inspectManagedValidation", "releaseManagedValidation", "stopOwnedRun", "quarantineWorkspace", "quarantineResource", "stopManagedValidation"];
  assert.deepEqual(Object.keys(h).sort(), names.sort());
  for (const name of names) if (name !== "registries" && name !== "adapterRegistry") assert.equal(typeof h[name], "function", name);
  for (const forbidden of ["projection", "git", "processProof", "nonce"]) assert.equal(forbidden in h, false);
});

test("captureCurrentWorld passes the canonical typed dependency set on every call", async () => {
  const seen = [];
  const inventory = { repo: {}, adapters: [], environments: [], fixtures: [], resources: [], activeRuns: [] };
  const facade = { captureCurrentWorld(input) { seen.push(input); return { safe: true, ...inventory }; } };
  const h = await host({ facade, adapterRegistry: "adapters", environmentRegistry: "environments", fixtureRegistry: "fixtures", resourceRegistry: "resources", runInventory: "runs" });
  await h.captureCurrentWorld("/canonical/one");
  await h.captureCurrentWorld("/canonical/two");
  assert.deepEqual(seen, [
    { repoRoot: "/canonical/one", adapterRegistry: "adapters", environmentRegistry: "environments", fixtureRegistry: "fixtures", resourceRegistry: "resources", runInventory: "runs" },
    { repoRoot: "/canonical/two", adapterRegistry: "adapters", environmentRegistry: "environments", fixtureRegistry: "fixtures", resourceRegistry: "resources", runInventory: "runs" },
  ]);
});

test("captureCurrentWorld fail-closes while preserving unsafe result", async () => {
  const unsafe = { safe: false, reason: "unsafe" };
  const h = await host({ facade: { captureCurrentWorld() { return unsafe; } } });
  assert.strictEqual(await h.captureCurrentWorld("/repo"), unsafe);
});

test("stopOwnedRun accepts only absolute asyncDir and exact Root Broker input", async () => {
  const seen = [];
  const h = await host({ stopRootBrokerGoalOwnedRun(piValue, binding) { seen.push([piValue, binding]); return { state: "unknown" }; } });
  const binding = { runId: "run-1", asyncDir: "/state/async", sessionId: "session-1" };
  exact(["runId", "asyncDir", "sessionId"], binding);
  assert.deepEqual(await h.stopOwnedRun(binding), { state: "unknown" });
  assert.deepEqual(seen[0][1], binding);
  for (const bad of [{ ...binding, extra: 1 }, { ...binding, asyncDir: "relative" }, { ...binding, runId: "" }]) await assert.rejects(() => h.stopOwnedRun(bad));
});

test("unavailable or unknown owned run never invokes kill or process", async () => {
  let brokerCalls = 0;
  const h = await host({ stopRootBrokerGoalOwnedRun() { brokerCalls++; return { state: "unknown" }; } });
  assert.equal((await h.stopOwnedRun({ runId: "r", asyncDir: "/a", sessionId: "s" })).state, "unknown");
  assert.equal(brokerCalls, 1);
});

test("quarantineWorkspace binds exact identity and returns preserved disposition", async () => {
  const leaseId = createHash("sha256").update("owner-token").digest("hex");
  const request = { stateRoot: "/state", goalId: "goal", taskId: "task", attempt: 1, runId: "run", leaseId, workspacePath: "/workspace", head: "abc", revision: "rev", contract: "contract", sessionId: "session" };
  const seen = [];
  const h = await host({ loadExecutorWorkspaceLease(x) { seen.push(["load", x]); return { ownerToken: "owner-token", leaseId, path: "/workspace", head: "abc" }; }, inspectExecutorWorkspace(x) { seen.push(["inspect", x]); return { path: "/workspace", head: "abc", state: "active" }; }, releaseExecutorWorkspace(x) { seen.push(["release", x]); return { state: "quarantined" }; } });
  const result = await h.quarantineWorkspace(request);
  assert.deepEqual(result, { taskId: "task", attempt: 1, proofHash: result.proofHash, state: "quarantined", disposition: "preserved" });
  assert.equal(seen.at(-1)[0], "release");
});

test("quarantineWorkspace rejects identity drift before release and is idempotent", async () => {
  let releases = 0;
  const request = { stateRoot: "/state", goalId: "g", taskId: "t", attempt: 1, runId: "r", leaseId: "l", workspacePath: "/w", head: "expected", revision: "rev", contract: "c", sessionId: "s" };
  const h = await host({ loadExecutorWorkspaceLease() { return { ownerToken: "x" }; }, inspectExecutorWorkspace() { return { path: "/w", head: "drift", state: "active" }; }, releaseExecutorWorkspace() { releases++; } });
  await assert.rejects(() => h.quarantineWorkspace(request));
  assert.equal(releases, 0);
  await assert.rejects(() => h.quarantineWorkspace({ ...request, state: "preserved" }));
});

test("quarantineResource proves durable managed lease and returns debt", async () => {
  const seen = [];
  const h = await host({ inspectManagedResource(input) { seen.push(input); return { ownerId: "owner", state: "preserved", leaseId: "lease" }; } });
  const result = await h.quarantineResource({ stateRoot: "/state", resourceId: "resource", leaseId: "lease" });
  exact(["ownerId", "proofHash", "state", "debt"], result);
  assert.equal(result.state, "quarantined");
  assert.equal(result.debt, true);
  assert.equal(seen.length, 1);
});

test("stopManagedValidation exact-binds allocation and process identity", async () => {
  const calls = [];
  const request = { stateRoot: "/state", allocationId: "a", runId: "r", conditionId: "c", processIdentityHash: "p", revision: "rev", contract: "contract", baseHead: "head" };
  const h = await host({ inspectManagedValidation(x) { calls.push(["inspect", x]); return { terminal: true, processIdentityHash: "p", terminalProofHash: "tp", resourceProofHash: "rp" }; }, recoverManagedValidation() { calls.push(["recover"]); }, releaseManagedValidation() { calls.push(["release"]); } });
  const result = await h.stopManagedValidation(request);
  assert.equal(result.state, "quarantined");
  assert.equal(result.debt, true);
  assert.equal(calls[0][0], "inspect");
});

test("stopManagedValidation mismatch returns attention without recovery", async () => {
  let mutations = 0;
  const h = await host({ inspectManagedValidation() { return { processIdentityHash: "other" }; }, recoverManagedValidation() { mutations++; }, releaseManagedValidation() { mutations++; } });
  const result = await h.stopManagedValidation({ stateRoot: "/s", allocationId: "a", runId: "r", conditionId: "c", processIdentityHash: "p", revision: "v", contract: "c", baseHead: "h" });
  assert.equal(result.state, "unknown");
  assert.equal(result.attention, true);
  assert.equal(mutations, 0);
});

test("artifactRefForRun materializes only a Host-owned secure artifact", async () => {
  const root = mkdtempSync(join(tmpdir(), "goal-artifact-"));
  const h = await host({});
  const result = await h.artifactRefForRun({ stateRoot: root, goalId: "goal", runId: "run", managedTerminal: { output: "terminal output" } });
  exact(["id", "path"], result);
  assert.equal(resolve(result.path).startsWith(resolve(root) + "/"), true);
  const st = statSync(result.path);
  assert.equal(st.mode & 0o777, 0o600);
  assert.equal(st.nlink, 1);
  assert.equal(typeof result.id, "string");
});

test("artifactRefForRun rejects caller supplied path/id and is idempotent", async () => {
  const root = mkdtempSync(join(tmpdir(), "goal-artifact-idempotent-"));
  const h = await host({});
  const request = { stateRoot: root, goalId: "g", runId: "r", managedTerminal: { output: "same" } };
  const first = await h.artifactRefForRun(request);
  assert.deepEqual(await h.artifactRefForRun(request), first);
  await assert.rejects(() => h.artifactRefForRun({ ...request, path: "/tmp/raw" }));
});

test("production Host exposes imported managed facades, never empty placeholders", async () => {
  const facade = { startManagedValidation() { return "started"; } };
  const h = await host({ facade });
  assert.equal(h.startManagedValidation, facade.startManagedValidation);
  assert.notEqual(h.startManagedValidation, undefined);
  assert.equal("processProof" in h, false);
});

test("extension closure sends canonical stateRoot in workspace and managed requests", async () => {
  const requests = [];
  const target = { registerTool(name, spec) { if (spec?.execute) requests.push({ name, execute: spec.execute }); }, on() {} };
  await createGoalEngineEntry(target, { settingsPath: enabledSettings(), async load() { return { createGoalEngineExtension(piValue, options) { options.runtimeHost.suspend = async (input) => { requests.push(input); }; } }; } });
  assert.ok(requests.length > 0);
  for (const request of requests) if (request.kind === "workspace" || request.kind === "managed-validation") assert.equal(typeof request.stateRoot, "string");
});
