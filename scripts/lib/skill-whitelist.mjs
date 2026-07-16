import { access, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function parseSkillList(content) {
  const names = [];
  const seen = new Set();

  for (const rawLine of content.split(/\r?\n/u)) {
    const name = rawLine.replace(/#.*$/u, "").trim();
    if (!name) continue;
    if (!SKILL_NAME_PATTERN.test(name)) {
      throw new Error(`invalid skill name: ${name}`);
    }
    if (seen.has(name)) {
      throw new Error(`duplicate skill: ${name}`);
    }
    seen.add(name);
    names.push(name);
  }

  return names;
}

async function hasReadableSkill(directory) {
  try {
    await access(join(directory, "SKILL.md"), constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveSkillSource(repoRoot, name) {
  const sources = [
    join(repoRoot, "skill-overrides"),
    join(repoRoot, "vendor", "superpowers", "skills"),
  ];

  for (const sourceRoot of sources) {
    const candidate = join(sourceRoot, name);
    if (!await hasReadableSkill(candidate)) continue;

    const [realRoot, realCandidate] = await Promise.all([realpath(sourceRoot), realpath(candidate)]);
    if (realCandidate !== resolve(realRoot, name)) {
      throw new Error(`skill source escapes allowed root: ${name}`);
    }
    return realCandidate;
  }

  throw new Error(`missing SKILL.md for allowlisted skill: ${name}`);
}

export async function loadDesiredSkills(repoRoot, listPath) {
  const names = parseSkillList(await readFile(listPath, "utf8"));
  const desired = new Map();
  for (const name of names) {
    desired.set(name, await resolveSkillSource(repoRoot, name));
  }
  return desired;
}
