import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, linkSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { createGoalEngineEntry } from "../pi/extensions/goal-engine.ts";
import { createGoalEngineExtension } from "../src/goal-engine/extension.ts";
import { loadProjection } from "../src/goal-engine/store.ts";
import { allocateGoalWorkspaceFixture as allocateExecutorWorkspace, inspectGoalWorkspaceFixture as inspectExecutorWorkspace, loadGoalWorkspaceFixture as loadExecutorWorkspaceLease, releaseGoalWorkspaceFixture as releaseExecutorWorkspace } from "./helpers/goal-workspace-service-fixture.mjs";
import { runtimeInit, runtimeRegistries } from "./helpers/goal-runtime-fixtures.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const DISPATCH_HEAD = "1111111111111111111111111111111111111111";
const BASE_HEAD = "2222222222222222222222222222222222222222";
const EXECUTOR_HEAD = "3333333333333333333333333333333333333333";
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
  const { createProductionGoalRuntimeHost } = await import("../src/goal-engine/production-runtime-host.ts");
  return createProductionGoalRuntimeHost(pi(), options);
}
function exact(keys, value) { assert.deepEqual(Object.keys(value).sort(), [...keys].sort()); }
function workspaceRequest(overrides = {}) {
  return { stateRoot: "/state", goalId: "goal", taskId: "task", attempt: 1, runId: "run", leaseId: hash("owner-token"), workspacePath: "/workspace", headAtDispatch: DISPATCH_HEAD, baseHead: BASE_HEAD, executionRevision: 1, contractHash: hash("contract"), sessionId: "session", ...overrides };
}
function publicLease({ goalId = "goal", taskId = "task", attempt = 1, executionRevision = 1, stateRoot = "/state", workspaceId = "workspace", leaseId = hash("public-owner-digest"), path = "/workspace", baseCommit = DISPATCH_HEAD, state = "active" } = {}) {
  return {
    schemaVersion: "managed-workspace.v1", workspaceId, leaseId,
    owner: { kind: "goal-task", rootSessionId: "fixture-root", goalId, taskId, attempt, executionRevision },
    originRoot: "/origin", requestedCwd: "/origin", originRef: "refs/heads/main", baseCommit,
    path, dispatchCwd: path, branchRef: "refs/heads/managed", state, run: null,
    disposition: state === "preserved" ? { action: "preserve", reason: "Goal quarantine after owned executor stop" } : null,
    cleanupDebt: null,
  };
}
function publicPreserved(options = {}) {
  return publicLease({ ...options, state: "preserved" });
}

