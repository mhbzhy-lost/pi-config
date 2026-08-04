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

function frontmatterError(name, reason) {
  return new Error(`invalid frontmatter for allowlisted skill: ${name}: ${reason}`);
}

function isSupportedDescriptionScalar(value) {
  const description = value.trim();
  if (/^"[^"\\\r\n]+"$/u.test(description) || /^'[^'\r\n]+'$/u.test(description)) return true;
  if (/^(?:~|null|true|false)$/iu.test(description)) return false;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(description)) return true;
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(description)) return false;
  if (/^[+-]?\.(?:nan|inf)$/iu.test(description)) return false;
  return /^\p{L}/u.test(description);
}

function validateSkillFrontmatter(name, content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  if (!match) throw frontmatterError(name, "missing frontmatter");

  const fields = new Map();
  for (const line of match[1].split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:\s(.*)|\s*)$/u);
    if (!field) throw frontmatterError(name, "unsupported frontmatter field");
    const [, key, value] = field;
    if (key !== "name" && key !== "description") continue;
    if (fields.has(key)) throw frontmatterError(name, `duplicate ${key}`);
    const description = value.trim();
    if (key === "description" && description && description !== '""' && description !== "''" && !isSupportedDescriptionScalar(value)) {
      throw frontmatterError(name, "unsupported string scalar");
    }
    fields.set(key, value);
  }

  if (!fields.has("name")) throw frontmatterError(name, "missing name");
  if (fields.get("name") !== name) throw frontmatterError(name, "name does not match allowlisted skill");
  if (!fields.has("description")) throw frontmatterError(name, "missing description");
  const description = fields.get("description").trim();
  if (!description || description === '""' || description === "''") {
    throw frontmatterError(name, "empty description");
  }
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
    validateSkillFrontmatter(name, await readFile(join(realCandidate, "SKILL.md"), "utf8"));
    return realCandidate;
  }

  throw new Error(`missing SKILL.md for allowlisted skill: ${name}`);
}

export async function loadDesiredSkills(repoRoot, listPath, localListPath) {
  const names = parseSkillList(await readFile(listPath, "utf8"));
  if (localListPath) {
    try {
      const localNames = parseSkillList(await readFile(localListPath, "utf8"));
      for (const name of localNames) {
        if (!names.includes(name)) names.push(name);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const desired = new Map();
  for (const name of names) {
    desired.set(name, await resolveSkillSource(repoRoot, name));
  }
  return desired;
}
