import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import test from "node:test";
import createSkillWhitelistExtension from "../scripts/lib/skill-whitelist-extension.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const globalSkillsDir = join(homedir(), ".agents", "skills");

test("extension discovers global skills from ~/.agents/skills and project skills", async (t) => {
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

  const globalPaths = result.skillPaths.filter((p) => p.startsWith(globalSkillsDir));
  const projectPaths = result.skillPaths.filter((p) => !p.startsWith(globalSkillsDir));

  if (globalPaths.length === 0) {
    t.skip("~/.agents/skills is empty (run: node scripts/sync-skills.mjs)");
    return;
  }
  for (const p of globalPaths) {
    assert.match(p, /\.agents\/skills\//, `unexpected global skill path: ${p}`);
  }
  for (const p of projectPaths) {
    assert.match(p, /\.pi\/skills\/|\.agents\/skills\//, `unexpected project skill path: ${p}`);
  }
});

test("Pi extension entry delegates to the tested factory", async () => {
  const entry = await import("../pi/extensions/skill-whitelist.ts");
  assert.equal(entry.default, createSkillWhitelistExtension);
});
