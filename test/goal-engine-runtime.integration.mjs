import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { appendEvent, loadProjection } from "../scripts/lib/goal-engine/store.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const globalModules = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const piRoot = join(globalModules, "@earendil-works/pi-coding-agent");
const piModule = await import(pathToFileURL(join(piRoot, "dist/index.js")).href);
const { createAgentSession, DefaultResourceLoader, SessionManager } = piModule;

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
    const loader = new DefaultResourceLoader({
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
      objective: "Project cwd registry", tasks: [{ id: "t1", description: "Task", writePaths: ["a"], acceptance: { criteria: ["x"], commands: ["true"] } }],
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

test("real Pi host rejects goal_init outside Git without state", async () => {
  const projectCwd = await mkdtemp(join(tmpdir(), "goal-engine-unsafe-host-"));
  const agentDir = await mkdtemp(join(tmpdir(), "goal-engine-host-"));
  let result;
  try {
    const loader = new DefaultResourceLoader({ cwd: projectCwd, agentDir, additionalExtensionPaths: [join(repoRoot, "pi/extensions/goal-engine.ts")], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    const sessionManager = SessionManager.create(projectCwd, join(agentDir, "sessions"));
    result = await createAgentSession({ cwd: projectCwd, agentDir, resourceLoader: loader, sessionManager });
    await result.session.bindExtensions({ mode: "rpc", shutdownHandler() {}, onError(error) { throw error; } });
    const init = result.session.getToolDefinition("goal_init");
    await assert.rejects(() => init.execute("goal-init-unsafe-host", { objective: "Unsafe host", tasks: [{ id: "t1", description: "Task", writePaths: ["a"], acceptance: { criteria: ["x"], commands: ["true"] } }] }, new AbortController().signal, undefined, { cwd: projectCwd, sessionManager: result.session.sessionManager }), /GIT_INFRASTRUCTURE_ERROR: observed=.*remediation=.*stateChanged=false/);
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
    const event = { schemaVersion: "goal-engine.event.v2", eventId: "real-host-historical-create", goalId, occurredAt: "2024-01-01T00:00:00.000Z", type: "goal.created", data: { objective: "Real host historical dispatch", scope: [], nonGoals: [], dod: [], tasks: ["t1"], taskDefs: { t1: { description: "legacy task", deps: [], writePaths: ["src/x.ts"], acceptance: { criteria: ["works"], commands: [`cd ${projectCwd} && true`] }, workflow: "tdd" } } } };
    mkdirSync(join(root, "goals", goalId), { recursive: true });
    writeFileSync(join(root, "goals", goalId, "events.jsonl"), `${JSON.stringify(event)}\n`);
    writeFileSync(join(root, "registry.json"), JSON.stringify({ schema_version: "goal-engine.registry.v1", active_goal_ids: [goalId], goals: { [goalId]: { lifecycle: "active", objective: event.data.objective, updatedAt: event.occurredAt } } }));
    const loader = new DefaultResourceLoader({ cwd: projectCwd, agentDir, additionalExtensionPaths: [join(repoRoot, "pi/extensions/goal-engine.ts")], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    const sessionManager = SessionManager.create(projectCwd, join(agentDir, "sessions"));
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
    const loader = new DefaultResourceLoader({ cwd: projectCwd, agentDir, additionalExtensionPaths: [join(repoRoot, "pi/extensions/goal-engine.ts")], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    const sessionManager = SessionManager.create(projectCwd, join(agentDir, "sessions"));
    result = await createAgentSession({ cwd: projectCwd, agentDir, resourceLoader: loader, sessionManager });
    await result.session.bindExtensions({ mode: "rpc", shutdownHandler() {}, onError(error) { throw error; } });
    const signal = new AbortController().signal;
    const init = result.session.getToolDefinition("goal_init");
    const status = result.session.getToolDefinition("goal_status");
    const amend = result.session.getToolDefinition("goal_amend");
    const ctx = { cwd: projectCwd, sessionManager: result.session.sessionManager };
    const initialized = JSON.parse((await init.execute("workflow-host-init", { objective: "Host workflow amendment", tasks: [{ id: "t1", description: "Task", writePaths: ["a"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "existing-tests" }] }, signal, undefined, ctx)).details.value);
    const projection = loadProjection(join(projectCwd, ".state/goal-engine"), initialized.goalId);
    appendEvent(join(projectCwd, ".state/goal-engine"), { schemaVersion: "goal-engine.event.v3", eventId: "workflow-host-discovery", goalId: initialized.goalId, occurredAt: new Date().toISOString(), type: "goal.discovery_recorded", data: { id: "workflow-host-discovery", summary: "Workflow change requested before dispatch", paths: [], source: "user_intent", sessionId: result.session.sessionManager.getSessionId() } }, projection.version);
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
    const loader = new DefaultResourceLoader({ cwd: projectCwd, agentDir, additionalExtensionPaths: [join(repoRoot, "pi/extensions/goal-engine.ts")], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    const manager = SessionManager.create(projectCwd, join(agentDir, "sessions"));
    result = await createAgentSession({ cwd: projectCwd, agentDir, resourceLoader: loader, sessionManager: manager });
    await result.session.bindExtensions({ mode: "rpc", shutdownHandler() {}, onError(error) { throw error; } });
    const ctx = { cwd: projectCwd, sessionManager: result.session.sessionManager };
    const init = result.session.getToolDefinition("goal_init");
    const initialized = JSON.parse((await init.execute("compact-init", { objective: "Host compaction reload", tasks: [{ id: "t1", description: "Task", writePaths: ["src/a.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" }] }, new AbortController().signal, undefined, ctx)).details.value);
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
    const reloadedLoader = new DefaultResourceLoader({ cwd: projectCwd, agentDir, additionalExtensionPaths: [join(repoRoot, "pi/extensions/goal-engine.ts")], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
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

test("real Pi host executes goal_status through ToolDefinition.execute", async () => {
  const projectCwd = await mkdtemp(join(tmpdir(), "goal-engine-project-"));
  const agentDir = await mkdtemp(join(tmpdir(), "goal-engine-host-"));
  let result;
  try {
    const loader = new DefaultResourceLoader({
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
