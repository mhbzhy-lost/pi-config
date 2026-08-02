#!/usr/bin/env node
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFile as execFileCallback } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { loadDesiredSkills, parseSkillList } from "./lib/skill-whitelist.mjs";
import { auditGoalContractIntegrity } from "./lib/goal-contract/authorization-audit.mjs";

const execFile = promisify(execFileCallback);

const SUPPORTED_PI_VERSIONS = ["0.82.0", "0.82.1", "0.83.0"];
const PI_SUBAGENTS_VERSION = "0.37.2";
const TYPEBOX_VERSION = "1.1.38";
const BASIC_MEMORY_VERSION = "0.22.1";
const EXPECTED_GLOBAL_SKILLS = [
  "external-llm-review",
  "git-commit-convention",
  "test-driven-development",
  "writing-skills",
  "writing-plans",
  "plan-runner-dispatch",
  "subagent-dispatch",
  "exa-search",
  "playwright",
  "browser-auth-session",
];
const REQUIRED_PROFILES = {
  executor: { model: "openai-codex/gpt-5.6-terra", subagent: false, extensions: undefined },
  spark: { model: "openai-codex/gpt-5.3-codex-spark", subagent: false, extensions: undefined },
  "plan-runner": {
    model: "openai-codex/gpt-5.6-sol",
    subagent: false,
    extensions: undefined,
    childExtension: ".pi-subagents/plan-runner-entry.mjs",
    requiredTools: ["plan_open"],
    forbiddenTools: [
      "plan_status", "plan_continue", "plan_verify", "plan_block", "plan_read_revision", "plan_amend",
      "subagent", "subagent_wait", "subagent_supervisor", "plan_executor_supervisor", "contact_supervisor",
    ],
  },
  "plan-reviewer": { model: "openai-codex/gpt-5.6-sol", subagent: false, extensions: undefined },
};
const LEGACY_RUNTIME_FILES = [
  "scripts/lib/runtime/spawn.mjs",
  "scripts/lib/runtime/monitor.mjs",
  "scripts/lib/runtime/control.mjs",
  "scripts/lib/runtime/stream.mjs",
  "scripts/lib/runtime/index.mjs",
];
const REQUIRED_RPC_METHODS = ["ping", "status", "spawn", "steer", "interrupt", "stop", "resume"];
const LEGACY_TASK7_FILES = [
  "scripts/lib/subagent-jobs.mjs",
  "scripts/lib/subagent-extension.mjs",
  "scripts/lib/subagent-agents.mjs",
  "pi/extensions/subagent.ts",
];
const ROOT_BROKER_COMPONENTS = [
  "scripts/lib/subagent-dispatch/root-broker-server.ts",
  "scripts/lib/subagent-dispatch/root-broker-client.ts",
  "scripts/lib/subagent-dispatch/root-broker-protocol.ts",
  "scripts/lib/subagent-dispatch/root-broker-registry.ts",
  "pi/child-extensions/root-session-owner.ts",
];

