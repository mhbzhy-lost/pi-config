import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import createSkillWhitelistExtension from "../scripts/lib/skill-whitelist-extension.mjs";
import { loadDesiredSkills } from "../scripts/lib/skill-whitelist.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("extension contributes exactly the allowlisted skill directories", async () => {
  const handlers = new Map();
  createSkillWhitelistExtension({
    on(name, handler) {
      handlers.set(name, handler);
    },
  });

  assert.deepEqual([...handlers.keys()], ["resources_discover"]);
  const result = await handlers.get("resources_discover")(
    { cwd: repoRoot, reason: "startup" },
    {},
  );

  const expected = [...(await loadDesiredSkills(repoRoot, join(repoRoot, "agents", "skills.list"))).values()];
  assert.deepEqual(result.skillPaths, expected);
});

test("Pi extension entry delegates to the tested factory", async () => {
  const entry = await import("../pi/extensions/skill-whitelist.ts");
  assert.equal(entry.default, createSkillWhitelistExtension);
});
