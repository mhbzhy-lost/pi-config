import assert from "node:assert/strict";
import test from "node:test";
import { localSettingsArgs } from "../scripts/pi-local-settings.ts";

test("local settings produce startup overrides without mutating shared settings", () => {
  assert.deepEqual(localSettingsArgs({
    enabledModels: ["qoder-pool/Qwen4-Max-Preview", "zai-coding-cn/glm-5.3"],
    defaultProvider: "qoder-pool",
    defaultModel: "Qwen4-Max-Preview",
    defaultThinkingLevel: "low",
    theme: "system",
  }, []), [
    "--models", "qoder-pool/Qwen4-Max-Preview,zai-coding-cn/glm-5.3",
    "--provider", "qoder-pool", "--model", "Qwen4-Max-Preview",
    "--thinking", "low", "--use-theme", "system",
  ]);
});

test("explicit CLI values take precedence over local settings", () => {
  assert.deepEqual(localSettingsArgs({ defaultModel: "local", theme: "system", enabledModels: ["local"] }, ["--model", "cli", "--use-theme", "dark", "--models", "cli"]), []);
});

test("invalid local settings fail closed", () => {
  assert.throws(() => localSettingsArgs({ defaultThinkingLevel: "invalid" }, []), /defaultThinkingLevel 无效/);
  assert.throws(() => localSettingsArgs({ enabledModels: [] }, []), /enabledModels/);
  assert.throws(() => localSettingsArgs({ unused: true }, []), /不支持的字段/);
});
