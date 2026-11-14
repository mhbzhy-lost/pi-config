import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { localSettingsArgs } from "../scripts/pi-local-settings.ts";

test("local settings produce startup overrides without mutating shared settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-local-settings-"));
  await mkdir(join(root, "adapter"));
  try { assert.deepEqual(await localSettingsArgs({
    packages: ["adapter"],
    enabledModels: ["qoder-pool/Qwen4-Max-Preview", "zai-coding-cn/glm-5.3"],
    defaultProvider: "qoder-pool",
    defaultModel: "Qwen4-Max-Preview",
    defaultThinkingLevel: "low",
    theme: "system",
  }, [], join(root, "settings.local.json")), [
    "--extension", join(root, "adapter"),
    "--models", "qoder-pool/Qwen4-Max-Preview,zai-coding-cn/glm-5.3",
    "--provider", "qoder-pool", "--model", "Qwen4-Max-Preview",
    "--thinking", "low", "--use-theme", "system",
  ]); } finally { await rm(root, { recursive: true, force: true }); }
});

test("explicit CLI values take precedence over local settings", async () => {
  assert.deepEqual(await localSettingsArgs({ defaultModel: "local", theme: "system", enabledModels: ["local"] }, ["--model", "cli", "--use-theme", "dark", "--models", "cli"]), []);
});

test("invalid local settings fail closed", async () => {
  await assert.rejects(localSettingsArgs({ defaultThinkingLevel: "invalid" }, []), /defaultThinkingLevel 无效/);
  await assert.rejects(localSettingsArgs({ enabledModels: [] }, []), /enabledModels/);
  await assert.rejects(localSettingsArgs({ unused: true }, []), /不支持的字段/);
});
