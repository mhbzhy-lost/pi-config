import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-config-skills-"));
  await mkdir(join(root, "agents"), { recursive: true });
  await mkdir(join(root, "skill-overrides"), { recursive: true });
  return root;
}

export async function addSkill(root, name, marker = name) {
  const directory = join(root, "skill-overrides", name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: fixture\n---\n\n${marker}\n`,
  );
  return directory;
}
