import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, stat } from "node:fs/promises";

const RETIRED_SKILL_NAMES = new Set(["plan-runner-dispatch"]);

async function discoverSkillsInDir(skillsDir) {
  try {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    const paths = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".") || RETIRED_SKILL_NAMES.has(entry.name)) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skillPath = join(skillsDir, entry.name);
      try {
        const s = await stat(skillPath);
        if (!s.isDirectory()) continue;
        await stat(join(skillPath, "SKILL.md"));
        paths.push(skillPath);
      } catch {
        // Not a directory, no SKILL.md, or broken symlink — skip
      }
    }
    return paths;
  } catch {
    return [];
  }
}

async function discoverProjectSkills(cwd) {
  const results = await Promise.all([
    discoverSkillsInDir(join(cwd, ".pi", "skills")),
    discoverSkillsInDir(join(cwd, ".agents", "skills")),
  ]);
  return results.flat();
}

const globalSkillsDir = join(homedir(), ".agents", "skills");

export default function createSkillWhitelistExtension(pi) {
  pi.on("resources_discover", async (event) => {
    const skillPaths = await discoverSkillsInDir(globalSkillsDir);

    const cwd = event?.cwd;
    if (cwd) {
      const projectSkills = await discoverProjectSkills(cwd);
      for (const p of projectSkills) {
        if (!skillPaths.includes(p)) skillPaths.push(p);
      }
    }

    return { skillPaths };
  });
}
