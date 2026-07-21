import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("models.json configures Idealab providers", async () => {
  const modelsConfig = JSON.parse(
    await readFile(join(repoRoot, "pi", "models.json"), "utf8"),
  );

  assert.ok(modelsConfig.providers["openai-idealab"]);
  assert.equal(modelsConfig.providers["openai-idealab"].api, "openai-completions");
  assert.equal(modelsConfig.providers["openai-idealab"].baseUrl, "https://idealab.alibaba-inc.com/api/openai/v1");
  assert.ok(modelsConfig.providers["openai-idealab"].models.length >= 1);

  assert.ok(modelsConfig.providers["anthropic-idealab"]);
  assert.equal(modelsConfig.providers["anthropic-idealab"].api, "anthropic-messages");
  assert.equal(modelsConfig.providers["anthropic-idealab"].baseUrl, "https://idealab.alibaba-inc.com/api/anthropic");
  assert.ok(modelsConfig.providers["anthropic-idealab"].models.length >= 1);
});
