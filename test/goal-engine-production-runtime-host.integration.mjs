import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, linkSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createGoalEngineEntry } from "../pi/extensions/goal-engine.ts";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const canonicalHash = (value) => hash(JSON.stringify(canonical(value)));

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
function exact(keys, value) { assert.deepEqual(Object.keys(value).sort(), [...keys].sort()); }
function workspaceRequest(overrides = {}) {
  return { stateRoot: "/state", goalId: "goal", taskId: "task", attempt: 1, runId: "run", leaseId: hash("owner-token"), workspacePath: "/workspace", headAtDispatch: "dispatch-head", baseHead: "base-head", executionRevision: 1, contractHash: hash("contract"), sessionId: "session", ...overrides };
}

// The production entry contract is intentionally RED until the real Host is wired.
test("enabled entry default factory constructs Host and passes production options", async () => {
  const calls = [];
  await createGoalEngineEntry(pi(), { settingsPath: enabledSettings(), async load() { return { createGoalEngineExtension(target, options) { calls.push({ target, options }); } }; } });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].options.runtimeHost);
  assert.equal(calls[0].options.runtimeHostOptions?.settingsPath, undefined);
});

test("enabled entry factory receives target and options", async () => {
  const target = pi(), seen = [];
  await createGoalEngineEntry(target, { settingsPath: enabledSettings(), runtimeHostFactory(...args) { seen.push(args); return Object.freeze({}); }, async load() { return { createGoalEngineExtension() {} }; } });
  assert.equal(seen.length, 1); assert.equal(seen[0][0], target); assert.equal(typeof seen[0][1], "object");
});

test("disabled entry does not dynamic import or construct Host", async () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-engine-disabled-")), settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ goalEngine: { enabled: false } }));
  let loadCalls = 0;
  await createGoalEngineEntry(pi(), { settingsPath, runtimeHostFactory() { throw Error("must not run"); }, async load() { loadCalls++; } });
  assert.equal(loadCalls, 0);
});

test("Host construction failure has load count zero", async () => {
  let loads = 0; const expected = Error("Host unavailable");
  await assert.rejects(createGoalEngineEntry(pi(), { settingsPath: enabledSettings(), runtimeHostFactory() { throw expected; }, async load() { loads++; } }), (error) => error === expected);
  assert.equal(loads, 0);
});

test("production Host exposes the complete frozen capability boundary", async () => {
  const h = await host({});
  const names = ["registries", "adapterRegistry", "captureCurrentWorld", "artifactRefForRun", "prepareManagedValidation", "startManagedValidation", "recoverManagedValidation", "inspectManagedValidation", "releaseManagedValidation", "stopOwnedRun", "quarantineWorkspace", "quarantineResource", "stopManagedValidation"];
  assert.deepEqual(Object.keys(h).sort(), names.sort());
  for (const name of names) if (name !== "registries" && name !== "adapterRegistry") assert.equal(typeof h[name], "function", name);
  for (const forbidden of ["projection", "git", "processProof", "nonce"]) assert.equal(forbidden in h, false);
});

test("captureCurrentWorld evaluates resource and run suppliers for every typed facade call", async () => {
  const seen = []; let resourceVersion = 0, runVersion = 0;
  const facade = { captureCurrentWorld(input) { seen.push(input); return { safe: true, repo: {}, adapters: [], environments: [], fixtures: [], resources: [], activeRuns: [] }; } };
  const h = await host({ facade, adapterRegistry: "adapters", environmentRegistry: "environments", fixtureRegistry: "fixtures", resourceRegistry: () => ({ version: ++resourceVersion }), runInventory: () => ({ version: ++runVersion }) });
  await h.captureCurrentWorld("/canonical/one"); await h.captureCurrentWorld("/canonical/two");
  assert.deepEqual(seen, [
    { repoRoot: "/canonical/one", adapterRegistry: "adapters", environmentRegistry: "environments", fixtureRegistry: "fixtures", resourceRegistry: { version: 1 }, runInventory: { version: 1 } },
    { repoRoot: "/canonical/two", adapterRegistry: "adapters", environmentRegistry: "environments", fixtureRegistry: "fixtures", resourceRegistry: { version: 2 }, runInventory: { version: 2 } },
  ]);
  assert.notDeepEqual(seen[0].runInventory, seen[1].runInventory);
});

test("captureCurrentWorld preserves an unsafe typed result", async () => {
  const unsafe = { safe: false, reason: "unsafe" };
  const h = await host({ facade: { captureCurrentWorld() { return unsafe; } } });
  assert.strictEqual(await h.captureCurrentWorld("/repo"), unsafe);
});