test("enabled entry without runtimeHost keeps task-only extension loadable without empty runtime authority", async () => {
  const calls = [];
  await createGoalEngineEntry(pi(), { settingsPath: enabledSettings(), async load() { return { createGoalEngineExtension(target, options) { calls.push({ target, options }); } }; } });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options, {});
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

test("captureCurrentWorld synchronously accepts exact cwd input and refreshes Host-owned suppliers", async () => {
  const seen = []; let resourceVersion = 0, runVersion = 0;
  const facade = { captureCurrentWorld(input) { seen.push(input); return { safe: true, repo: {}, adapters: [], environments: [], fixtures: [], resources: [], activeRuns: [] }; } };
  const h = await host({ facade, adapterRegistry: "adapters", environmentRegistry: "environments", fixtureRegistry: "fixtures", resourceRegistry: () => ({ [`resource-${++resourceVersion}`]: { capacity: 1, holders: [] } }), runInventory: () => [{ runId: `run-${++runVersion}`, kind: "managed-validation", state: "running" }] });
  const first = h.captureCurrentWorld({ cwd: "/canonical/one" }), second = h.captureCurrentWorld({ cwd: "/canonical/two" });
  assert.equal(typeof first?.then, "undefined"); assert.equal(typeof second?.then, "undefined");
  assert.deepEqual(seen, [
    { repoRoot: "/canonical/one", adapterRegistry: "adapters", environmentRegistry: "environments", fixtureRegistry: "fixtures", resourceRegistry: { "resource-1": { capacity: 1, holders: [] } }, runInventory: [{ runId: "run-1", kind: "managed-validation", state: "running" }] },
    { repoRoot: "/canonical/two", adapterRegistry: "adapters", environmentRegistry: "environments", fixtureRegistry: "fixtures", resourceRegistry: { "resource-2": { capacity: 1, holders: [] } }, runInventory: [{ runId: "run-2", kind: "managed-validation", state: "running" }] },
  ]);
  assert.notDeepEqual(seen[0].runInventory, seen[1].runInventory);
  for (const bad of ["/canonical/string", { cwd: "/canonical/extra", extra: true }, {}, { cwd: "relative" }, { cwd: "" }]) assert.throws(() => h.captureCurrentWorld(bad));
});

test("captureCurrentWorld preserves an unsafe typed result", async () => {
  const unsafe = { safe: false, reason: "unsafe" };
  const h = await host({ facade: { captureCurrentWorld() { return unsafe; } } });
  assert.strictEqual(h.captureCurrentWorld({ cwd: "/repo" }), unsafe);
});

test("production Host canary persists runtime draft and readiness through the real Extension", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "goal-engine-production-canary-"));
  execFileSync("git", ["init", "-b", "main"], { cwd }); execFileSync("git", ["config", "user.email", "test@example.com"], { cwd }); execFileSync("git", ["config", "user.name", "Test"], { cwd });
  writeFileSync(join(cwd, ".gitignore"), ".state/goal-engine/\n"); execFileSync("git", ["add", ".gitignore"], { cwd }); execFileSync("git", ["commit", "-m", "init"], { cwd });
  const calls = [], tools = [], sessionManager = { getSessionId: () => "canary", getSessionFile: () => join(cwd, "session"), getLeafId: () => "leaf", getBranch: () => [], getEntries: () => [] };
  const api = { registerTool: tool => tools.push(tool), on() {}, appendEntry() {}, sessionManager };
  const runtimeHost = await host({
    facade: { captureCurrentWorld(input) { calls.push(input); return { safe: true, repo: { root: cwd, head: execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim(), trackedDirty: [], untracked: [], sequencer: null }, adapters: [], environments: [], fixtures: [], resources: [], activeRuns: [], capturedAt: new Date().toISOString() }; } },
    registries: runtimeRegistries, adapterRegistry: Object.freeze({ oracle: Object.freeze({ deterministic: true }) }),
  });
  createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost });
  const result = JSON.parse((await tools.find(tool => tool.name === "goal_init").execute("call", runtimeInit(), undefined, undefined, { cwd, sessionManager })).details.value);
  assert.deepEqual(calls.map(call => call.repoRoot), [cwd]); assert.deepEqual(calls[0], { repoRoot: cwd, adapterRegistry: runtimeHost.adapterRegistry, environmentRegistry: {}, fixtureRegistry: {}, resourceRegistry: {}, runInventory: [] }); assert.equal(result.runtimeState, "awaiting_user_approval");
  const projection = loadProjection(join(cwd, ".state/goal-engine"), result.goalId);
  assert.equal(projection.runtimeState, "awaiting_user_approval"); assert.equal(projection.readiness, "ready");
});

test("stopOwnedRun accepts only complete Store-derived exact Root Broker authority", async () => {
  const seen = [], binding = { goalId: "goal-1", taskId: "task-1", attempt: 1, runId: "run-1", asyncDir: "/state/async", workspacePath: "/state/workspace", leaseId: hash("lease"), sessionId: "session-1", baseHead: BASE_HEAD, headAtDispatch: DISPATCH_HEAD, executionRevision: 1, contractHash: hash("contract"), agent: "executor" };
  const h = await host({ stopRootBrokerGoalOwnedRun(piValue, value) { seen.push([piValue, value]); return { state: "unknown" }; } });
  exact(["goalId", "taskId", "attempt", "runId", "asyncDir", "workspacePath", "leaseId", "sessionId", "baseHead", "headAtDispatch", "executionRevision", "contractHash", "agent"], binding); assert.deepEqual(await h.stopOwnedRun(binding), { state: "unknown" }); assert.deepEqual(seen[0][1], binding);
  for (const bad of [{ runId: binding.runId, asyncDir: binding.asyncDir, sessionId: binding.sessionId }, { ...binding, extra: 1 }, { ...binding, asyncDir: "relative" }, { ...binding, runId: "" }, { ...binding, agent: "reviewer" }]) await assert.rejects(() => h.stopOwnedRun(bad));
});