async function readIfExists(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function packageSource(entry) {
  return typeof entry === "string" ? entry : entry?.source;
}

function hasDisabledSubagentResources(settings) {
  const entry = settings?.packages?.find((candidate) => /^npm:pi-subagents(?:@|$)/.test(packageSource(candidate) ?? ""));
  return Boolean(
    entry
    && typeof entry === "object"
    && entry.source === `npm:pi-subagents@${PI_SUBAGENTS_VERSION}`
    && ["extensions", "skills", "prompts", "themes"].every(
      (resource) => Array.isArray(entry[resource]) && entry[resource].length === 0,
    ),
  );
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

export async function inspectGoalContractIntegrity(repoRoot) {
  const registryPath = join(repoRoot, ".state", "goal-contract", "registry.json");
  const registrySource = await readIfExists(registryPath);
  if (registrySource == null) return [];

  let registry;
  try {
    registry = JSON.parse(registrySource);
  } catch (error) {
    return [`Goal Contract registry is not valid JSON: ${error.message}`];
  }
  if (!registry?.goals || typeof registry.goals !== "object" || Array.isArray(registry.goals)) {
    return ["Goal Contract registry goals must be an object"];
  }

  const issues = [];
  for (const [goalId, entry] of Object.entries(registry.goals)) {
    const contractDir = entry?.contract_dir;
    if (typeof contractDir !== "string" || !contractDir) {
      issues.push(`Goal Contract ${goalId} has no contract_dir`);
      continue;
    }
    const goalRoot = resolve(repoRoot, contractDir);
    const relativeGoalRoot = relative(repoRoot, goalRoot);
    if (!relativeGoalRoot || relativeGoalRoot.startsWith("..") || isAbsolute(relativeGoalRoot)) {
      issues.push(`Goal Contract ${goalId} contract_dir escapes repository root`);
      continue;
    }
    try {
      for (const error of auditGoalContractIntegrity(goalRoot)) {
        issues.push(`Goal Contract ${goalId} integrity: ${error}`);
      }
    } catch (error) {
      issues.push(`Goal Contract ${goalId} integrity audit failed: ${error.message}`);
    }
  }
  return issues;
}

export async function inspectConfiguration(repoRoot, options = {}) {
  const issues = [];
  issues.push(...await inspectGoalContractIntegrity(repoRoot));
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

  const settingsSource = await readIfExists(join(repoRoot, "pi", "settings.json"));
  try {
    const settings = JSON.parse(settingsSource ?? "{}");
    if (!hasDisabledSubagentResources(settings)) {
      issues.push("pi-subagents package resources must all be disabled");
    }
  } catch {
    issues.push("pi-subagents package resources must all be disabled");
  }

  try {
    await access(join(repoRoot, "pi", "extensions", "subagent-runtime.ts"), constants.R_OK);
  } catch {
    issues.push("missing typed subagent runtime extension: pi/extensions/subagent-runtime.ts");
  }

  for (const relativeComponent of ROOT_BROKER_COMPONENTS) {
    try {
      await access(join(repoRoot, relativeComponent), constants.R_OK);
    } catch {
      issues.push(`missing Root subagent broker component: ${relativeComponent}`);
    }
  }

  const piVersion = await (options.readPiVersion ?? readInstalledPiVersion)();
  if (!SUPPORTED_PI_VERSIONS.includes(piVersion)) {
    issues.push(`unexpected Pi version: ${piVersion}; supported ${SUPPORTED_PI_VERSIONS.join(", ")}`);
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
    const tools = new Set((profile.tools ?? "").split(",").map((tool) => tool.trim()).filter(Boolean));
    if (tools.has("subagent") !== expected.subagent) issues.push(`unexpected ${name} subagent capability`);
    for (const tool of expected.requiredTools ?? []) {
      if (!tools.has(tool)) issues.push(`missing ${name} control tool: ${tool}`);
    }
    for (const tool of expected.forbiddenTools ?? []) {
      if (tools.has(tool)) issues.push(`forbidden ${name} control tool: ${tool}`);
    }
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

  for (const legacy of LEGACY_RUNTIME_FILES) {
    try {
      await access(join(repoRoot, legacy));
      issues.push(`legacy generic Plan runtime still exists: ${legacy}`);
    } catch {}
  }

  for (const relativeSource of ["coordinator.mjs", "plan-runner-dependencies.mjs", "pi-subagents-execution-backend.mjs"]) {
    const source = await readIfExists(join(repoRoot, "scripts", "lib", "plan", relativeSource));
    if (/spawnPiAgent|createMonitor|stopAgent|interruptAgent/.test(source ?? "")) {
      issues.push(`Executor production path retains legacy runtime: ${relativeSource}`);
    }
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
      const rpcSource = await readIfExists(join(packageRoot, "src", "extension", "rpc.ts"));
      if (!rpcSource) {
        issues.push("pi-subagents RPC v1 source is unavailable");
      } else {
        for (const method of REQUIRED_RPC_METHODS) {
          if (!new RegExp(`(?:^|[\\s,\\[])['\"]${method}['\"](?:[\\s,\\]]|$)`).test(rpcSource)) {
            issues.push(`pi-subagents RPC v1 method missing: ${method}`);
          }
        }
      }
    }
  } catch {
    issues.push(`missing Pi package: pi-subagents@${PI_SUBAGENTS_VERSION}`);
  }

  const typeboxRoot = join(repoRoot, "pi", "npm", "node_modules", "typebox");
  const typeboxPackagePath = join(typeboxRoot, "package.json");
  try {
    const metadata = JSON.parse(await readFile(typeboxPackagePath, "utf8"));
    if (metadata.version !== TYPEBOX_VERSION) {
      issues.push(`unexpected typebox version: ${metadata.version ?? "unknown"}; expected ${TYPEBOX_VERSION}`);
    } else {
      try {
        createRequire(packagePath).resolve("typebox/compile");
      } catch (error) {
        issues.push(`typebox/compile is not resolvable from pi-subagents: ${error.message}`);
      }
    }
  } catch {
    issues.push(`missing Pi package: typebox@${TYPEBOX_VERSION}`);
  }

  return issues;
}

const LIMITATIONS = [
  "limitation: an unbound RPC dispatch that cannot be uniquely reconciled enters dispatch_uncertain and is never spawned again automatically",
  "limitation: formatted RPC status text is diagnostic only; Plan lifecycle uses event, Git, and official artifact facts",
];

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const issues = await inspectConfiguration(repoRoot);
    if (issues.length === 0) {
      console.log("[ok] Pi Skill allowlist extension is ready");
      console.log("[ok] Root subagent broker: ready");
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
