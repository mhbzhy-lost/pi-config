import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// 隔离 ambient 环境的 agent 目录：upstream subagent 配置经 env 解析 agentDir，
// 若继承宿主会话的 PI_CODING_AGENT_DIR（如指向旧版本主树），会读到含已退役
// 字段（modelExclusions）的 config 导致加载失败。统一钉扎到本仓 pi/ 目录。
// 隔离 ambient 环境的 agent 目录：upstream subagent 配置经 env 解析 agentDir，
// 若继承宿主会话的 PI_CODING_AGENT_DIR（如指向旧版本主树），会读到含已退役
// 字段（modelExclusions）的 config 导致加载失败。统一钉扎到本仓 pi/ 目录。
process.env.PI_CODING_AGENT_DIR = join(process.cwd(), "pi");

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
