import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { appendEvent, loadProjection } from "../scripts/lib/goal-engine/store.mjs";
import { hashGoalMetadataProposal } from "../scripts/lib/goal-engine/human-decision.mjs";
import { allocateExecutorWorkspace } from "../scripts/lib/goal-engine/workspace.mjs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createTemporaryArenaSync } from "./helpers/temporary-arena.mjs";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";

const temporaryArena = createTemporaryArenaSync("goal-engine-runtime-");
test.after(() => temporaryArena.disposeSync());
async function mkdtemp(prefix) { return temporaryArena.mkdtempSync(basename(prefix)); }

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const globalModules = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const piRoot = join(globalModules, "@earendil-works/pi-coding-agent");
const piModule = await import(pathToFileURL(join(piRoot, "dist/index.js")).href);
const { createAgentSession, DefaultResourceLoader, SessionManager } = piModule;

function goalEngineLoader(options) {
  writeFileSync(join(options.agentDir, "settings.json"), JSON.stringify({ goalEngine: { enabled: true } }));
  process.env.PI_CODING_AGENT_DIR = options.agentDir;
  return new DefaultResourceLoader(options);
}

// Ordinary legacy fixtures must never inherit the invoking Pi process's production Goal root.
const inheritedGoalStateDir = process.env.PI_CODING_GOAL_DIR;
delete process.env.PI_CODING_GOAL_DIR;
test.after(() => {
  if (inheritedGoalStateDir === undefined) delete process.env.PI_CODING_GOAL_DIR;
  else process.env.PI_CODING_GOAL_DIR = inheritedGoalStateDir;
});

test("real Pi host uses execution context cwd instead of process cwd", async () => {
  const processCwd = await mkdtemp(join(tmpdir(), "goal-engine-process-"));
  const projectCwd = await mkdtemp(join(tmpdir(), "goal-engine-project-"));
  const agentDir = await mkdtemp(join(tmpdir(), "goal-engine-host-"));
  const originalCwd = process.cwd();
  let result;
  try {
    execFileSync("git", ["init"], { cwd: projectCwd });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: projectCwd });
    execFileSync("git", ["config", "user.name", "Goal Engine Test"], { cwd: projectCwd });
    writeFileSync(join(projectCwd, "README.md"), "fixture\n");
    writeFileSync(join(projectCwd, ".gitignore"), ".state/goal-engine/\n");
    execFileSync("git", ["add", "."], { cwd: projectCwd });
    execFileSync("git", ["commit", "-m", "test: initialize safe fixture"], { cwd: projectCwd });
    process.chdir(processCwd);
    const loader = goalEngineLoader({
      cwd: projectCwd, agentDir,
      additionalExtensionPaths: [join(repoRoot, "pi/extensions/goal-engine.ts")],
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await loader.reload();
    const sessionManager = SessionManager.create(projectCwd, join(agentDir, "sessions"));
    result = await createAgentSession({ cwd: projectCwd, agentDir, resourceLoader: loader, sessionManager });
    await result.session.bindExtensions({ mode: "rpc", shutdownHandler() {}, onError(error) { throw error; } });
    const init = result.session.getToolDefinition("goal_init");
    await init.execute("goal-init-dual-cwd", {
      objective: "Project cwd registry", tasks: [{ id: "t1", description: "Task", writePaths: ["a"], acceptance: { criteria: [{ id: "c1", statement: "x", evidenceKinds: ["tests"] }] } }],
    }, new AbortController().signal, undefined, { cwd: projectCwd, sessionManager: result.session.sessionManager });
    assert.equal(existsSync(join(projectCwd, ".state/goal-engine/registry.json")), true);
    assert.equal(existsSync(join(processCwd, ".state/goal-engine/registry.json")), false);
  } finally {
    try { result?.session?.dispose(); } finally {
      process.chdir(originalCwd);
      await rm(agentDir, { recursive: true, force: true });
      await rm(projectCwd, { recursive: true, force: true });
      await rm(processCwd, { recursive: true, force: true });
    }
  }
});