test("stopOwnedRun accepts only absolute asyncDir and exact Root Broker input", async () => {
  const seen = [], binding = { runId: "run-1", asyncDir: "/state/async", sessionId: "session-1" };
  const h = await host({ stopRootBrokerGoalOwnedRun(piValue, value) { seen.push([piValue, value]); return { state: "unknown" }; } });
  exact(["runId", "asyncDir", "sessionId"], binding); assert.deepEqual(await h.stopOwnedRun(binding), { state: "unknown" }); assert.deepEqual(seen[0][1], binding);
  for (const bad of [{ ...binding, extra: 1 }, { ...binding, asyncDir: "relative" }, { ...binding, runId: "" }]) await assert.rejects(() => h.stopOwnedRun(bad));
});

test("quarantineWorkspace preserves the inspected durable lease with canonical proof", async () => {
  const request = workspaceRequest(), inspection = { headCommit: "executor-head", path: "/workspace", clean: true };
  const ownerToken = "owner-token", seen = [];
  const lease = { goalId: "goal", taskId: "task", attempt: 1, stateRoot: "/state", path: "/workspace", baseCommit: "base-head", ownerToken };
  const h = await host({
    loadExecutorWorkspaceLease(input) { seen.push(["load", input]); return lease; },
    inspectExecutorWorkspace(input) { seen.push(["inspect", input]); return inspection; },
    releaseExecutorWorkspace(input, options) { seen.push(["release", input, options]); return { released: false, preserved: true, disposition: "preserved" }; },
  });
  const first = await h.quarantineWorkspace(request), second = await h.quarantineWorkspace(request);
  const material = { request, lease, inspection, disposition: "preserved" };
  assert.deepEqual(first, { taskId: "task", attempt: 1, proofHash: canonicalHash(material), state: "quarantined", disposition: "preserved" });
  assert.deepEqual(second, first);
  assert.deepEqual(seen.filter(([name]) => name === "release").map(([, input, options]) => [input, options]), [
    [lease, { disposition: "preserved", expectedExecutorHead: inspection.headCommit }],
    [lease, { disposition: "preserved", expectedExecutorHead: inspection.headCommit }],
  ]);
});

test("quarantineWorkspace rejects lease, inspection, and caller identity drift before release", async () => {
  const request = workspaceRequest();
  for (const [name, lease, inspection, drift] of [
    ["path", { path: "/other", baseCommit: "base-head", ownerToken: "owner-token" }, { path: "/workspace", headCommit: "executor-head", clean: true }, {}],
    ["baseCommit", { path: "/workspace", baseCommit: "other-base", ownerToken: "owner-token" }, { path: "/workspace", headCommit: "executor-head", clean: true }, {}],
    ["ownerToken", { path: "/workspace", baseCommit: "base-head", ownerToken: "other-owner" }, { path: "/workspace", headCommit: "executor-head", clean: true }, {}],
    ["head", { path: "/workspace", baseCommit: "base-head", ownerToken: "owner-token" }, { path: "/workspace", headCommit: "other-head", clean: true }, {}],
  ]) {
    let releases = 0;
    const h = await host({ loadExecutorWorkspaceLease() { return { ...lease, goalId: "goal", taskId: "task", attempt: 1, stateRoot: "/state" }; }, inspectExecutorWorkspace() { return inspection; }, releaseExecutorWorkspace() { releases++; } });
    await assert.rejects(() => h.quarantineWorkspace({ ...request, ...drift }), name); assert.equal(releases, 0, name);
  }
  const h = await host({}); await assert.rejects(() => h.quarantineWorkspace({ ...request, preserved: true }));
});

test("quarantineResource proves preservation through the owning Goal workspace lease", async () => {
  const request = { stateRoot: "/state", goalId: "goal", ownerKind: "executor", ownerId: "run", taskId: "task", attempt: 1, leaseId: hash("owner-token"), executionRevision: 1, contractHash: hash("contract"), sessionId: "session" };
  const lease = { goalId: "goal", taskId: "task", attempt: 1, stateRoot: "/state", path: "/workspace", baseCommit: "base-head", ownerToken: "owner-token" };
  const inspection = { headCommit: "executor-head", path: "/workspace", clean: true }, calls = [];
  const h = await host({ loadExecutorWorkspaceLease(value) { calls.push(["load", value]); return lease; }, inspectExecutorWorkspace(value) { calls.push(["inspect", value]); return inspection; }, releaseExecutorWorkspace(value, options) { calls.push(["release", value, options]); return { released: false, preserved: true, disposition: "preserved" }; } });
  const result = await h.quarantineResource(request);
  exact(["ownerId", "proofHash", "state", "debt"], result); assert.deepEqual(result, { ownerId: "run", proofHash: canonicalHash({ request, lease, inspection, disposition: "preserved" }), state: "quarantined", debt: true });
  assert.deepEqual(calls.at(-1), ["release", lease, { disposition: "preserved", expectedExecutorHead: inspection.headCommit }]);
});

