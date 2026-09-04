import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { addSkill, createFixture } from "./helpers/skill-fixture.mjs";
import { discoverManagedSkills, resolveSkillSource } from "../src/skill-whitelist/skill.ts";

const repoRoot = new URL("..", import.meta.url);

test("repository has no retired Skill list files", async () => {
  for (const file of ["skills.list", "skills.local.list"]) {
    await assert.rejects(access(new URL(`../skill-overrides/${file}`, import.meta.url)), { code: "ENOENT" });
  }
});

test("discoverManagedSkills automatically finds valid direct Skill directories in deterministic order", async () => {
  const root = await createFixture();
  try {
    await addSkill(root, "writing-plans");
    await addSkill(root, "alpha-skill");
    await mkdir(join(root, "skill-overrides", ".hidden"));
    await writeFile(join(root, "skill-overrides", "README.md"), "supporting file\n");

    const skills = await discoverManagedSkills(root);
    assert.deepEqual([...skills.keys()], ["alpha-skill", "writing-plans"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a newly added valid local Skill directory enters discovery without a second file", async () => {
  const root = await createFixture();
  try {
    await addSkill(root, "local-tool");
    assert.deepEqual([...await discoverManagedSkills(root)].map(([name]) => name), ["local-tool"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("discoverManagedSkills fails closed for malformed direct Skill directories", async () => {
  const root = await createFixture();
  try {
    const directory = await addSkill(root, "writing-plans");
    await writeFile(join(directory, "SKILL.md"), "---\nname: wrong-name\ndescription: fixture\n---\n");
    await assert.rejects(discoverManagedSkills(root), /name does not match managed skill/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("discoverManagedSkills fails closed when a direct Skill source escapes its root", async () => {
  const root = await createFixture();
  const outside = await mkdtemp(join(tmpdir(), "escaped-skill-"));
  try {
    await writeFile(join(outside, "SKILL.md"), "---\nname: writing-plans\ndescription: fixture\n---\n");
    await symlink(outside, join(root, "skill-overrides", "writing-plans"));
    await assert.rejects(discoverManagedSkills(root), /skill source escapes allowed root: writing-plans/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("resolveSkillSource retains frontmatter fail-closed validation", async () => {
  const root = await createFixture();
  try {
    const directory = await addSkill(root, "writing-plans");
    await writeFile(join(directory, "SKILL.md"), "---\nname: writing-plans\ndescription: true\n---\n");
    await assert.rejects(resolveSkillSource(root, "writing-plans"), /unsupported string scalar/);
    await writeFile(join(directory, "SKILL.md"), "---\nname: writing-plans\ndescription: fixture\n---\n");
    assert.equal(await resolveSkillSource(root, "writing-plans"), await realpath(directory));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("repository overrides are all automatically discoverable", async () => {
  const skills = await discoverManagedSkills(new URL("..", import.meta.url).pathname);
  assert.ok(skills.size > 0);
  for (const source of skills.values()) assert.match(await readFile(join(source, "SKILL.md"), "utf8"), /^---/);
});