test("real Pi host isolates PI_CODING_GOAL_DIR by canonical project cwd", async () => {
  const goalBase = await mkdtemp(join(tmpdir(), "goal-engine-global-host-"));
  const projects = [
    await mkdtemp(join(tmpdir(), "goal-engine-global-project-a-")),
    await mkdtemp(join(tmpdir(), "goal-engine-global-project-b-")),
  ];
  const agentDirs = [
    await mkdtemp(join(tmpdir(), "goal-engine-global-agent-a-")),
    await mkdtemp(join(tmpdir(), "goal-engine-global-agent-a-reload-")),
    await mkdtemp(join(tmpdir(), "goal-engine-global-agent-b-")),
  ];
  const hosts = [];
  const initializeRepo = (cwd) => {
    execFileSync("git", ["init"], { cwd });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd });
    execFileSync("git", ["config", "user.name", "Goal Engine Test"], { cwd });
    writeFileSync(join(cwd, "README.md"), "fixture\n");
    execFileSync("git", ["add", "README.md"], { cwd });
    execFileSync("git", ["commit", "-m", "test: initialize global Goal fixture"], { cwd });
  };
  const startHost = async (cwd, agentDir, sessionManager = SessionManager.create(cwd, join(agentDir, "sessions"))) => {
    const loader = goalEngineLoader({
      cwd,
      agentDir,
      additionalExtensionPaths: [join(repoRoot, "pi/extensions/goal-engine.ts")],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const host = await createAgentSession({ cwd, agentDir, resourceLoader: loader, sessionManager });
    await host.session.bindExtensions({ mode: "rpc", shutdownHandler() {}, onError(error) { throw error; } });
    hosts.push(host);
    return host;
  };

  try {
    projects.forEach(initializeRepo);
    process.env.PI_CODING_GOAL_DIR = goalBase;

    const first = await startHost(projects[0], agentDirs[0]);
    const firstContext = { cwd: projects[0], sessionManager: first.session.sessionManager };
    const firstInit = first.session.getToolDefinition("goal_init");
    const firstGoal = JSON.parse((await firstInit.execute("global-host-a-init", {
      objective: "Global host A",
      tasks: [{ id: "t1", description: "Task", writePaths: ["a"], acceptance: { criteria: [{ id: "c1", statement: "x", evidenceKinds: ["tests"] }] } }],
    }, new AbortController().signal, undefined, firstContext)).details.value);
    const firstManager = first.session.sessionManager;
    firstManager.appendMessage({ role: "assistant", content: [], provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, stopReason: "stop" });
    const firstSessionFile = firstManager.getSessionFile();
    const firstSessionDir = firstManager.getSessionDir();
    first.session.dispose();
    hosts.splice(hosts.indexOf(first), 1);

    const reloaded = await startHost(projects[0], agentDirs[1], SessionManager.open(firstSessionFile, firstSessionDir, projects[0]));
    const reloadedStatus = reloaded.session.getToolDefinition("goal_status");
    const recovered = JSON.parse((await reloadedStatus.execute(
      "global-host-a-status",
      { goal_id: firstGoal.goalId },
      new AbortController().signal,
      undefined,
      { cwd: projects[0], sessionManager: reloaded.session.sessionManager },
    )).details.value);
    assert.equal(recovered.goalId, firstGoal.goalId);

    const second = await startHost(projects[1], agentDirs[2]);
    const secondInit = second.session.getToolDefinition("goal_init");
    await secondInit.execute("global-host-b-init", {
      objective: "Global host B",
      tasks: [{ id: "t1", description: "Task", writePaths: ["b"], acceptance: { criteria: [{ id: "c1", statement: "x", evidenceKinds: ["tests"] }] } }],
    }, new AbortController().signal, undefined, { cwd: projects[1], sessionManager: second.session.sessionManager });

    const namespaces = readdirSync(goalBase).sort();
    assert.equal(namespaces.length, 2);
    const identities = namespaces.map((namespace) => JSON.parse(readFileSync(join(goalBase, namespace, "identity.json"), "utf8")));
    assert.deepEqual(
      identities.map((identity) => identity.canonicalCwd).sort(),
      projects.map((cwd) => realpathSync(cwd)).sort(),
    );
    assert.equal(new Set(identities.map((identity) => identity.namespace)).size, 2);
    for (const cwd of projects) assert.equal(existsSync(join(cwd, ".state", "goal-engine")), false);
  } finally {
    delete process.env.PI_CODING_GOAL_DIR;
    for (const host of hosts) host.session.dispose();
    for (const agentDir of agentDirs) await rm(agentDir, { recursive: true, force: true });
    for (const project of projects) await rm(project, { recursive: true, force: true });
    await rm(goalBase, { recursive: true, force: true });
  }
});