test("stopManagedValidation delegates only typed owned stop and returns observed closure", async () => {
  const request = { stateRoot: "/state", goalId: "goal", runId: "run", conditionId: "condition", allocationId: "allocation", processIdentityHash: hash("process"), executionRevision: 1, executionContractHash: hash("contract"), baseHead: "base-head" };
  const calls = [];
  const h = await host({ facade: { stopOwnedManagedValidation(value) { calls.push(value); return { state: "observed", terminalProofHash: hash("terminal"), resourceProofHash: hash("resource"), resourceState: "quarantined", debt: true }; } } });
  assert.deepEqual(await h.stopManagedValidation(request), { state: "observed", terminalProofHash: hash("terminal"), resourceProofHash: hash("resource"), resourceState: "quarantined", debt: true });
  assert.deepEqual(calls, [request]);
});

test("stopManagedValidation mismatch or unavailable returns attention without pseudo recovery", async () => {
  const request = { stateRoot: "/state", goalId: "goal", runId: "run", conditionId: "condition", allocationId: "allocation", processIdentityHash: hash("process"), executionRevision: 1, executionContractHash: hash("contract"), baseHead: "base-head" };
  for (const facade of [{ stopOwnedManagedValidation() { throw Error("mismatch"); } }, {}]) {
    let pseudoCalls = 0;
    const h = await host({ facade: { ...facade, inspectManagedValidation() { pseudoCalls++; }, recoverManagedValidation() { pseudoCalls++; }, releaseManagedValidation() { pseudoCalls++; } } });
    assert.deepEqual(await h.stopManagedValidation(request), { state: "attention", code: "OWNED_STOP_IDENTITY_UNKNOWN" }); assert.equal(pseudoCalls, 0);
  }
});

test("artifactRefForRun creates a content-addressed secure regular artifact", async () => {
  const root = mkdtempSync(join(tmpdir(), "goal-artifact-")), request = { stateRoot: root, goalId: "goal", runId: "run", managedTerminal: { output: "terminal output" } };
  const h = await host({}), result = await h.artifactRefForRun(request), content = readFileSync(result.path);
  exact(["id", "path"], result); assert.equal(result.id, hash(content)); assert.equal(content.equals(Buffer.from(JSON.stringify(request.managedTerminal))), true);
  assert.equal(resolve(result.path).startsWith(`${resolve(root)}/`), true); assert.equal(lstatSync(result.path).isFile(), true); assert.equal(lstatSync(result.path).isSymbolicLink(), false); assert.equal(lstatSync(result.path).nlink, 1); assert.equal(lstatSync(result.path).mode & 0o777, 0o600); assert.equal(lstatSync(resolve(root)).mode & 0o777, 0o700);
  assert.deepEqual(await h.artifactRefForRun(request), result);
});

test("artifactRefForRun rejects unsafe target entries and noncanonical caller fields", async () => {
  const root = mkdtempSync(join(tmpdir(), "goal-artifact-unsafe-")), request = { stateRoot: root, goalId: "goal", runId: "run", managedTerminal: { output: "terminal output" } };
  const artifactDir = join(root, "artifacts"); mkdirSync(artifactDir, { recursive: true }); chmodSync(artifactDir, 0o700);
  const target = join(artifactDir, hash(Buffer.from(JSON.stringify(request.managedTerminal))));
  for (const unsafe of [() => symlinkSync("/tmp", target), () => { writeFileSync(join(root, "source"), "x", { mode: 0o600 }); linkSync(join(root, "source"), target); }]) {
    unsafe(); const h = await host({}); await assert.rejects(() => h.artifactRefForRun(request)); rmSync(target);
  }
  const h = await host({}); for (const bad of [{ ...request, path: "/tmp/raw" }, { ...request, id: "caller" }, { ...request, extra: true }]) await assert.rejects(() => h.artifactRefForRun(bad));
});

test("production Host exposes imported managed facades, never empty placeholders", async () => {
  const facade = { startManagedValidation() { return "started"; } }, h = await host({ facade });
  assert.equal(h.startManagedValidation, facade.startManagedValidation); assert.notEqual(h.startManagedValidation, undefined); assert.equal("processProof" in h, false);
});
