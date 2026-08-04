import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
    result = await createAgentSession({ cwd: projectCwd, agentDir, resourceLoader: loader, sessionManager: SessionManager.inMemory(projectCwd) });
    await result.session.bindExtensions({ mode: "rpc", shutdownHandler() {}, onError(error) { throw error; } });
    const init = result.session.getToolDefinition("goal_init");
    await init.execute("goal-init-dual-cwd", {
      objective: "Project cwd registry", tasks: [{ id: "t1", description: "Task", writePaths: ["a"], acceptance: { criteria: ["x"], commands: ["true"] } }],
    }, new AbortController().signal, undefined, { cwd: projectCwd });
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
    result = await createAgentSession({ cwd: projectCwd, agentDir, resourceLoader: loader, sessionManager: SessionManager.inMemory(projectCwd) });
    await result.session.bindExtensions({ mode: "rpc", shutdownHandler() {}, onError(error) { throw error; } });
    const init = result.session.getToolDefinition("goal_init");
    await assert.rejects(() => init.execute("goal-init-unsafe-host", { objective: "Unsafe host", tasks: [{ id: "t1", description: "Task", writePaths: ["a"], acceptance: { criteria: ["x"], commands: ["true"] } }] }, new AbortController().signal, undefined, { cwd: projectCwd }), /GIT_INFRASTRUCTURE_ERROR: observed=.*remediation=.*stateChanged=false/);
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
    result = await createAgentSession({ cwd: projectCwd, agentDir, resourceLoader: loader, sessionManager: SessionManager.inMemory(projectCwd) });
    await result.session.bindExtensions({ mode: "rpc", shutdownHandler() {}, onError(error) { throw error; } });
    const dispatch = result.session.getToolDefinition("goal_dispatch");
    await assert.rejects(
      () => dispatch.execute("historical-dispatch-host", { task_id: "t1" }, new AbortController().signal, undefined, { cwd: projectCwd }),
      (error) => error.code === "INVALID_TASK_CONTRACT" && /stateChanged=false.*goal_amend/.test(error.message),
    );
    assert.equal(existsSync(join(root, "worktrees", `${goalId}-t1-1`)), false);
    assert.equal(existsSync(join(root, "worktrees", `.${goalId}-t1-1.lease.json`)), false);
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
      sessionManager: SessionManager.inMemory(projectCwd),
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
      { cwd: projectCwd },
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
