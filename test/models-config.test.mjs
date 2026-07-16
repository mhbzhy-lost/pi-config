import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("models.json configures the direct Idealab Qwen provider", async () => {
  const modelsConfig = JSON.parse(
    await readFile(join(repoRoot, "pi", "models.json"), "utf8"),
  );

  assert.deepEqual(modelsConfig, {
    providers: {
      "openai-idealab": {
        baseUrl: "https://idealab.alibaba-inc.com/api/openai/v1",
        api: "openai-completions",
        authHeader: true,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          maxTokensField: "max_tokens",
          thinkingFormat: "qwen",
          supportsStrictMode: false,
          supportsLongCacheRetention: false,
        },
        models: [
          {
            id: "Qwen3.7-Max-DogFooding",
            name: "Qwen 3.7 Max DogFooding",
            reasoning: true,
            input: ["text"],
            contextWindow: 1000000,
            maxTokens: 32768,
          },
        ],
      },
    },
  });
});