test("quarantineWorkspace consumes a real public managed receipt without ownerToken", async () => {
  const lease = publicLease(), request = workspaceRequest({ leaseId: lease.leaseId }), inspection = { headCommit: EXECUTOR_HEAD, path: "/workspace", clean: true }, seen = [];
  assert.equal(Object.hasOwn(lease, "ownerToken"), false);
  const h = await host({
    loadExecutorWorkspaceLease(input) { seen.push(["load", input]); return lease; },
    inspectExecutorWorkspace(input) { seen.push(["inspect", input]); return inspection; },
    releaseExecutorWorkspace(input, options) { seen.push(["release", input, options]); return publicPreserved(); },
  });
  const result = await h.quarantineWorkspace(request);
  assert.deepEqual(result, { taskId: "task", attempt: 1, proofHash: canonicalHash({ request, receipt: publicPreserved() }), state: "quarantined", disposition: "preserved" });
  assert.deepEqual(seen.filter(([name]) => name === "release").map(([, input, options]) => [input, options]), [[lease, { disposition: "preserved", expectedExecutorHead: inspection.headCommit }]]);
  assert.equal(JSON.stringify(result).includes("ownerToken"), false);
});

test("quarantineWorkspace fails closed for public receipt identity, digest, path, or HEAD drift", async () => {
  const lease = publicLease(), request = workspaceRequest({ leaseId: lease.leaseId }), inspection = { headCommit: EXECUTOR_HEAD, path: "/workspace", clean: true };
  for (const [name, supplied, observed, released] of [
    ["owner", publicLease({ taskId: "other" }), inspection, publicPreserved()],
    ["digest", publicLease({ leaseId: hash("other") }), inspection, publicPreserved()],
    ["path", publicLease({ path: "/other" }), inspection, publicPreserved()],
    ["base", publicLease({ baseCommit: BASE_HEAD }), inspection, publicPreserved()],
    ["head", lease, { path: "/workspace", clean: true }, publicPreserved()],
    ["preserved-owner", lease, inspection, publicPreserved({ taskId: "other" })],
    ["preserved-digest", lease, inspection, publicPreserved({ leaseId: hash("other") })],
    ["preserved-path", lease, inspection, publicPreserved({ path: "/other" })],
    ["preserved-state", lease, inspection, publicLease()],
  ]) {
    let releases = 0;
    const h = await host({ loadExecutorWorkspaceLease() { return supplied; }, inspectExecutorWorkspace() { return observed; }, releaseExecutorWorkspace() { releases++; return released; } });
    await assert.rejects(() => h.quarantineWorkspace(request), name);
    if (["owner", "digest", "path", "base", "head"].includes(name)) assert.equal(releases, 0, name);
  }
});

test("quarantineResource re-verifies the public owner digest and identity", async () => {
  const lease = publicLease({ baseCommit: BASE_HEAD }), request = { stateRoot: "/state", goalId: "goal", ownerKind: "executor", ownerId: "run", taskId: "task", attempt: 1, leaseId: lease.leaseId, executionRevision: 1, contractHash: hash("contract"), sessionId: "session" };
  const inspection = { headCommit: EXECUTOR_HEAD, path: "/workspace", clean: true };
  const h = await host({ loadExecutorWorkspaceLease() { return lease; }, inspectExecutorWorkspace() { return inspection; }, releaseExecutorWorkspace() { return publicPreserved({ baseCommit: BASE_HEAD }); } });
  assert.deepEqual(await h.quarantineResource(request), { ownerId: "run", proofHash: canonicalHash({ request, receipt: publicPreserved({ baseCommit: BASE_HEAD }) }), state: "quarantined", debt: true });
});

