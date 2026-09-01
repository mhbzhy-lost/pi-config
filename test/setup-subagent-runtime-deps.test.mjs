import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { installSubagentRuntimeDependencies } from "../scripts/setup-subagent-runtime-deps.mjs";
import { verifyOrderedModelsRuntimePatch } from "../scripts/lib/subagent-dispatch/ordered-models-runtime-patch.mjs";

test("runtime dependency setup leaves the pinned pi-subagents package patched for ordered models", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "subagent-setup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, "node_modules", "pi-subagents");
  await mkdir(join(root, "node_modules"), { recursive: true });

  const calls = [];
  await installSubagentRuntimeDependencies({
    piNpmDir: root,
    async run(command, args) {
      calls.push([command, ...args]);
      if (args.includes("pi-subagents@0.62.0")) {
        await mkdir(join(packageRoot, "src", "agents"), { recursive: true });
        await writeFile(join(packageRoot, "package.json"), JSON.stringify({ version: "0.62.0" }));
        await writeFile(join(packageRoot, "src/agents/agents.ts"), [
          "\tmcpDirectTools?: string[];\n\tmodel?: string;\n\tfallbackModels?: string[];\n\tthinking?: string | false;",
          "const EMPTY_SUBAGENT_SETTINGS: SubagentSettings = { overrides: {} };",
          "\t\tconst fallbackModels = parseFrontmatterList(frontmatter.fallbackModels);",
          "\t\t\t...(frontmatter.model !== undefined ? { model: frontmatter.model } : {}),\n\t\t\t...(fallbackModels?.length ? { fallbackModels } : {}),",
          "\t\tfill(\"model\", [\"model\"], override.model === false ? undefined : override.model);",
          "\t\t\t[\"fallbackModels\"],",
        ].join("\n"));
        await writeFile(join(packageRoot, "src/agents/agent-serializer.ts"), [
          "\t\"model\",\n\t\"fallbackModels\",",
          "\tif (config.model || preserve(\"model\")) lines.push(`model: ${config.model ?? \"\"}`);\n\tconst fallbackModelsValue = joinComma(config.fallbackModels);\n\tif (fallbackModelsValue || preserve(\"fallbackModels\")) lines.push(`fallbackModels: ${fallbackModelsValue ?? \"\"}`);",
        ].join("\n"));
        await mkdir(join(packageRoot, "src/runs/shared"), { recursive: true });
        await mkdir(join(packageRoot, "src/api"), { recursive: true });
        await mkdir(join(packageRoot, "src/runs/background"), { recursive: true });
        await mkdir(join(packageRoot, "src/runs/foreground"), { recursive: true });
        await writeFile(join(packageRoot, "src/runs/shared/model-fallback.ts"), "\tscope?: ModelScopeConfig;\n\tonWarn?: (violation: ModelScopeViolation) => void;\n\tconst rawCandidates = [primaryModel, ...(fallbackModels ?? [])];\n");
        await writeFile(join(packageRoot, "src/api/preflight.ts"), [
          "const modelCandidates = buildModelCandidates(primaryModel, agent.fallbackModels, availableModels, preferredProvider, {",
          "\tscope: discovered.modelScope,",
          "});",
        ].join("\n"));
        await writeFile(join(packageRoot, "src/runs/background/async-execution.ts"), [
          "const modelCandidates = buildModelCandidates(primaryModel, agentConfig.fallbackModels, availableModels, ctx.currentModelProvider, {",
          "\tscope: ctx.modelScope,",
          "});",
        ].join("\n"));
        await writeFile(join(packageRoot, "src/runs/foreground/execution.ts"), [
          "const candidates = buildModelCandidates(primaryModel, agent.fallbackModels, availableModels, preferredProvider, {",
          "\tscope: options.modelScope,",
          "});",
        ].join("\n"));
      }
      return { stdout: "", stderr: "" };
    },
  });

  assert.equal(calls.some((call) => call.includes("pi-subagents@0.62.0")), true);
  assert.equal(await verifyOrderedModelsRuntimePatch(packageRoot), true);
  assert.match(await readFile(join(packageRoot, "src/agents/agents.ts"), "utf8"), /validateOrderedModels/);
});
