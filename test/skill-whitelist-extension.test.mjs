import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { piHostModuleUrl } from "./helpers/pi-host.mjs";
import test from "node:test";
import createSkillWhitelistExtension from "../scripts/lib/skill-whitelist-extension.mjs";
import { loadDesiredSkills, resolveSkillSource } from "../scripts/lib/skill-whitelist.mjs";

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

  const expected = [...(await loadDesiredSkills(repoRoot, join(repoRoot, "skill-overrides", "skills.list"), join(repoRoot, "skill-overrides", "skills.local.list"))).values()];
  assert.deepEqual(result.skillPaths.slice(0, expected.length), expected);
  for (const extra of result.skillPaths.slice(expected.length)) {
    assert.match(extra, /\.pi\/skills\//);
  }
});

test("resources_discover rejects a malformed local list", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-extension-"));
  try {
    await mkdir(join(root, "scripts", "lib"), { recursive: true });
    for (const name of ["skill-whitelist.mjs", "skill-whitelist-extension.mjs"]) {
      await writeFile(join(root, "scripts", "lib", name), await readFile(new URL(`../scripts/lib/${name}`, import.meta.url), "utf8"));
    }
    await mkdir(join(root, "skill-overrides", "writing-plans"), { recursive: true });
    await writeFile(join(root, "skill-overrides", "skills.list"), "writing-plans\n");
    await writeFile(join(root, "skill-overrides", "skills.local.list"), "Bad_Name\n");
    await writeFile(join(root, "skill-overrides", "writing-plans", "SKILL.md"), "---\nname: writing-plans\ndescription: fixture\n---\n");

    const { default: createFixtureExtension } = await import(`${pathToFileURL(join(root, "scripts", "lib", "skill-whitelist-extension.mjs")).href}?fixture=${Date.now()}`);
    const handlers = new Map();
    createFixtureExtension({ on(name, handler) { handlers.set(name, handler); } });
    await assert.rejects(handlers.get("resources_discover")({ cwd: root }, {}), /invalid skill name: Bad_Name/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveSkillSource and Pi loader agree on scalar fixtures, including Pi-valid ISO dates", async () => {
  const fixtures = [
    ["true", false], ["false", false], ["123", false], ["~", false],
    [".nan", false], [".inf", false], ["null", false],
    ['"true"', true], ["'123'", true], ["2026-08-05", true], ['"2026-08-05"', true], ["描述 fixture", true],
  ];
  const { loadSkillsFromDir } = await import(piHostModuleUrl);

  for (const [description, valid] of fixtures) {
    const root = await mkdtemp(join(tmpdir(), "skill-scalar-"));
    try {
      const skillPath = join(root, "skill-overrides", "writing-plans");
      await mkdir(skillPath, { recursive: true });
      await writeFile(join(skillPath, "SKILL.md"), `---\nname: writing-plans\ndescription: ${description}\n---\n`);

      if (valid) {
        assert.equal(await resolveSkillSource(root, "writing-plans"), await realpath(skillPath), description);
      } else {
        await assert.rejects(resolveSkillSource(root, "writing-plans"), /unsupported string scalar/, description);
      }

      const result = await loadSkillsFromDir({ dir: skillPath, source: "allowlist" });
      if (valid) {
        assert.equal(result.skills.length, 1, description);
        assert.equal(typeof result.skills[0].description, "string", description);
      } else {
        assert.equal(result.skills.length, 0, description);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("production discovery loads using-goal-engine through the Pi Skill loader", async () => {
  const handlers = new Map();
  createSkillWhitelistExtension({ on(name, handler) { handlers.set(name, handler); } });
  const { skillPaths } = await handlers.get("resources_discover")({ cwd: repoRoot, reason: "startup" }, {});
  const usingGoalEnginePath = skillPaths.find((path) => path.endsWith("using-goal-engine"));
  assert.ok(usingGoalEnginePath, "resources_discover must return using-goal-engine");

  const { loadSkillsFromDir } = await import(piHostModuleUrl);
  const result = await loadSkillsFromDir({ dir: usingGoalEnginePath, source: "allowlist" });
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.skills.map(({ name, description, filePath }) => ({ name, description, filePath })), [{
    name: "using-goal-engine",
    description: "Use when starting, resuming, amending, recovering, dispatching, or disposing worktrees for a multi-task Goal Engine objective.",
    filePath: join(usingGoalEnginePath, "SKILL.md"),
  }]);
});

test("Pi extension entry delegates to the tested factory", async () => {
  const entry = await import("../pi/extensions/skill-whitelist.ts");
  assert.equal(entry.default, createSkillWhitelistExtension);
});
