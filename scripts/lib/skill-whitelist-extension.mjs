import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { loadDesiredSkills } from "./skill-whitelist.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const listPath = join(repoRoot, "skill-overrides", "skills.list");
const localListPath = join(repoRoot, "skill-overrides", "skills.local.list");

async function discoverProjectSkills(cwd) {
  const skillsDir = join(cwd, ".pi", "skills");
  try {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    const paths = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (!entry.isDirectory()) continue;
      const skillPath = join(skillsDir, entry.name);
      try {
        await stat(join(skillPath, "SKILL.md"));
        paths.push(skillPath);
      } catch {
        // No SKILL.md, skip
      }
    }
    return paths;
  } catch {
    return [];
  }
}

export default function createSkillWhitelistExtension(pi) {
  pi.on("resources_discover", async (event) => {
    const desired = await loadDesiredSkills(repoRoot, listPath, localListPath);
    const skillPaths = [...desired.values()];

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
