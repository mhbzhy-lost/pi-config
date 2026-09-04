import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { RootBrokerServer } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts";
import { bindRootBroker, unbindRootBroker } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-registry.ts";
import { createProductionGoalRuntimeHost } from "../src/goal-engine/production-runtime-host.ts";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { loadProjection } from "../src/goal-engine/store.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const globalModules = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const piRoot = join(globalModules, "@earendil-works/pi-coding-agent");
const { createAgentSession, DefaultResourceLoader, SessionManager } = await import(pathToFileURL(join(piRoot, "dist/index.js")).href);
const toolNames = ["goal_accept", "goal_amend", "goal_dispatch", "goal_finalize", "goal_init", "goal_integrate", "goal_settle", "goal_status"];

function git(cwd, ...args) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
function runtimeInput() {
  return {
    objective: "真实 Pi Runtime PASS finalize canary",
    execution: {
      schema: "goal-runtime.v1",
      tasks: [],
      conditions: [{
        id: "pass-condition", role: "terminal", enforcement: "final",
        statement: "Managed validation emits PASS", observable: "managed validation JSON", expected: "PASS",
        depends_on: [], oracle_ref: "canary-oracle", environment_ref: "canary-local", fixture_refs: ["canary-fixture"],
        invalidation: { paths: [], task_ids: [] },
        remediation: { policy: "user-approved", allowed_paths: ["test/**"], max_attempts: 0 },
        stability: { mode: "single", require_fresh_environment: true },
      }],
      write_policy: { allowed_paths: ["test/**"] },
      budgets: { max_observations: 3, max_repairs: 1, max_elapsed_minutes: 5, max_no_progress: 20 },
    },
  };
}
function wrapperSource({ reviewLog }) {
  const production = pathToFileURL(join(repoRoot, "src/goal-engine/production-runtime-host.mjs")).href;
  const extension = pathToFileURL(join(repoRoot, "src/goal-engine/extension.mjs")).href;
  const options = {
    adapters: [{
      ref: "canary-oracle", version: "1", deterministic: true, reset: "clean", resourceClaims: [],
      artifactClassifier: { pass: "PASS", fail: "FAIL", inconclusive: "UNKNOWN", infrastructure_error: "INFRA" },
      validationPlan: { schema: "dispatch-ir.v1.validation-plan", limits: { timeoutMs: 5000, maxOutputBytes: 4096, terminationGraceMs: 100, maxConcurrentWorkspaces: 1 }, actions: [{ id: "pass-json", kind: "validation", executable: "/bin/echo", args: ["{\"code\":\"PASS\"}"] }] },
    }],
    environments: { "canary-local": { fingerprint: "canary-environment-v1", available: true } },
    fixtures: { "canary-fixture": { fingerprint: "canary-fixture-v1", available: true } },
    resources: {},
  };
  return `import { appendFileSync } from "node:fs";\nimport { createProductionGoalRuntimeHost } from ${JSON.stringify(production)};\nimport { createGoalEngineExtension } from ${JSON.stringify(extension)};\nconst options = ${JSON.stringify(options)};\nexport default function (pi) { createGoalEngineExtension(pi, { runtimeHost: createProductionGoalRuntimeHost(pi, options), finalReviewProvider: async (input) => { if (input.writerLockHeld !== false) throw Error("final review writer lock must be released"); appendFileSync(${JSON.stringify(reviewLog)}, "review\\n", { mode: 0o600 }); return { severity: "none", reportRef: "sha256:${"a".repeat(64)}" }; } }); }\n`;
}

