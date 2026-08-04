import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { addSkill, createFixture } from "./helpers/skill-fixture.mjs";
import { loadDesiredSkills, parseSkillList, resolveSkillSource } from "../scripts/lib/skill-whitelist.mjs";

const execFile = promisify(execFileCallback);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

async function listTrackedPaths(paths) {
  try {
    const { stdout } = await execFile("git", ["ls-files", "--", ...paths], {
      cwd: repoRoot,
      maxBuffer: 512 * 1024,
    });
    return stdout;
  } catch (error) {
    throw new Error(`cannot inspect the Git index for local-only Skills: ${error.message}`, {
      cause: error,
    });
  }
}

test("parseSkillList strips comments while preserving order", () => {
  const result = parseSkillList("# comment\nsystematic-debugging # selected\n\nwriting-plans\n");
  assert.deepEqual(result, ["systematic-debugging", "writing-plans"]);
});

test("parseSkillList rejects duplicates", () => {
  assert.throws(
    () => parseSkillList("writing-plans\nwriting-plans\n"),
    /duplicate skill: writing-plans/,
  );
});

test("parseSkillList rejects names outside the Agent Skills naming subset", () => {
  for (const name of ["../escape", "Writing-Plans", "writing_plans", "-writing", "writing--plans"]) {
    assert.throws(() => parseSkillList(`${name}\n`), /invalid skill name/);
  }
});

