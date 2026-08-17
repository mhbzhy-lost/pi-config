import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const missingAdapterPackage = "../../.r2c/integrations/pi-adapter";

test("Pi settings omit the missing local adapter package", async () => {
  const settings = JSON.parse(
    await readFile(join(repoRoot, "pi", "settings.json"), "utf8"),
  );

  assert.ok(!settings.packages.includes(missingAdapterPackage));
});

test("Pi settings retain a valid default model and pi-subagents package", async () => {
  const settings = JSON.parse(
    await readFile(join(repoRoot, "pi", "settings.json"), "utf8"),
  );
  const defaultModel = `${settings.defaultProvider}/${settings.defaultModel}`;

  assert.ok(settings.enabledModels.includes(defaultModel));
  assert.ok(
    settings.packages.some(
      (entry) => entry && typeof entry === "object" && entry.source === "npm:pi-subagents@0.45.2",
    ),
  );
});