function loader(cwd, agentDir, wrapper) {
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return new DefaultResourceLoader({ cwd, agentDir, additionalExtensionPaths: [wrapper], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
}
async function start(cwd, agentDir, wrapper, sessionManager) {
  const resourceLoader = loader(cwd, agentDir, wrapper);
  await resourceLoader.reload();
  const host = await createAgentSession({ cwd, agentDir, resourceLoader, sessionManager });
  await host.session.bindExtensions({ mode: "rpc", shutdownHandler() {}, onError(error) { throw error; } });
  host.cwd = cwd;
  return host;
}
async function execute(host, name, callId, params) {
  return host.session.getToolDefinition(name).execute(callId, params, new AbortController().signal, undefined, { cwd: host.cwd, sessionManager: host.session.sessionManager });
}
const value = async (...args) => JSON.parse((await execute(...args)).details.value);
const eventTypes = (root, goalId) => readFileSync(join(root, "goals", goalId, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse).map(event => event.type);

// This intentionally uses the globally installed SDK, a temporary wrapper Extension,
// and the production Host rather than the test-only Pi/Host doubles used elsewhere.
test("真实 Pi production Host PASS observation completes and finalizes without resource debt", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "goal-runtime-real-canary-")));
  const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "goal-runtime-real-agent-")));
  const reviewLog = join(agentDir, "final-review.log");
  const wrapper = join(agentDir, "goal-runtime-canary-wrapper.mjs");
  const inheritedAgentDir = process.env.PI_CODING_AGENT_DIR;
  const inheritedGoalDir = process.env.PI_CODING_GOAL_DIR;
  let host;
  try {
    git(cwd, "init", "-b", "main"); git(cwd, "config", "user.email", "canary@example.invalid"); git(cwd, "config", "user.name", "Runtime Canary");
    writeFileSync(join(cwd, ".gitignore"), ".state/\n"); git(cwd, "add", ".gitignore"); git(cwd, "commit", "-m", "test: 初始化 runtime canary 仓库");
    writeFileSync(wrapper, wrapperSource({ reviewLog }), { mode: 0o600 });
    mkdirSync(join(cwd, ".state/goal-engine"), { recursive: true, mode: 0o700 });
    chmodSync(join(cwd, ".state/goal-engine"), 0o700);
    delete process.env.PI_CODING_GOAL_DIR;
    host = await start(cwd, agentDir, wrapper, SessionManager.create(cwd, join(agentDir, "sessions")));
    assert.deepEqual(toolNames.map(name => host.session.getToolDefinition(name)?.name).sort(), toolNames);
    assert.equal(host.session.getToolDefinition("goal_observe"), undefined);

    const initialized = await value(host, "goal_init", "runtime-canary-init", runtimeInput());
    const goalId = initialized.goalId;
    const root = join(cwd, ".state/goal-engine");
    assert.equal(initialized.runtimeState, "awaiting_user_approval");
    await value(host, "goal_status", "runtime-canary-approval", { goal_id: goalId });
    await host.session.extensionRunner.emitInput("approve", undefined, "rpc");
    host.session.sessionManager.appendMessage({ role: "user", content: "approve" });
    const approved = await value(host, "goal_status", "runtime-canary-consume-approval", { goal_id: goalId });
    assert.equal(approved.runtimeState, "calibrating", JSON.stringify(approved));

    // Cycle 0: request, managed process/terminal, record, release, then activation.
    const cycle0 = [];
    for (let index = 0; index < 5; index++) cycle0.push(await value(host, "goal_status", `runtime-canary-cycle0-${index}`, { goal_id: goalId }));
    let projection = loadProjection(root, goalId);
    assert.equal(projection.runtimeState, "active", JSON.stringify({ cycle0, runs: [...projection.observationRuns.values()], condition: projection.conditions.get("pass-condition") }));
    assert.deepEqual([...projection.observationRuns.values()].map(run => [run.cycle, run.phase]), [[0, "released"]]);

    // Reload before completion; the same Goal continues without rerunning Cycle0.
    host.session.sessionManager.appendMessage({ role: "assistant", content: [], provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, stopReason: "stop" });
    const sessionFile = host.session.sessionManager.getSessionFile();
    const sessionDir = host.session.sessionManager.getSessionDir();
    host.session.dispose(); host = await start(cwd, agentDir, wrapper, SessionManager.open(sessionFile, sessionDir, cwd));
    // Product cycle: the real managed /bin/echo JSON PASS run is recorded and released.
    const cycle1 = [];
    for (let index = 0; index < 5; index++) cycle1.push(await value(host, "goal_status", `runtime-canary-cycle1-${index}`, { goal_id: goalId }));
    projection = loadProjection(root, goalId);
    assert.deepEqual([...projection.observationRuns.values()].map(run => [run.cycle, run.phase]), [[0, "released"], [1, "released"]]);
    assert.equal(projection.conditions.get("pass-condition").status, "satisfied");

    // Final intent is paired with an actual Pi input entry; approval does not suspend.
    await value(host, "goal_status", "runtime-canary-final-intent", { goal_id: goalId });
    await host.session.extensionRunner.emitInput("approve", undefined, "rpc");
    host.session.sessionManager.appendMessage({ role: "user", content: "approve" });
    const offered = await value(host, "goal_status", "runtime-canary-final-offer", { goal_id: goalId });
    assert.equal(offered.machineAction?.tool, "goal_finalize", JSON.stringify(offered));
    assert.equal(loadProjection(root, goalId).runtimeState, "active", "final approval must not suspend");
    await execute(host, "goal_finalize", "runtime-canary-finalize", { ...offered.machineAction.params, action_token: offered.action_token });

    projection = loadProjection(root, goalId);
    assert.equal(projection.lifecycle, "completed"); assert.equal(projection.completionVerdict, "COMPLETE");
    assert.equal(projection.finalReview.status, "recorded"); assert.equal(projection.completionHistory.length, 1);
    assert.equal(readFileSync(reviewLog, "utf8").trim().split("\n").length, 1);
    const types = eventTypes(root, goalId);
    for (const type of ["goal.final_review_started", "goal.final_review_recorded", "goal.completed"]) assert.equal(types.filter(value => value === type).length, 1, type);
    assert.equal([...projection.observationRuns.values()].every(run => run.phase === "released"), true);
    assert.equal([...projection.observationRuns.values()].some(run => run.phase === "cleanup_debt"), false);
    const review = join(root, "final-reviews", `${projection.finalReview.reviewId}.json`);
    assert.equal(lstatSync(review).mode & 0o777, 0o600);
  } finally {
    try { host?.session?.dispose(); } catch {}
    if (inheritedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = inheritedAgentDir;
    if (inheritedGoalDir === undefined) delete process.env.PI_CODING_GOAL_DIR; else process.env.PI_CODING_GOAL_DIR = inheritedGoalDir;
    rmSync(agentDir, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true });
  }
});