test("Host restart re-reads the real public managed receipt before resource quarantine", async () => {
  const origin = mkdtempSync(join(tmpdir(), "goal-engine-host-restart-origin-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "goal-engine-host-restart-state-"));
  let lease;
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd: origin });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: origin });
    execFileSync("git", ["config", "user.name", "Host Restart"], { cwd: origin });
    writeFileSync(join(origin, "README.md"), "fixture\n");
    execFileSync("git", ["add", "README.md"], { cwd: origin }); execFileSync("git", ["commit", "-m", "fixture"], { cwd: origin });
    chmodSync(stateRoot, 0o700);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: origin, encoding: "utf8" }).trim();
    lease = allocateExecutorWorkspace({ goalId: "goal", taskId: "task", attempt: 1, originRoot: origin, stateRoot, baseCommit: head });
    exact(["schemaVersion", "workspaceId", "leaseId", "owner", "originRoot", "requestedCwd", "originRef", "baseCommit", "path", "dispatchCwd", "branchRef", "state", "run", "disposition", "cleanupDebt"], lease);
    assert.equal(Object.hasOwn(lease, "ownerToken"), false, "fixture returns the canonical public receipt");
    assert.deepEqual({ owner: lease.owner, leaseId: lease.leaseId, path: lease.path, baseCommit: lease.baseCommit, state: lease.state }, { owner: { kind: "goal-task", rootSessionId: "fixture-root", goalId: "goal", taskId: "task", attempt: 1, executionRevision: 1 }, leaseId: lease.leaseId, path: lease.path, baseCommit: head, state: "active" });
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: origin, encoding: "utf8" }), "", "fixture allocation must leave the origin clean");
    const request = workspaceRequest({ stateRoot, workspacePath: lease.path, headAtDispatch: head, baseHead: head, leaseId: lease.leaseId });
    const resourceRequest = { stateRoot, goalId: "goal", ownerKind: "executor", ownerId: "run", taskId: "task", attempt: 1, leaseId: lease.leaseId, executionRevision: 1, contractHash: hash("contract"), sessionId: "session" };

    const adapters = { loadExecutorWorkspaceLease, inspectExecutorWorkspace, releaseExecutorWorkspace };
    const hostA = await host(adapters);
    assert.equal((await hostA.quarantineWorkspace(request)).disposition, "preserved");
    const hostB = await host(adapters);
    assert.equal((await hostB.quarantineResource(resourceRequest)).state, "quarantined");
    const reloaded = loadExecutorWorkspaceLease({ goalId: "goal", taskId: "task", attempt: 1, stateRoot });
    assert.equal(Object.hasOwn(reloaded, "ownerToken"), false);
    assert.deepEqual({ owner: reloaded.owner, leaseId: reloaded.leaseId, path: reloaded.path, baseCommit: reloaded.baseCommit, state: reloaded.state }, { owner: lease.owner, leaseId: lease.leaseId, path: lease.path, baseCommit: head, state: "preserved" });
    assert.equal(inspectExecutorWorkspace(reloaded).headCommit, head, "preservation must not destructively dispose the workspace");
  } finally {
    if (lease) try {
      const current = loadExecutorWorkspaceLease({ goalId: "goal", taskId: "task", attempt: 1, stateRoot });
      releaseExecutorWorkspace(current, { disposition: "discarded-cleanup" });
    } catch {}
    rmSync(origin, { recursive: true, force: true }); rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("stopManagedValidation delegates only typed owned stop and returns observed closure", async () => {
  const request = { stateRoot: "/state", goalId: "goal", runId: "run", conditionId: "condition", allocationId: "allocation", processIdentityHash: hash("process"), executionRevision: 1, executionContractHash: hash("contract"), baseHead: BASE_HEAD };
  const calls = [];
  const h = await host({ facade: { stopOwnedManagedValidation(value) { calls.push(value); return { state: "observed", terminalProofHash: hash("terminal"), resourceProofHash: hash("resource"), resourceState: "quarantined", debt: true }; } } });
  assert.deepEqual(await h.stopManagedValidation(request), { state: "observed", terminalProofHash: hash("terminal"), resourceProofHash: hash("resource"), resourceState: "quarantined", debt: true });
  assert.deepEqual(calls, [request]);
});

test("stopManagedValidation mismatch or unavailable returns attention without pseudo recovery", async () => {
  const request = { stateRoot: "/state", goalId: "goal", runId: "run", conditionId: "condition", allocationId: "allocation", processIdentityHash: hash("process"), executionRevision: 1, executionContractHash: hash("contract"), baseHead: BASE_HEAD };
  for (const facade of [{ stopOwnedManagedValidation() { throw Error("mismatch"); } }, {}]) {
    let pseudoCalls = 0;
    const h = await host({ facade: { ...facade, inspectManagedValidation() { pseudoCalls++; }, recoverManagedValidation() { pseudoCalls++; }, releaseManagedValidation() { pseudoCalls++; } } });
    assert.deepEqual(await h.stopManagedValidation(request), { state: "attention", code: "OWNED_STOP_IDENTITY_UNKNOWN" }); assert.equal(pseudoCalls, 0);
  }
});

test("artifactRefForRun creates a content-addressed secure regular artifact", async () => {
  const root = mkdtempSync(join(tmpdir(), "goal-artifact-")), output = "terminal output";
  const request = { stateRoot: root, goalId: "goal", runId: "run", managedTerminal: { status: "passed", code: 0, signal: null, output, outputBytes: Buffer.byteLength(output), truncated: false, terminal: true, pid: 17, pidBirthIdentity: "a".repeat(64), processGroupTerminalProof: "b".repeat(64), workspaceClean: true } };
  const h = await host({}), result = await h.artifactRefForRun(request), content = readFileSync(result.path);
  const artifactDir = join(root, "artifacts");
  exact(["id", "path"], result); assert.equal(result.id, hash(Buffer.from(output))); assert.equal(content.equals(Buffer.from(output)), true);
  assert.equal(resolve(result.path).startsWith(`${resolve(artifactDir)}/`), true); assert.equal(lstatSync(result.path).isFile(), true); assert.equal(lstatSync(result.path).isSymbolicLink(), false); assert.equal(lstatSync(result.path).nlink, 1); assert.equal(lstatSync(result.path).mode & 0o777, 0o600); assert.equal(lstatSync(artifactDir).mode & 0o777, 0o700);
  assert.deepEqual(await h.artifactRefForRun(request), result);
});

test("artifactRefForRun rejects unsafe target entries and noncanonical caller fields", async () => {
  const root = mkdtempSync(join(tmpdir(), "goal-artifact-unsafe-")), output = "terminal output", request = { stateRoot: root, goalId: "goal", runId: "run", managedTerminal: { status: "passed", code: 0, signal: null, output, outputBytes: Buffer.byteLength(output), truncated: false, terminal: true, pid: 17, pidBirthIdentity: "a".repeat(64), processGroupTerminalProof: "b".repeat(64), workspaceClean: true } };
  const artifactDir = join(root, "artifacts"); mkdirSync(artifactDir, { recursive: true }); chmodSync(artifactDir, 0o700);
  const target = join(artifactDir, hash(Buffer.from(output)));
  for (const unsafe of [() => symlinkSync("/tmp", target), () => { writeFileSync(join(root, "source"), "x", { mode: 0o600 }); linkSync(join(root, "source"), target); }]) {
    unsafe(); const h = await host({}); await assert.rejects(() => h.artifactRefForRun(request)); rmSync(target);
  }
  const h = await host({}); for (const bad of [{ ...request, path: "/tmp/raw" }, { ...request, id: "caller" }, { ...request, extra: true }]) await assert.rejects(() => h.artifactRefForRun(bad));
});

test("production Host exposes imported managed facades, never empty placeholders", async () => {
  const facade = { startManagedValidation() { return "started"; } }, h = await host({ facade });
  assert.equal(h.startManagedValidation, facade.startManagedValidation); assert.notEqual(h.startManagedValidation, undefined); assert.equal("processProof" in h, false);
});
