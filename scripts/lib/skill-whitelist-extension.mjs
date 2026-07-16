import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { loadDesiredSkills } from "./skill-whitelist.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const listPath = join(repoRoot, "skill-overrides", "skills.list");

export default function createSkillWhitelistExtension(pi) {
  pi.on("resources_discover", async () => {
    const desired = await loadDesiredSkills(repoRoot, listPath);
    return { skillPaths: [...desired.values()] };
  });
}