test("真实 production Host 在 Root Broker restart 后恢复 exact failed terminal proof", async () => {
  const asyncDir = mkdtempSync(join(tmpdir(), "goal-runtime-real-restart-"));
  const runId = "real-canary-failed-executor";
  const sessionId = "real-canary-root-session";
  const terminal = {
    version: 1, runId, runnerProcessInstanceId: "real-canary-runner", state: "observed", observedAt: 1_700_000_000_000,
    instances: [{ processInstanceId: "real-canary-runner", kind: "runner", closeObservedAt: 1_700_000_000_000, exitCode: 1, signal: null }],
  };
  const upstream = { async ping() { return {}; }, async stop() { throw Error("terminal recovery must not stop a process"); }, async dispose() {} };
  const pi = { events: {} };
  const brokerA = new RootBrokerServer({ rootSessionId: sessionId, lifecycleSessionId: sessionId, captureProcessBirthIdentity: async () => "real-canary-birth", writeGrant: async () => "/tmp/real-canary-grant", upstream });
  try {
    const authority = { goalId: "real-canary-goal", taskId: "real-canary-task", attempt: 1, runId, asyncDir, workspacePath: "/tmp/real-canary-workspace", leaseId: "c".repeat(64), sessionId, baseHead: "a".repeat(40), headAtDispatch: "a".repeat(40), executionRevision: 1, contractHash: "b".repeat(64), agent: "executor" };
    const terminalWithIdentity = { ...terminal, sessionId, asyncDir, agent: "executor" };
    writeFileSync(join(asyncDir, "status.json"), JSON.stringify({ ...authority, state: "failed", steps: [{ agent: "executor" }], processTerminal: terminalWithIdentity }));
    writeFileSync(join(asyncDir, "process-terminal.json"), JSON.stringify(terminalWithIdentity));
    await brokerA.observeStarted({ runId, id: runId, agent: "executor", pid: 43123, asyncDir, sessionId });
    brokerA.observeTerminal(terminal);
    await brokerA.closeRootSession();

    const brokerB = new RootBrokerServer({ rootSessionId: sessionId, lifecycleSessionId: sessionId, writeGrant: async () => "/tmp/real-canary-grant", upstream });
    try {
      bindRootBroker(pi, brokerB);
      const host = createProductionGoalRuntimeHost(pi);
      const recovered = await host.stopOwnedRun(authority);
      assert.equal(brokerB.ownedRuns.has(runId), false, "restart recovery must not use old Broker memory");
      assert.equal(recovered.state, "observed");
      assert.equal(recovered.proof.runId, runId);
      assert.equal(recovered.proof.instances[0].exitCode, 1, "failed proof remains failed terminal evidence");
    } finally {
      unbindRootBroker(pi, brokerB);
      await brokerB.closeRootSession();
    }
  } finally {
    await brokerA.closeRootSession().catch(() => undefined);
    rmSync(asyncDir, { recursive: true, force: true });
  }
});
