import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-config-skills-"));
  await mkdir(join(root, "agents"), { recursive: true });
  await mkdir(join(root, "skill-overrides"), { recursive: true });
  await mkdir(join(root, "vendor", "superpowers", "skills"), { recursive: true });
  return root;
}

export async function addSkill(root, source, name, marker = source) {
  const directory = source === "local"
    ? join(root, "skill-overrides", name)
    : join(root, "vendor", "superpowers", "skills", name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: fixture\n---\n\n${marker}\n`,
  );
  return directory;
}

export async function writeSkillList(root, content) {
  const path = join(root, "agents", "skills.list");
  await writeFile(path, content);
  return path;
}
