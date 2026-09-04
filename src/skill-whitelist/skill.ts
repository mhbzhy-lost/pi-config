import { access, readFile, readdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function frontmatterError(name, reason) {
  return new Error(`invalid frontmatter for managed skill: ${name}: ${reason}`);
}

function lexSingleLineScalar(value) {
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote === "'") {
      if (character === "'" && value[index + 1] === "'") index += 1;
      else if (character === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (character === "\\") index += 1;
      else if (character === '"') quote = null;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === "#" && index > 0 && /\s/u.test(value[index - 1])) return value.slice(0, index).trim();
  }
  return value.trim();
}

function isSupportedDescriptionScalar(description) {
  if (/^'(?:[^'\r\n]|'')*'$/u.test(description)) return true;
  if (/^"(?:[^"\\\r\n]|\\["\\/bfnrt])*"$/u.test(description)) return true;
  if (/^(?:~|null|true|false)$/iu.test(description)) return false;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(description)) return true;
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(description)) return false;
  if (/^[+-]?\.(?:nan|inf)$/iu.test(description)) return false;
  if (/:\s/u.test(description)) return false;
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
    const canonicalValue = key === "description" ? lexSingleLineScalar(value) : value;
    if (key === "description" && canonicalValue && !isSupportedDescriptionScalar(canonicalValue)) throw frontmatterError(name, "unsupported string scalar");
    fields.set(key, canonicalValue);
  }
  if (!fields.has("name")) throw frontmatterError(name, "missing name");
  if (fields.get("name") !== name) throw frontmatterError(name, "name does not match managed skill");
  if (!fields.has("description")) throw frontmatterError(name, "missing description");
  const description = fields.get("description");
  if (!description || description === '""' || description === "''") throw frontmatterError(name, "empty description");
}

export async function resolveSkillSource(repoRoot, name) {
  if (!SKILL_NAME_PATTERN.test(name)) throw new Error(`invalid managed skill directory: ${name}`);
  const sourceRoot = join(repoRoot, "skill-overrides");
  const candidate = join(sourceRoot, name);
  let realRoot;
  let realCandidate;
  let realSkill;
  try {
    [realRoot, realCandidate, realSkill] = await Promise.all([
      realpath(sourceRoot), realpath(candidate), realpath(join(candidate, "SKILL.md")),
    ]);
    await access(realSkill, constants.R_OK);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`missing SKILL.md for managed skill: ${name}`);
    throw error;
  }
  if (realCandidate !== resolve(realRoot, name) || realSkill !== join(realCandidate, "SKILL.md")) {
    throw new Error(`skill source escapes allowed root: ${name}`);
  }
  validateSkillFrontmatter(name, await readFile(realSkill, "utf8"));
  return realCandidate;
}

export async function discoverManagedSkills(repoRoot) {
  const sourceRoot = join(repoRoot, "skill-overrides");
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  const names = entries
    .filter((entry) => !entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink()))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"));
  const desired = new Map();
  for (const name of names) desired.set(name, await resolveSkillSource(repoRoot, name));
  return desired;
}