test("real Pi host rejects goal_init outside Git without state", async () => {
  const projectCwd = await mkdtemp(join(tmpdir(), "goal-engine-unsafe-host-"));
  const agentDir = await mkdtemp(join(tmpdir(), "goal-engine-host-"));
  let result;
  try {
    const loader = goalEngineLoader({ cwd: projectCwd, agentDir, additionalExtensionPaths: [join(repoRoot, "pi/extensions/goal-engine.ts")], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    const sessionManager = SessionManager.create(projectCwd, join(agentDir, "sessions"));
    result = await createAgentSession({ cwd: projectCwd, agentDir, resourceLoader: loader, sessionManager });
    await result.session.bindExtensions({ mode: "rpc", shutdownHandler() {}, onError(error) { throw error; } });
    const init = result.session.getToolDefinition("goal_init");
    await assert.rejects(() => init.execute("goal-init-unsafe-host", { objective: "Unsafe host", tasks: [{ id: "t1", description: "Task", writePaths: ["a"], acceptance: { criteria: [{ id: "c1", statement: "x", evidenceKinds: ["tests"] }] } }] }, new AbortController().signal, undefined, { cwd: projectCwd, sessionManager: result.session.sessionManager }), /GIT_INFRASTRUCTURE_ERROR: observed=.*remediation=.*stateChanged=false/);
    assert.equal(existsSync(join(projectCwd, ".state/goal-engine")), false);
  } finally {
    try { result?.session?.dispose(); } finally { await rm(agentDir, { recursive: true, force: true }); await rm(projectCwd, { recursive: true, force: true }); }
  }
});

test("real Pi host rejects historical unsafe dispatch through ToolDefinition.execute before allocation", async () => {
  const projectCwd = await mkdtemp(join(tmpdir(), "goal-engine-legacy-host-"));
  const agentDir = await mkdtemp(join(tmpdir(), "goal-engine-host-"));
  let result;
  try {
    execFileSync("git", ["init"], { cwd: projectCwd });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: projectCwd });
    execFileSync("git", ["config", "user.name", "Goal Engine Test"], { cwd: projectCwd });
    writeFileSync(join(projectCwd, "README.md"), "fixture\n");
    writeFileSync(join(projectCwd, ".gitignore"), ".state/goal-engine/\n");
    execFileSync("git", ["add", "."], { cwd: projectCwd });
    execFileSync("git", ["commit", "-m", "test: initialize safe fixture"], { cwd: projectCwd });
    const goalId = "real-host-historical-dispatch";
    const root = join(projectCwd, ".state/goal-engine");
    const event = { schemaVersion: "goal-engine.event.v3", eventId: "real-host-historical-create", goalId, occurredAt: "2024-01-01T00:00:00.000Z", type: "goal.created", data: { objective: "Real host historical dispatch", scope: [], nonGoals: [], dod: [], tasks: ["t1"], taskDefs: { t1: { description: "legacy task", deps: [], writePaths: ["src/x.ts"], acceptance: { criteria: ["works"], commands: [`cd ${projectCwd} && true`] }, workflow: "tdd" } } } };
    mkdirSync(join(root, "goals", goalId), { recursive: true });
    writeFileSync(join(root, "goals", goalId, "events.jsonl"), `${JSON.stringify(event)}\n`);
    writeFileSync(join(root, "registry.json"), JSON.stringify({ schema_version: "goal-engine.registry.v1", active_goal_ids: [goalId], goals: { [goalId]: { lifecycle: "active", objective: event.data.objective, updatedAt: event.occurredAt } } }));
    const loader = goalEngineLoader({ cwd: projectCwd, agentDir, additionalExtensionPaths: [join(repoRoot, "pi/extensions/goal-engine.ts")], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    const sessionManager = SessionManager.create(projectCwd, join(agentDir, "sessions"));
    writeFileSync(join(root, "goals", goalId, "events.jsonl"), `${JSON.stringify(event)}\n${JSON.stringify({ schemaVersion: "goal-engine.event.v3", eventId: "real-host-historical-session-bound", goalId, occurredAt: "2024-01-01T00:00:01.000Z", type: "goal.session_bound", data: { sessionId: sessionManager.getSessionId(), leafId: "historical-host" } })}\n`);
    result = await createAgentSession({ cwd: projectCwd, agentDir, resourceLoader: loader, sessionManager });
    await result.session.bindExtensions({ mode: "rpc", shutdownHandler() {}, onError(error) { throw error; } });
    const status = result.session.getToolDefinition("goal_status");
    const dispatch = result.session.getToolDefinition("goal_dispatch");
    const ctx = { cwd: projectCwd, sessionManager: result.session.sessionManager };
    const offered = JSON.parse((await status.execute("historical-status-host", {}, new AbortController().signal, undefined, ctx)).details.value);
    await assert.rejects(
      () => dispatch.execute("historical-dispatch-host", { task_id: "t1", action_token: offered.action_token }, new AbortController().signal, undefined, ctx),
      (error) => error.code === "INVALID_TASK_CONTRACT"
        && JSON.stringify(error.requiredNextAction) === JSON.stringify({ tool: "goal_status", params: { goal_id: goalId } }),
    );
    const events = readFileSync(join(root, "goals", goalId, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(events.at(-1).type, "goal.action_consumed");
    await assert.rejects(() => dispatch.execute("historical-dispatch-replay", { task_id: "t1", action_token: offered.action_token }, new AbortController().signal, undefined, ctx), /consumed|offer|status/i);
    assert.equal(existsSync(join(root, "worktrees", `${goalId}-t1-1`)), false);
    assert.equal(existsSync(join(root, "worktrees", `.${goalId}-t1-1.lease.json`)), false);
  } finally {
    try { result?.session?.dispose(); } finally { await rm(agentDir, { recursive: true, force: true }); await rm(projectCwd, { recursive: true, force: true }); }
  }
});

test("real Pi host validates and applies workflow amendments", async () => {
  const projectCwd = await mkdtemp(join(tmpdir(), "goal-engine-amend-host-"));
  const agentDir = await mkdtemp(join(tmpdir(), "goal-engine-host-"));
  let result;
  try {
    execFileSync("git", ["init"], { cwd: projectCwd });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: projectCwd });
    execFileSync("git", ["config", "user.name", "Goal Engine Test"], { cwd: projectCwd });
    writeFileSync(join(projectCwd, "README.md"), "fixture\n");
    writeFileSync(join(projectCwd, ".gitignore"), ".state/goal-engine/\n");
    execFileSync("git", ["add", "."], { cwd: projectCwd });
    execFileSync("git", ["commit", "-m", "test: initialize safe fixture"], { cwd: projectCwd });
    const loader = goalEngineLoader({ cwd: projectCwd, agentDir, additionalExtensionPaths: [join(repoRoot, "pi/extensions/goal-engine.ts")], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    const sessionManager = SessionManager.create(projectCwd, join(agentDir, "sessions"));
    result = await createAgentSession({ cwd: projectCwd, agentDir, resourceLoader: loader, sessionManager });
    await result.session.bindExtensions({ mode: "rpc", shutdownHandler() {}, onError(error) { throw error; } });
    const signal = new AbortController().signal;
    const init = result.session.getToolDefinition("goal_init");
    const status = result.session.getToolDefinition("goal_status");
    const amend = result.session.getToolDefinition("goal_amend");
    const ctx = { cwd: projectCwd, sessionManager: result.session.sessionManager };
    const initialized = JSON.parse((await init.execute("workflow-host-init", { objective: "Host workflow amendment", tasks: [{ id: "t1", description: "Task", writePaths: ["a"], acceptance: { criteria: [{ id: "c1", statement: "x", evidenceKinds: ["tests"] }] }, workflow: "existing-tests" }] }, signal, undefined, ctx)).details.value);
    const projection = loadProjection(join(projectCwd, ".state/goal-engine"), initialized.goalId);
    appendEvent(join(projectCwd, ".state/goal-engine"), { schemaVersion: "planned.v1", eventId: "workflow-host-discovery", goalId: initialized.goalId, occurredAt: new Date().toISOString(), type: "goal.discovery_recorded", data: { id: "workflow-host-discovery", summary: "Workflow change requested before dispatch", paths: [], source: "user_intent", sessionId: result.session.sessionManager.getSessionId() } }, projection.version);
    const offer = JSON.parse((await status.execute("workflow-host-status", { goal_id: initialized.goalId }, signal, undefined, ctx)).details.value);
    assert.equal(offer.machineAction.tool, "goal_amend");
    const legal = await amend.execute("workflow-host-legal", { operation: "patch_active", reason: "Change this pending task to the test-first workflow", update_tasks: { t1: { workflow: "tdd" } }, action_token: offer.action_token }, signal, undefined, ctx);
    assert.equal(JSON.parse(legal.details.value).tasks.t1.workflow, "tdd");
    const illegalOffer = JSON.parse((await status.execute("workflow-host-illegal-status", { goal_id: initialized.goalId }, signal, undefined, ctx)).details.value);
    await assert.rejects(
      () => amend.execute("workflow-host-illegal", { operation: "patch_active", reason: "Reject invalid workflow at the host schema boundary", update_tasks: { t1: { workflow: "unsafe" } }, action_token: illegalOffer.action_token }, signal, undefined, ctx),
      /workflow|enum|invalid/i,
    );
  } finally {
    try { result?.session?.dispose(); } finally { await rm(agentDir, { recursive: true, force: true }); await rm(projectCwd, { recursive: true, force: true }); }
  }
});

test("real Pi host compaction checkpoint reloads from durable session and Goal log", async () => {
  const projectCwd = await mkdtemp(join(tmpdir(), "goal-engine-compact-project-"));
  const agentDir = await mkdtemp(join(tmpdir(), "goal-engine-compact-host-"));
  let result;
  try {
    execFileSync("git", ["init"], { cwd: projectCwd });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: projectCwd });
    execFileSync("git", ["config", "user.name", "Goal Engine Test"], { cwd: projectCwd });
    writeFileSync(join(projectCwd, "README.md"), "fixture\n");
    writeFileSync(join(projectCwd, ".gitignore"), ".state/goal-engine/\n");
    execFileSync("git", ["add", "."], { cwd: projectCwd });
    execFileSync("git", ["commit", "-m", "test: initialize safe fixture"], { cwd: projectCwd });
    const loader = goalEngineLoader({ cwd: projectCwd, agentDir, additionalExtensionPaths: [join(repoRoot, "pi/extensions/goal-engine.ts")], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    const manager = SessionManager.create(projectCwd, join(agentDir, "sessions"));
    result = await createAgentSession({ cwd: projectCwd, agentDir, resourceLoader: loader, sessionManager: manager });
    await result.session.bindExtensions({ mode: "rpc", shutdownHandler() {}, onError(error) { throw error; } });
    const ctx = { cwd: projectCwd, sessionManager: result.session.sessionManager };
    const init = result.session.getToolDefinition("goal_init");
    const initialized = JSON.parse((await init.execute("compact-init", { objective: "Host compaction reload", tasks: [{ id: "t1", description: "Task", writePaths: ["src/a.ts"], acceptance: { criteria: [{ id: "c1", statement: "x", evidenceKinds: ["tests"] }] }, workflow: "tdd" }] }, new AbortController().signal, undefined, ctx)).details.value);
    const compact = await result.session.extensionRunner.emit({
      type: "session_before_compact", reason: "overflow", willRetry: true, signal: new AbortController().signal, branchEntries: [],
      preparation: { firstKeptEntryId: "entry-1", messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 1, fileOps: { read: new Set(["docs/read-only.md"]), written: new Set(["src/a.ts"]), edited: new Set(["src/a.ts", "src/b.ts"]) }, settings: {} },
    });
    assert.equal(compact, undefined);
    const root = join(projectCwd, ".state/goal-engine");
    assert.deepEqual(loadProjection(root, initialized.goalId).continuity.lastCheckpoint.modifiedFiles, ["src/a.ts", "src/b.ts"]);
    const firstManager = result.session.sessionManager;
    // Force the host's append-only session file to exist before opening it anew.
    firstManager.appendMessage({ role: "assistant", content: [], provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, stopReason: "stop" });
    const sessionFile = firstManager.getSessionFile();
    const sessionDir = firstManager.getSessionDir();
    const sessionId = firstManager.getSessionId();
    assert.ok(sessionFile);
    result.session.dispose();
    result = undefined;
    const reloadedManager = SessionManager.open(sessionFile, sessionDir, projectCwd);
    assert.notEqual(reloadedManager, firstManager);
    assert.equal(reloadedManager.getSessionId(), sessionId);
    const reloadedLoader = goalEngineLoader({ cwd: projectCwd, agentDir, additionalExtensionPaths: [join(repoRoot, "pi/extensions/goal-engine.ts")], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await reloadedLoader.reload();
    result = await createAgentSession({ cwd: projectCwd, agentDir, resourceLoader: reloadedLoader, sessionManager: reloadedManager });
    await result.session.bindExtensions({ mode: "rpc", shutdownHandler() {}, onError(error) { throw error; } });
    const recovery = await result.session.extensionRunner.emitBeforeAgentStart("resume", undefined, "base", {});
    assert.match(recovery.messages[0].content, /overflow|goal_status/);
    assert.equal(result.session.sessionManager.getSessionId(), sessionId);
  } finally {
    try { result?.session?.dispose(); } finally { await rm(agentDir, { recursive: true, force: true }); await rm(projectCwd, { recursive: true, force: true }); }
  }
});

async function withMetadataHost(run) {
  const projectCwd = await mkdtemp(join(tmpdir(), "goal-engine-metadata-negative-project-"));
  const agentDir = await mkdtemp(join(tmpdir(), "goal-engine-metadata-negative-host-"));
  let host;
  const makeHost = async (manager) => {
    const loader = goalEngineLoader({ cwd: projectCwd, agentDir, additionalExtensionPaths: [join(repoRoot, "pi/extensions/goal-engine.ts")], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    host = await createAgentSession({ cwd: projectCwd, agentDir, resourceLoader: loader, sessionManager: manager });
    await host.session.bindExtensions({ mode: "rpc", shutdownHandler() {}, onError(error) { throw error; } });
    return host;
  };
  try {
    execFileSync("git", ["init"], { cwd: projectCwd });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: projectCwd });
    execFileSync("git", ["config", "user.name", "Goal Engine Test"], { cwd: projectCwd });
    writeFileSync(join(projectCwd, "README.md"), "fixture\n");
    writeFileSync(join(projectCwd, ".gitignore"), ".state/goal-engine/\n");
    execFileSync("git", ["add", "."], { cwd: projectCwd });
    execFileSync("git", ["commit", "-m", "test: initialize fixture"], { cwd: projectCwd });
    await makeHost(SessionManager.create(projectCwd, join(agentDir, "sessions")));
    const signal = new AbortController().signal;
    const execute = (name, id, args, context = { cwd: projectCwd, sessionManager: host.session.sessionManager }) => host.session.getToolDefinition(name).execute(id, args, signal, undefined, context);
    const initialized = JSON.parse((await execute("goal_init", "metadata-negative-init", { objective: "Original metadata", tasks: [{ id: "t1", description: "Task", writePaths: ["a"], acceptance: { criteria: [{ id: "c1", statement: "x", evidenceKinds: ["tests"] }] }, workflow: "tdd" }] })).details.value);
    const root = join(projectCwd, ".state/goal-engine");
    appendEvent(root, { schemaVersion: "planned.v1", eventId: "metadata-negative-discovery", goalId: initialized.goalId, occurredAt: new Date().toISOString(), type: "goal.discovery_recorded", data: { id: "metadata-negative-discovery", summary: "Metadata change requires an amendment offer", paths: [], source: "user_intent", sessionId: host.session.sessionManager.getSessionId() } }, loadProjection(root, initialized.goalId).version);
    await run({ projectCwd, makeHost, execute, initialized, getHost: () => host });
  } finally {
    try { host?.session?.dispose(); } finally { await rm(agentDir, { recursive: true, force: true }); await rm(projectCwd, { recursive: true, force: true }); }
  }
}

const metadataProposal = async (execute, goalId, id = "metadata-propose") => JSON.parse((await execute("goal_amend", id, {
  goal_id: goalId,
  operation: "propose_update_goal",
  reason: "User requests an objective amendment",
  changes: { objective: "Amended metadata" },
})).details.value);

test("real Pi host metadata rpc approval produces an approved offer and applies", async () => {
  await withMetadataHost(async ({ execute, initialized, getHost }) => {
    const proposal = await metadataProposal(execute, initialized.goalId, "metadata-rpc-propose");
    await getHost().session.extensionRunner.emitInput("approve", undefined, "rpc");
    const offer = JSON.parse((await execute("goal_status", "metadata-rpc-status", { goal_id: initialized.goalId })).details.value);
    assert.equal(offer.machineAction.tool, "goal_amend");
    const applied = JSON.parse((await execute("goal_amend", "metadata-rpc-apply", { goal_id: initialized.goalId, operation: "update_goal", challenge_id: proposal.challenge_id, action_token: offer.action_token })).details.value);
    assert.equal(applied.objective, "Amended metadata");
  });
});

test("real Pi host metadata ambiguous input and extension source never approve", async (t) => {
  for (const [label, input, source] of [["ambiguous", "approve and reject", "interactive"], ["extension", "approve", "extension"]]) await t.test(label, async () => {
    await withMetadataHost(async ({ execute, initialized, getHost }) => {
      await metadataProposal(execute, initialized.goalId, `metadata-${label}-propose`);
      await getHost().session.extensionRunner.emitInput(input, undefined, source);
      const status = JSON.parse((await execute("goal_status", `metadata-${label}-status`, { goal_id: initialized.goalId })).details.value);
      assert.notEqual(status.machineAction?.params?.operation, "update_goal");
      assert.equal(status.action_token, null);
      assert.equal(status.metadataDecision.status, "AWAITING_USER_DECISION");
    });
  });
});

test("real Pi host metadata reject terminal offer survives base metadata changes across reload", async () => {
  await withMetadataHost(async ({ projectCwd, makeHost, execute, initialized, getHost }) => {
    const ordinary = JSON.parse((await execute("goal_status", "metadata-reject-ordinary-status", { goal_id: initialized.goalId })).details.value);
    assert.equal(ordinary.machineAction.tool, "goal_amend");
    await metadataProposal(execute, initialized.goalId, "metadata-reject-propose");
    await getHost().session.extensionRunner.emitInput("reject", undefined, "interactive");
    const manager = getHost().session.sessionManager;
    manager.appendMessage({ role: "assistant", content: [], provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, stopReason: "stop" });
    const sessionFile = manager.getSessionFile(); const sessionDir = manager.getSessionDir();
    getHost().session.dispose();
    await makeHost(SessionManager.open(sessionFile, sessionDir, projectCwd));
    const ctx = { cwd: projectCwd, sessionManager: getHost().session.sessionManager };
    const root = join(projectCwd, ".state/goal-engine");
    const projection = loadProjection(root, initialized.goalId);
    const changes = { objective: "Externally amended after rejection", scope: [], nonGoals: [], dod: [] };
    appendEvent(root, { schemaVersion: "planned.v1", eventId: "metadata-reject-post-terminal-amendment", goalId: initialized.goalId, occurredAt: new Date().toISOString(), type: "goal.contract_amended", data: { proposalHash: hashGoalMetadataProposal(changes), changes, approval: { entryId: "metadata-reject-post-terminal-entry", sessionId: "external-session", source: "rpc" } } }, projection.version);
    const assertTerminalOffer = (status) => {
      const actionOffer = loadProjection(root, initialized.goalId).actionOffer;
      assert.ok(actionOffer);
      assert.equal(status.machineAction.tool, "goal_amend");
      assert.deepEqual(status.machineAction.params, ordinary.machineAction.params);
      assert.equal(status.machineAction.tool, actionOffer.tool);
      assert.deepEqual(status.machineAction.params, actionOffer.params);
      assert.equal(status.action_token, actionOffer.token);
      assert.equal(status.metadataDecision.status, "REJECTED");
    };
    const status = JSON.parse((await execute("goal_status", "metadata-reject-status", { goal_id: initialized.goalId }, ctx)).details.value);
    assert.equal(status.metadataDecision.status, "REJECTED");
    assertTerminalOffer(status);
    await getHost().session.extensionRunner.emitInput("approve", undefined, "interactive");
    const afterApprove = JSON.parse((await execute("goal_status", "metadata-reject-after-approve-status", { goal_id: initialized.goalId }, ctx)).details.value);
    assert.equal(afterApprove.metadataDecision.status, "REJECTED");
    assertTerminalOffer(afterApprove);
  });
});

test("real Pi host metadata presentation and non_goals use the public API", async () => {
  await withMetadataHost(async ({ projectCwd, execute, initialized, getHost }) => {
    const proposal = JSON.parse((await execute("goal_amend", "metadata-presentation-propose", {
      goal_id: initialized.goalId, operation: "propose_update_goal", reason: "Present the complete normalized proposal",
      changes: { objective: "Presented metadata", scope: ["docs"], non_goals: ["internal names"], dod: ["verified"] },
    })).details.value);
    assert.equal(proposal.reason, "Present the complete normalized proposal");
    assert.deepEqual(proposal.base_metadata, { objective: "Original metadata", scope: [], non_goals: [], dod: [] });
    assert.deepEqual(proposal.target_metadata, { objective: "Presented metadata", scope: ["docs"], non_goals: ["internal names"], dod: ["verified"] });
    assert.match(proposal.proposal_hash, /.+/);
    assert.deepEqual(proposal.choices, ["approve", "reject"]);
    await getHost().session.extensionRunner.emitInput("approve", undefined, "interactive");
    const offer = JSON.parse((await execute("goal_status", "metadata-presentation-status", { goal_id: initialized.goalId })).details.value);
    await execute("goal_amend", "metadata-presentation-apply", { goal_id: initialized.goalId, operation: "update_goal", challenge_id: proposal.challenge_id, action_token: offer.action_token });
    assert.deepEqual(loadProjection(join(projectCwd, ".state/goal-engine"), initialized.goalId).nonGoals, ["internal names"]);
    await assert.rejects(() => execute("goal_amend", "metadata-nonGoals-private", {
      goal_id: initialized.goalId, operation: "propose_update_goal", reason: "Reject internal name", changes: { nonGoals: ["private"] },
    }), /nonGoals|schema|additional/i);
  });
});

test("real Pi host metadata cross-session approval and token are isolated", async () => {
  await withMetadataHost(async ({ projectCwd, makeHost, execute, initialized, getHost }) => {
    const proposal = await metadataProposal(execute, initialized.goalId, "metadata-cross-session-propose");
    await getHost().session.extensionRunner.emitInput("approve", undefined, "interactive");
    const offerA = JSON.parse((await execute("goal_status", "metadata-cross-session-status-a", { goal_id: initialized.goalId })).details.value);
    getHost().session.dispose();
    await makeHost(SessionManager.create(projectCwd, join(projectCwd, "other-sessions")));
    assert.equal((await execute("goal_status", "metadata-cross-session-status-b", { goal_id: initialized.goalId })).details.value, "NO_ACTIVE_GOAL");
    await assert.rejects(() => execute("goal_amend", "metadata-cross-session-apply", { goal_id: initialized.goalId, operation: "update_goal", challenge_id: proposal.challenge_id, action_token: offerA.action_token }), /No active goal|session|approval|offer/i);
  });
});

test("real Pi host metadata stale proposal requires reproposal without machine action", async () => {
  await withMetadataHost(async ({ projectCwd, execute, initialized }) => {
    await metadataProposal(execute, initialized.goalId, "metadata-stale-propose");
    const root = join(projectCwd, ".state/goal-engine"); const projection = loadProjection(root, initialized.goalId);
    const changes = { objective: "Externally amended metadata", scope: [], nonGoals: [], dod: [] };
    appendEvent(root, { schemaVersion: "planned.v1", eventId: "metadata-stale-amendment", goalId: initialized.goalId, occurredAt: new Date().toISOString(), type: "goal.contract_amended", data: { proposalHash: hashGoalMetadataProposal(changes), changes, approval: { entryId: "metadata-stale-entry", sessionId: "external-session", source: "rpc" } } }, projection.version);
    const status = JSON.parse((await execute("goal_status", "metadata-stale-status", { goal_id: initialized.goalId })).details.value);
    assert.equal(status.machineAction, null); assert.equal(status.action_token, null);
    assert.equal(status.metadataDecision.status, "REPROPOSE_REQUIRED");
  });
});

test("real Pi host metadata exact challenge binding rejects wrong id and replay", async () => {
  await withMetadataHost(async ({ execute, initialized, getHost }) => {
    const proposal = await metadataProposal(execute, initialized.goalId, "metadata-exact-propose");
    await getHost().session.extensionRunner.emitInput("approve", undefined, "interactive");
    const offer = JSON.parse((await execute("goal_status", "metadata-exact-status", { goal_id: initialized.goalId })).details.value);
    await assert.rejects(() => execute("goal_amend", "metadata-exact-wrong", { goal_id: initialized.goalId, operation: "update_goal", challenge_id: "wrong-challenge", action_token: offer.action_token }), /challenge|approval|offer/i);
    await execute("goal_amend", "metadata-exact-apply", { goal_id: initialized.goalId, operation: "update_goal", challenge_id: proposal.challenge_id, action_token: offer.action_token });
    await assert.rejects(() => execute("goal_amend", "metadata-exact-replay", { goal_id: initialized.goalId, operation: "update_goal", challenge_id: proposal.challenge_id, action_token: offer.action_token }), /consumed|approval|offer/i);
  });
});

test("real Pi host orphan human authorization survives reload and is non-replayable", async () => {
  const projectCwd = await mkdtemp(join(tmpdir(), "goal-engine-orphan-host-project-"));
  const agentDir = await mkdtemp(join(tmpdir(), "goal-engine-orphan-host-"));
  let host;
  const makeHost = async (manager) => {
    const loader = goalEngineLoader({ cwd: projectCwd, agentDir, additionalExtensionPaths: [join(repoRoot, "pi/extensions/goal-engine.ts")], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    host = await createAgentSession({ cwd: projectCwd, agentDir, resourceLoader: loader, sessionManager: manager });
    await host.session.bindExtensions({ mode: "rpc", shutdownHandler() {}, onError(error) { throw error; } });
  };
  try {
    execFileSync("git", ["init"], { cwd: projectCwd });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: projectCwd });
    execFileSync("git", ["config", "user.name", "Goal Engine Test"], { cwd: projectCwd });
    writeFileSync(join(projectCwd, "README.md"), "fixture\n"); writeFileSync(join(projectCwd, ".gitignore"), ".state/goal-engine/\n");
    execFileSync("git", ["add", "."], { cwd: projectCwd }); execFileSync("git", ["commit", "-m", "test: orphan fixture"], { cwd: projectCwd });
    await makeHost(SessionManager.create(projectCwd, join(agentDir, "sessions")));
    const signal = new AbortController().signal;
    const execute = (name, id, args) => host.session.getToolDefinition(name).execute(id, args, signal, undefined, { cwd: projectCwd, sessionManager: host.session.sessionManager });
    const initialized = JSON.parse((await execute("goal_init", "orphan-init", { objective: "Real host exact orphan authorization", tasks: [{ id: "t1", description: "orphan", writePaths: ["src/x.ts"], acceptance: { criteria: [{ id: "c1", statement: "x", evidenceKinds: ["tests"] }] }, workflow: "tdd" }] })).details.value);
    const stateRoot = join(projectCwd, ".state/goal-engine");
    const lease = allocateExecutorWorkspace({ goalId: initialized.goalId, taskId: "t1", attempt: 1, originRoot: projectCwd, stateRoot, baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectCwd, encoding: "utf8" }).trim() });
    const first = JSON.parse((await execute("goal_status", "orphan-status-a", { goal_id: initialized.goalId })).details.value);
    assert.equal(first.orphanDecision.status, "AWAITING_USER_DECISION");
    assert.match(first.orphanDecision.inventory_hash, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(first.orphanDecision.inventory).sort(), ["baseCommit", "branch", "executorHead", "originRef", "resources"]);
    for (const forbidden of ["ownerToken", "leasePath", "originRoot", "stateRoot", "path", "command", "toolOutput"]) assert.equal(JSON.stringify(first.orphanDecision.inventory).includes(forbidden), false);
    await host.session.extensionRunner.emitInput("discard", undefined, "interactive");
    const manager = host.session.sessionManager;
    manager.appendMessage({ role: "assistant", content: [], provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, stopReason: "stop" });
    const sessionFile = manager.getSessionFile(); const sessionDir = manager.getSessionDir(); host.session.dispose();
    await makeHost(SessionManager.open(sessionFile, sessionDir, projectCwd));
    const offer = JSON.parse((await execute("goal_status", "orphan-status-reloaded", { goal_id: initialized.goalId })).details.value);
    assert.deepEqual(offer.machineAction, { tool: "goal_integrate", params: { goal_id: initialized.goalId, task_id: "t1", action: "discard" } });
    assert.equal(offer.action_token, loadProjection(stateRoot, initialized.goalId).actionOffer.token);
    await execute("goal_integrate", "orphan-discard", { goal_id: initialized.goalId, task_id: "t1", action: "discard", challenge_id: first.orphanDecision.challenge_id, action_token: offer.action_token });
    const consumed = host.session.sessionManager.getEntries().find((entry) => entry.customType === "goal-engine-orphan-disposition-consumed");
    assert.ok(consumed); assert.equal(JSON.stringify(consumed.data).includes("ownerToken"), false);
    assert.equal(JSON.stringify(consumed.data).includes(first.orphanDecision.challenge_id), true); assert.equal(JSON.stringify(consumed.data).includes("discard"), true);
    assert.equal(existsSync(lease.path), false); assert.equal(existsSync(lease.leasePath), false);
    assert.equal(execFileSync("git", ["branch", "--list", lease.branch], { cwd: projectCwd, encoding: "utf8" }).trim(), lease.branch);
    await assert.rejects(() => execute("goal_integrate", "orphan-discard-replay", { goal_id: initialized.goalId, task_id: "t1", action: "discard", challenge_id: first.orphanDecision.challenge_id, action_token: offer.action_token }), /consumed|token|offer/i);
  } finally {
    try { host?.session?.dispose(); } finally { await rm(agentDir, { recursive: true, force: true }); await rm(projectCwd, { recursive: true, force: true }); }
  }
});

test("real Pi host metadata proposal approval lifecycle survives reload and is non-replayable", async () => {
  const projectCwd = await mkdtemp(join(tmpdir(), "goal-engine-metadata-project-"));
  const agentDir = await mkdtemp(join(tmpdir(), "goal-engine-metadata-host-"));
  let result;
  try {
    execFileSync("git", ["init"], { cwd: projectCwd });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: projectCwd });
    execFileSync("git", ["config", "user.name", "Goal Engine Test"], { cwd: projectCwd });
    writeFileSync(join(projectCwd, "README.md"), "fixture\n");
    writeFileSync(join(projectCwd, ".gitignore"), ".state/goal-engine/\n");
    execFileSync("git", ["add", "."], { cwd: projectCwd });
    execFileSync("git", ["commit", "-m", "test: initialize fixture"], { cwd: projectCwd });
    const makeSession = async (manager) => {
      const loader = goalEngineLoader({ cwd: projectCwd, agentDir, additionalExtensionPaths: [join(repoRoot, "pi/extensions/goal-engine.ts")], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
      await loader.reload();
      const host = await createAgentSession({ cwd: projectCwd, agentDir, resourceLoader: loader, sessionManager: manager });
      await host.session.bindExtensions({ mode: "rpc", shutdownHandler() {}, onError(error) { throw error; } });
      return host;
    };
    result = await makeSession(SessionManager.create(projectCwd, join(agentDir, "sessions")));
    const ctx = { cwd: projectCwd, sessionManager: result.session.sessionManager };
    const signal = new AbortController().signal;
    const execute = (name, id, args, context = ctx) => result.session.getToolDefinition(name).execute(id, args, signal, undefined, context);
    const initialized = JSON.parse((await execute("goal_init", "metadata-init", { objective: "Original metadata", tasks: [{ id: "t1", description: "Task", writePaths: ["a"], acceptance: { criteria: [{ id: "c1", statement: "x", evidenceKinds: ["tests"] }] }, workflow: "tdd" }] })).details.value);
    // This first assertion is intentionally RED on HEAD: proposal is absent from the public Host schema.
    const proposal = JSON.parse((await execute("goal_amend", "metadata-propose", { goal_id: initialized.goalId, operation: "propose_update_goal", reason: "User requests an objective amendment", changes: { objective: "Amended metadata" } })).details.value);
    assert.equal(proposal.status, "METADATA_PROPOSAL_PENDING");
    assert.match(proposal.challenge_id, /.+/);
    assert.match(proposal.proposal_hash, /.+/);
    await result.session.extensionRunner.emitInput("approve", undefined, "interactive");
    const offer = JSON.parse((await execute("goal_status", "metadata-status", { goal_id: initialized.goalId })).details.value);
    assert.equal(offer.machineAction.tool, "goal_amend");
    assert.deepEqual(offer.machineAction.params, { goal_id: initialized.goalId, operation: "update_goal", challenge_id: proposal.challenge_id });
    assert.ok(offer.action_token);
    const sessionFile = result.session.sessionManager.getSessionFile();
    const sessionDir = result.session.sessionManager.getSessionDir();
    result.session.sessionManager.appendMessage({ role: "assistant", content: [], provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, stopReason: "stop" });
    result.session.dispose(); result = undefined;
    result = await makeSession(SessionManager.open(sessionFile, sessionDir, projectCwd));
    const reloadCtx = { cwd: projectCwd, sessionManager: result.session.sessionManager };
    const recovered = JSON.parse((await execute("goal_status", "metadata-recovered-status", { goal_id: initialized.goalId }, reloadCtx)).details.value);
    assert.equal(recovered.machineAction.params.challenge_id, proposal.challenge_id);
    const applied = JSON.parse((await execute("goal_amend", "metadata-apply", { goal_id: initialized.goalId, operation: "update_goal", challenge_id: proposal.challenge_id, action_token: recovered.action_token }, reloadCtx)).details.value);
    assert.equal(applied.objective, "Amended metadata");
    const events = readFileSync(join(projectCwd, ".state/goal-engine/goals", initialized.goalId, "events.jsonl"), "utf8");
    assert.match(events, /contract_amended/); assert.match(events, /approval/);
    result.session.dispose(); result = undefined;
    result = await makeSession(SessionManager.open(sessionFile, sessionDir, projectCwd));
    await assert.rejects(() => execute("goal_amend", "metadata-replay", { goal_id: initialized.goalId, operation: "update_goal", challenge_id: proposal.challenge_id, action_token: recovered.action_token }, { cwd: projectCwd, sessionManager: result.session.sessionManager }), /consumed|approval|offer/i);
    await assert.rejects(() => execute("goal_amend", "metadata-strict-cross-operation", { operation: "update_goal", challenge_id: proposal.challenge_id, action_token: "bad", changes: {} }, { cwd: projectCwd, sessionManager: result.session.sessionManager }), /schema|argument|unknown|additional/i);
  } finally {
    try { result?.session?.dispose(); } finally { await rm(agentDir, { recursive: true, force: true }); await rm(projectCwd, { recursive: true, force: true }); }
  }
});

test("real Pi host executes goal_status through ToolDefinition.execute", async () => {
  const projectCwd = await mkdtemp(join(tmpdir(), "goal-engine-project-"));
  const agentDir = await mkdtemp(join(tmpdir(), "goal-engine-host-"));
  let result;
  try {
    const loader = goalEngineLoader({
      cwd: projectCwd,
      agentDir,
      additionalExtensionPaths: [join(repoRoot, "pi/extensions/goal-engine.ts")],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    result = await createAgentSession({
      cwd: projectCwd,
      agentDir,
      resourceLoader: loader,
      sessionManager: SessionManager.create(projectCwd, join(agentDir, "sessions")),
    });
    const errors = [];
    await result.session.bindExtensions({
      mode: "rpc",
      shutdownHandler() {},
      onError(error) { errors.push(error); },
    });
    const status = result.session.getToolDefinition("goal_status");
    const output = await status.execute(
      "goal-status-real-host",
      {},
      new AbortController().signal,
      undefined,
      { cwd: projectCwd, sessionManager: result.session.sessionManager },
    );
    assert.equal(output.content[0].text, "NO_ACTIVE_GOAL");
    assert.deepEqual(output.details, { value: "NO_ACTIVE_GOAL" });
    assert.equal(output.details.value, "NO_ACTIVE_GOAL");
    assert.deepEqual(errors, []);
  } finally {
    try {
      if (result?.session) {
        try {
          await result.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        } finally {
          result.session.dispose();
          result = undefined;
        }
      }
    } finally {
      await rm(agentDir, { recursive: true, force: true });
      await rm(projectCwd, { recursive: true, force: true });
    }
  }
});