test("loadDesiredSkills ignores a missing optional local list", async () => {
  const root = await createFixture();
  try {
    await addSkill(root, "vendor", "writing-plans");
    const globalList = join(root, "skill-overrides", "skills.list");
    await writeFile(globalList, "writing-plans\n");

    const result = await loadDesiredSkills(root, globalList, join(root, "skill-overrides", "skills.local.list"));

    assert.deepEqual([...result.keys()], ["writing-plans"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadDesiredSkills fails closed for invalid, duplicate, or unreadable local lists", async () => {
  for (const [label, setup, expected] of [
    ["invalid name", async (path) => writeFile(path, "Bad_Name\n"), /invalid skill name: Bad_Name/],
    ["duplicate", async (path) => writeFile(path, "local-tool\nlocal-tool\n"), /duplicate skill: local-tool/],
    ["directory", async (path) => import("node:fs/promises").then(({ mkdir }) => mkdir(path)), /EISDIR/],
  ]) {
    const root = await createFixture();
    try {
      await addSkill(root, "vendor", "writing-plans");
      const globalList = join(root, "skill-overrides", "skills.list");
      const localList = join(root, "skill-overrides", "skills.local.list");
      await writeFile(globalList, "writing-plans\n");
      await setup(localList);

      await assert.rejects(loadDesiredSkills(root, globalList, localList), expected, label);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("loadDesiredSkills appends local Skills after the global list", async () => {
  const root = await createFixture();
  try {
    await addSkill(root, "vendor", "writing-plans");
    await addSkill(root, "local", "local-tool");
    const globalList = join(root, "skill-overrides", "skills.list");
    const localList = join(root, "skill-overrides", "skills.local.list");
    await writeFile(globalList, "writing-plans\n");
    await writeFile(localList, "local-tool\n");

    const result = await loadDesiredSkills(root, globalList, localList);

    assert.deepEqual([...result.keys()], ["writing-plans", "local-tool"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tracked Skill overrides belong to the global allowlist", async () => {
  const globalListPath = join(repoRoot, "skill-overrides", "skills.list");
  const globalNames = new Set(parseSkillList(await readFile(globalListPath, "utf8")));
  const tracked = await listTrackedPaths(["skill-overrides/*"]);
  const trackedOverrideNames = new Set(
    tracked
      .trim()
      .split("\n")
      .map((path) => path.split("/"))
      .filter((parts) => parts.length > 2)
      .map((parts) => parts[1]),
  );
  const localOnlyNames = [...trackedOverrideNames].filter((name) => !globalNames.has(name));

  assert.deepEqual(localOnlyNames, [], "tracked Skill overrides must be globally allowlisted");
});

test("resolveSkillSource prefers a local override over vendor", async () => {
  const root = await createFixture();
  try {
    await addSkill(root, "vendor", "writing-plans", "vendor");
    const local = await addSkill(root, "local", "writing-plans", "local");
    assert.equal(await resolveSkillSource(root, "writing-plans"), await realpath(local));
    assert.match(await readFile(join(local, "SKILL.md"), "utf8"), /local/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveSkillSource accepts plain and quoted single-line descriptions", async () => {
  for (const description of ["plain fixture", '"double quoted fixture"', "'single quoted fixture'"]) {
    const root = await createFixture();
    try {
      const directory = await addSkill(root, "local", "writing-plans");
      await writeFile(join(directory, "SKILL.md"), `---\nname: writing-plans\ndescription: ${description}\n---\n`);
      assert.equal(await resolveSkillSource(root, "writing-plans"), await realpath(directory));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("resolveSkillSource fails closed for malformed allowlisted Skill frontmatter", async () => {
  const cases = [
    ["missing frontmatter", "# no frontmatter\n", "missing frontmatter"],
    ["mismatched name", "---\nname: another-skill\ndescription: fixture\n---\n", "name does not match allowlisted skill"],
    ["missing description", "---\nname: writing-plans\n---\n", "missing description"],
    ["empty description", "---\nname: writing-plans\ndescription:   \n---\n", "empty description"],
    ["duplicate name", "---\nname: writing-plans\nname: writing-plans\ndescription: fixture\n---\n", "duplicate name"],
    ["duplicate description", "---\nname: writing-plans\ndescription: fixture\ndescription: again\n---\n", "duplicate description"],
    ["null description", "---\nname: writing-plans\ndescription: null\n---\n", "unsupported string scalar"],
    ["array description", "---\nname: writing-plans\ndescription: []\n---\n", "unsupported string scalar"],
    ["object description", "---\nname: writing-plans\ndescription: {}\n---\n", "unsupported string scalar"],
  ];
  for (const [label, content, reason] of cases) {
    const root = await createFixture();
    try {
      const directory = await addSkill(root, "local", "writing-plans");
      await writeFile(join(directory, "SKILL.md"), content);
      await assert.rejects(
        resolveSkillSource(root, "writing-plans"),
        new RegExp(`invalid frontmatter for allowlisted skill: writing-plans: ${reason}`),
        label,
      );
      const listPath = join(root, "skill-overrides", "skills.list");
      await writeFile(listPath, "writing-plans\n");
      await assert.rejects(
        loadDesiredSkills(root, listPath),
        new RegExp(`invalid frontmatter for allowlisted skill: writing-plans: ${reason}`),
        label,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("resolveSkillSource falls back to vendor and fails closed when absent", async () => {
  const root = await createFixture();
  try {
    const vendor = await addSkill(root, "vendor", "systematic-debugging");
    assert.equal(await resolveSkillSource(root, "systematic-debugging"), await realpath(vendor));
    await assert.rejects(
      resolveSkillSource(root, "missing-skill"),
      /missing SKILL.md for allowlisted skill: missing-skill/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveSkillSource rejects a local override that escapes its root", async () => {
  const root = await createFixture();
  const outside = await mkdtemp(join(tmpdir(), "escaped-skill-"));
  try {
    await writeFile(join(outside, "SKILL.md"), "outside");
    await symlink(outside, join(root, "skill-overrides", "writing-plans"));

    await assert.rejects(
      resolveSkillSource(root, "writing-plans"),
      /skill source escapes allowed root: writing-plans/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("resolveSkillSource rejects a vendor skill that escapes its root", async () => {
  const root = await createFixture();
  const outside = await mkdtemp(join(tmpdir(), "escaped-skill-"));
  try {
    await writeFile(join(outside, "SKILL.md"), "outside");
    await symlink(outside, join(root, "vendor", "superpowers", "skills", "writing-plans"));

    await assert.rejects(
      resolveSkillSource(root, "writing-plans"),
      /skill source escapes allowed root: writing-plans/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("local-only skill sources are not tracked", async (t) => {
  const localListPath = join(repoRoot, "skill-overrides", "skills.local.list");
  let content;
  try {
    content = await readFile(localListPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      t.skip("no local Skill list in this checkout");
      return;
    }
    throw error;
  }

  const paths = parseSkillList(content).map((name) => `skill-overrides/${name}`);
  if (paths.length === 0) {
    t.skip("local Skill list is empty");
    return;
  }

  const stdout = await listTrackedPaths(paths);

  assert.equal(stdout, "", `local-only Skill sources from ${localListPath} are tracked:\n${stdout}`);
});
