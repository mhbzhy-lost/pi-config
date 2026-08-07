import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { piHostModuleUrl } from "./helpers/pi-host.mjs";

const {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} = await import(piHostModuleUrl);

const repoRoot = process.cwd();

test("production Pi does not expose the non-returning spawn_process tool", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "process-fleet-removal-"));
  let result;

  try {
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: join(repoRoot, "pi"),
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    result = await createAgentSession({
      cwd,
      agentDir: join(repoRoot, "pi"),
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
    });

    assert.deepEqual(result.extensionsResult.errors, []);
    assert.equal(
      result.session.getAllTools().some((tool) => tool.name === "spawn_process"),
      false,
    );
  } finally {
    result?.session.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
