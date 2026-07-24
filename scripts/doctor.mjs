#!/usr/bin/env node
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFile as execFileCallback } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { loadDesiredSkills, parseSkillList } from "./lib/skill-whitelist.mjs";

const execFile = promisify(execFileCallback);

const PI_VERSION = "0.80.10";
const PI_SUBAGENTS_VERSION = "0.34.0";
const BASIC_MEMORY_VERSION = "0.22.1";
const EXPECTED_GLOBAL_SKILLS = [
  "external-llm-review",
  "git-commit-convention",
  "systematic-debugging",
  "test-driven-development",
  "receiving-code-review",
  "writing-skills",
  "writing-plans",
  "plan-runner-dispatch",
  "exa-search",
  "playwright",
];
const REQUIRED_PROFILES = {
  executor: { model: "codex-pool/gpt-5.6-terra", subagent: false, extensions: undefined },
  spark: { model: "codex-pool/gpt-5.3-codex-spark", subagent: false, extensions: undefined },
  "plan-runner": { model: "codex-pool/gpt-5.6-sol", subagent: true, extensions: undefined, childExtension: ".pi-subagents/plan-runner-entry.mjs" },
  "plan-reviewer": { model: "codex-pool/gpt-5.6-sol", subagent: false, extensions: undefined },
};
const LEGACY_TASK7_FILES = [
  "scripts/lib/subagent-jobs.mjs",
  "scripts/lib/subagent-extension.mjs",
  "scripts/lib/subagent-agents.mjs",
  "pi/extensions/subagent.ts",
];

