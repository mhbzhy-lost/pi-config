import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
      undefined,
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
