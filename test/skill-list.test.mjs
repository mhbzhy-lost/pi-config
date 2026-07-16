import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { addSkill, createFixture, writeSkillList } from "./helpers/skill-fixture.mjs";
import { parseSkillList, resolveSkillSource } from "../scripts/lib/skill-whitelist.mjs";

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