async function readIfExists(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function parseFrontmatter(content) {
  const match = content?.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  return Object.fromEntries(match[1].split("\n").map((line) => line.split(/:\s+/, 2)));
}

async function readInstalledBasicMemoryVersion() {
  try {
    const { stdout } = await execFile("basic-memory", ["--version"]);
    const match = stdout.trim().match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : stdout.trim();
  } catch {
    return "unknown";
  }
}

async function readInstalledPiVersion() {
  try {
    const { stdout } = await execFile(process.env.PI_REAL_BIN ?? "pi", ["--version"]);
    return stdout.trim();
  } catch {
    return "unknown";
  }
}

export async function inspectConfiguration(repoRoot, options = {}) {
  const issues = [];
  const listPath = join(repoRoot, "skill-overrides", "skills.list");
  const localListPath = join(repoRoot, "skill-overrides", "skills.local.list");
  const desired = await loadDesiredSkills(repoRoot, listPath, localListPath);
  const globalSkills = parseSkillList(await readFile(listPath, "utf8"));

  if (JSON.stringify(globalSkills) !== JSON.stringify(EXPECTED_GLOBAL_SKILLS)) {
    issues.push("unexpected Skill whitelist");
  }

  for (const [name, source] of desired) {
    try {
      await access(join(source, "SKILL.md"), constants.R_OK);
    } catch {
      issues.push(`unreadable allowlisted skill: ${name}`);
    }
  }

  for (const required of [
    join(repoRoot, "pi", "settings.json"),
    join(repoRoot, "pi", "extensions", "skill-whitelist.ts"),
    join(repoRoot, "scripts", "pi-shell.zsh"),
  ]) {
    try {
      await access(required, constants.R_OK);
    } catch {
      issues.push(`missing required Pi config file: ${required}`);
    }
  }

  try {
    await access(join(repoRoot, "scripts", "lib", "plan", "parent-lifecycle.mjs"), constants.R_OK);
  } catch {
    issues.push("missing Parent-owned Plan lifecycle helper");
  }

  const piVersion = await (options.readPiVersion ?? readInstalledPiVersion)();
  if (piVersion !== PI_VERSION) {
    issues.push(`unexpected Pi version: ${piVersion}; expected ${PI_VERSION}`);
  }

  const bmVersion = await (options.readBasicMemoryVersion ?? readInstalledBasicMemoryVersion)();
  if (bmVersion !== BASIC_MEMORY_VERSION) {
    issues.push(`unexpected basic-memory version: ${bmVersion}; expected ${BASIC_MEMORY_VERSION}`);
  }

  for (const [name, expected] of Object.entries(REQUIRED_PROFILES)) {
    const profile = parseFrontmatter(await readIfExists(join(repoRoot, "pi", "agents", `${name}.md`)));
    if (!profile) {
      issues.push(`missing required agent profile: ${name}`);
      continue;
    }
    if (profile.model !== expected.model) issues.push(`unexpected ${name} model: ${profile.model ?? "unknown"}; expected ${expected.model}`);
    if ((profile.tools ?? "").includes("subagent") !== expected.subagent) issues.push(`unexpected ${name} subagent capability`);
    if (profile.extensions !== expected.extensions) issues.push(`unexpected ${name} extension isolation`);
    if (expected.childExtension && profile.subagentOnlyExtensions !== expected.childExtension) issues.push(`unexpected ${name} child extension`);
  }

  for (const extension of ["plan-launcher.ts"]) {
    try {
      await access(join(repoRoot, "pi", "extensions", extension), constants.R_OK);
    } catch {
      issues.push(`missing required Plan child extension: pi/extensions/${extension}`);
    }
  }

  for (const extension of ["plan-capsule.ts", "plan-runner.ts"]) {
    try {
      await access(join(repoRoot, "pi", "child-extensions", extension), constants.R_OK);
    } catch {
      issues.push(`missing required Plan child extension: pi/child-extensions/${extension}`);
    }
  }

  const gitignore = await readIfExists(join(repoRoot, ".gitignore"));
  if (!gitignore?.split(/\r?\n/).includes("/var/")) issues.push("runtime namespace is not ignored: /var/");

  for (const legacy of LEGACY_TASK7_FILES) {
    try {
      await access(join(repoRoot, legacy));
      issues.push(`legacy Task 7 runtime still exists: ${legacy}`);
    } catch {}
  }

  try {
    await access(join(repoRoot, "pi", "skills"));
    issues.push(`unexpected auto-discovery directory: ${join(repoRoot, "pi", "skills")}`);
  } catch {}

  const packageRoot = join(repoRoot, "pi", "npm", "node_modules", "pi-subagents");
  const packagePath = join(packageRoot, "package.json");
  try {
    const packageMetadata = JSON.parse(await readFile(packagePath, "utf8"));
    if (packageMetadata.version !== PI_SUBAGENTS_VERSION) {
      issues.push(`unexpected pi-subagents version: ${packageMetadata.version ?? "unknown"}; expected ${PI_SUBAGENTS_VERSION}`);
    } else {
      try {
        const extensionEntries = packageMetadata.pi?.extensions;
        if (!Array.isArray(extensionEntries) || extensionEntries.length === 0) {
          throw new Error("package metadata does not declare pi.extensions");
        }
        for (const extensionEntry of extensionEntries) {
          if (typeof extensionEntry !== "string" || extensionEntry.length === 0) {
            throw new Error("package metadata contains an invalid pi.extensions entry");
          }
          const extensionPath = resolve(packageRoot, extensionEntry);
          const relativePath = relative(packageRoot, extensionPath);
          if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
            throw new Error(`package metadata contains an unsafe pi.extensions entry: ${extensionEntry}`);
          }
          await access(extensionPath, constants.R_OK);
        }
      } catch (error) {
        issues.push(`pi-subagents RPC probe failed: ${error.message}`);
      }
    }
  } catch {
    issues.push(`missing Pi package: pi-subagents@${PI_SUBAGENTS_VERSION}`);
  }

  return issues;
}

const LIMITATIONS = [
  "limitation: pi-subagents stable RPC v1 does not expose native resume; paused plans require safe recovery, not resume",
  "limitation: detached noninteractive Plan Runner exits after its first agent_end; compaction cannot safely continue to validated",
];

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const issues = await inspectConfiguration(repoRoot);
    if (issues.length === 0) {
      console.log("[ok] Pi Skill allowlist extension is ready");
      for (const limitation of LIMITATIONS) console.warn(`[warning] ${limitation}`);
    }
    else {
      for (const issue of issues) console.error(`[error] ${issue}`);
      for (const limitation of LIMITATIONS) console.warn(`[warning] ${limitation}`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`[error] ${error.message}`);
    process.exitCode = 1;
  }
}
