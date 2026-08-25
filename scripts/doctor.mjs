#!/usr/bin/env node
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFile as execFileCallback } from "node:child_process";
import { access, lstat, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { discoverManagedSkills } from "./lib/skill-whitelist.mjs";
import { createGoalEngineExtension } from "./lib/goal-engine/extension.mjs";
import { generationCapabilities } from "./lib/goal-engine/generation-capabilities.mjs";
import { normalizeRuntimeGoalInit } from "./lib/goal-engine/obligation-contract.mjs";
import { createRuntimeActivationChallenge } from "./lib/goal-engine/human-decision.mjs";
import { prepareManagedValidation, startManagedValidation, inspectManagedValidation, recoverManagedValidation, releaseManagedValidation } from "./lib/goal-engine/managed-validation.mjs";
import { captureCurrentWorld } from "./lib/goal-engine/current-world.mjs";
import { evaluateConditionGraph } from "./lib/goal-engine/condition-validity.mjs";
import { deriveFindingFromFailedEvidence, openRepairEpisode } from "./lib/goal-engine/repair-policy.mjs";
import { buildSuspensionPlan, suspensionGuard } from "./lib/goal-engine/suspension.mjs";
import { finalizeGoal, buildObligationFinalizationManifest } from "./lib/goal-engine/finalization.mjs";
import { runRecoverableFinalReview } from "./lib/goal-engine/final-review.mjs";
import { loadFinalizationProjection } from "./lib/goal-engine/store.mjs";
import { auditGoalContractIntegrity } from "./lib/goal-contract/authorization-audit.mjs";
import { reconcileManagedWorktrees } from "./lib/worktree-lifecycle/inventory.mjs";
import { verifyOrderedModelsRuntimePatch } from "./lib/subagent-dispatch/ordered-models-runtime-patch.mjs";

const execFile = promisify(execFileCallback);

const SUPPORTED_PI_VERSIONS = ["0.82.0", "0.82.1", "0.83.0", "0.84.1", "0.84.2", "0.84.3"];
const PI_SUBAGENTS_VERSION = "0.45.2";
const TYPEBOX_VERSION = "1.1.38";
const TASK_SCHEDULER_PACKAGES = {
  "@amaster.ai/pi-task-scheduler": "0.1.9",
  "@amaster.ai/pi-shared": "0.1.9",
  croner: "10.0.1",
};
const BASIC_MEMORY_VERSION = "0.22.1";
const REQUIRED_PROFILES = {
  executor: { orderedModels: true, subagent: false, extensions: undefined },
};
const LEGACY_RUNTIME_FILES = [
  "scripts/lib/runtime/spawn.mjs",
  "scripts/lib/runtime/monitor.mjs",
  "scripts/lib/runtime/control.mjs",
  "scripts/lib/runtime/stream.mjs",
  "scripts/lib/runtime/index.mjs",
];
const REQUIRED_RPC_METHODS = ["ping", "status", "spawn", "steer", "interrupt", "stop", "resume"];
const GOAL_ENGINE_TOOL_NAMES = [
  "goal_init",
  "goal_status",
  "goal_dispatch",
  "goal_settle",
  "goal_accept",
  "goal_amend",
  "goal_integrate",
  "goal_finalize",
];
const GOAL_ENGINE_TOOL_SET = new Set(GOAL_ENGINE_TOOL_NAMES);
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

const runtimeBoundaryIssue = (code, message) => `${code}: ${message}`;

function defaultGoalRuntimeBoundaryFactory() {
  return {
    generationCapabilities,
    normalizeRuntimeGoalInit,
    createRuntimeActivationChallenge,
    managedValidation: { prepareManagedValidation, startManagedValidation, inspectManagedValidation, recoverManagedValidation, releaseManagedValidation },
    currentWorld: { captureCurrentWorld, evaluateConditionGraph },
    repair: { deriveFindingFromFailedEvidence, openRepairEpisode },
    suspension: { buildSuspensionPlan, suspensionGuard },
    finalization: { finalizeGoal, buildObligationFinalizationManifest },
    finalReview: { runRecoverableFinalReview },
    store: { loadFinalizationProjection },
  };
}

export function inspectGoalRuntimeBoundaries({ goalRuntimeBoundaryFactory = defaultGoalRuntimeBoundaryFactory } = {}) {
  let runtime;
  try { runtime = goalRuntimeBoundaryFactory(); } catch { return [runtimeBoundaryIssue("GOAL_RUNTIME_FACTORY", "runtime capability factory failed")]; }
  const issues = [];
  const missing = (code, owner, names) => {
    for (const name of names) if (typeof owner?.[name] !== "function") issues.push(runtimeBoundaryIssue(code, `missing ${name}`));
  };
  try {
    const planned = runtime.generationCapabilities("planned.v1");
    const goalRuntime = runtime.generationCapabilities("goal-runtime.v1");
    if (planned?.taskContract !== "criteria-only" || planned?.executorBinding !== "strict" || planned?.settlement !== "dual-path" || planned?.completion !== "accept-auto" || goalRuntime?.taskContract !== "criteria-only" || goalRuntime?.executorBinding !== "strict" || goalRuntime?.settlement !== "dual-path" || goalRuntime?.completion !== "goal-finalize" || goalRuntime?.conditions !== true || goalRuntime?.executionRevision !== true) throw new Error("forged");
  } catch { issues.push(runtimeBoundaryIssue("GOAL_RUNTIME_GENERATION_CAPABILITIES", "planned.v1 must retain strict accept-auto and runtime must require goal-finalize")); }
  const draft = { objective: "doctor probe", execution: { schema: "goal-runtime.v1", tasks: [], conditions: [], write_policy: { allowed_paths: [] }, budgets: { max_observations: 0, max_repairs: 0, max_elapsed_minutes: 0, max_no_progress: 0 } } };
  try {
    if (typeof runtime.normalizeRuntimeGoalInit !== "function") throw new Error("missing");
    for (const rejected of [{ ...draft, profile: "caller" }, { ...draft, command: "unsafe" }, draft]) {
      let rejectedInput = false;
      try { runtime.normalizeRuntimeGoalInit(rejected, {}); } catch { rejectedInput = true; }
      if (!rejectedInput) throw new Error("forged");
    }
  } catch { issues.push(runtimeBoundaryIssue("GOAL_RUNTIME_CONTRACT_AUTHORITY", "runtime contract must require an obligation and reject caller profile or command")); }
  try {
    if (runtime.createRuntimeActivationChallenge({ goalId: "doctor", contractHash: "0".repeat(64), baseHead: "0".repeat(40), sessionId: "doctor", proposalId: "doctor" })?.kind !== "runtime_activation_approval") throw new Error("forged");
  } catch { issues.push(runtimeBoundaryIssue("GOAL_RUNTIME_DRAFT_APPROVAL", "missing runtime draft approval boundary")); }
  missing("GOAL_RUNTIME_MANAGED_VALIDATION_RECOVERY", runtime.managedValidation, ["prepareManagedValidation", "startManagedValidation", "inspectManagedValidation", "recoverManagedValidation", "releaseManagedValidation"]);
  missing("GOAL_RUNTIME_CURRENT_WORLD", runtime.currentWorld, ["captureCurrentWorld", "evaluateConditionGraph"]);
  missing("GOAL_RUNTIME_FINDING_REPAIR_SUSPEND", runtime.repair, ["deriveFindingFromFailedEvidence", "openRepairEpisode"]);
  missing("GOAL_RUNTIME_FINDING_REPAIR_SUSPEND", runtime.suspension, ["buildSuspensionPlan", "suspensionGuard"]);
  try { runtime.finalization?.finalizeGoal({ eventSchemaVersion: "planned.v1" }); throw new Error("forged"); } catch (error) { if (!String(error?.message).includes("FINALIZATION_UNSUPPORTED_GENERATION")) issues.push(runtimeBoundaryIssue("GOAL_RUNTIME_FINALIZATION", "planned finalization must be rejected")); }
  missing("GOAL_RUNTIME_FINALIZATION", runtime.finalization, ["buildObligationFinalizationManifest"]);
  missing("GOAL_RUNTIME_FINALIZATION", runtime.finalReview, ["runRecoverableFinalReview"]);
  missing("GOAL_RUNTIME_FINALIZATION", runtime.store, ["loadFinalizationProjection"]);
  return issues;
}

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

function hasDisabledPackageResources(settings, source) {
  const entry = settings?.packages?.find((candidate) => packageSource(candidate) === source);
  return Boolean(
    entry
    && typeof entry === "object"
    && ["extensions", "skills", "prompts", "themes"].every(
      (resource) => Array.isArray(entry[resource]) && entry[resource].length === 0,
    ),
  );
}

function hasDisabledSubagentResources(settings) {
  return hasDisabledPackageResources(settings, `npm:pi-subagents@${PI_SUBAGENTS_VERSION}`);
}

function hasDisabledTaskSchedulerResources(settings) {
  return hasDisabledPackageResources(settings, "npm:@amaster.ai/pi-task-scheduler@0.1.9");
}

function parseFrontmatter(content) {
  const match = content?.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const result = {};
  let currentKey;
  for (const line of match[1].split("\n")) {
    const field = line.match(/^([\w-]+):(?:\s+(.*))?$/);
    if (field) {
      currentKey = field[1];
      result[currentKey] = field[2] ?? "";
      continue;
    }
    if (currentKey && /^\s+/.test(line)) {
      result[currentKey] += `${result[currentKey] ? "\n" : ""}${line.trim()}`;
    }
  }
  return result;
}

function parseOrderedModels(value) {
  if (typeof value !== "string") return [];
  return value.split("\n").map((line) => line.trim().replace(/^-\s+/, "")).filter(Boolean);
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

export async function inspectWorktreeLifecycle(repoRoot) {
  return reconcileManagedWorktrees({ originRoot: repoRoot });
}

export function formatWorktreeLifecycleWarnings(report) {
  if (!report || typeof report !== "object" || !Array.isArray(report.items)) return [];
  const escapeSingleLine = (value) => String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) => {
    const escapes = { "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r" };
    return escapes[character] ?? `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
  const warnings = [];
  for (const item of report.items) {
    if (!item || typeof item !== "object" || item.code == null || typeof item.code !== "string") continue;
    const resources = typeof item.resources === "string" ? item.resources : "";
    const path = typeof item.path === "string" ? escapeSingleLine(item.path) : "";
    warnings.push(`[warning] ${item.code} ${resources} ${path}`.trimEnd());
  }
  return warnings;
}

export async function inspectConfiguration(repoRoot, options = {}) {
  const issues = [];
  issues.push(...await inspectGoalContractIntegrity(repoRoot));
  issues.push(...inspectGoalRuntimeBoundaries({ goalRuntimeBoundaryFactory: options.goalRuntimeBoundaryFactory }));
  let desired = new Map();
  try {
    desired = await discoverManagedSkills(repoRoot);
  } catch (error) {
    issues.push(error.message);
  }

  const defaultGlobalSkillsDir = join(homedir(), ".agents", "skills");
  const globalSkillsDir = options.globalSkillsDir ?? defaultGlobalSkillsDir;
  const globalSkillsLabel = globalSkillsDir === defaultGlobalSkillsDir ? "~/.agents/skills" : globalSkillsDir;
  for (const [name, source] of desired) {
    try {
      await access(join(source, "SKILL.md"), constants.R_OK);
    } catch {
      issues.push(`unreadable allowlisted skill: ${name}`);
    }
    const linkPath = join(globalSkillsDir, name);
    try {
      const stats = await lstat(linkPath);
      if (!stats.isSymbolicLink()) {
        issues.push(`${globalSkillsLabel}/${name} exists but is not a symlink`);
      }
    } catch {
      issues.push(`${globalSkillsLabel}/${name} is missing (run: node scripts/sync-skills.mjs)`);
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
    if (!hasDisabledTaskSchedulerResources(settings)) {
      issues.push("task scheduler package resources must all be disabled");
    }
  } catch {
    issues.push("pi-subagents package resources must all be disabled");
    issues.push("task scheduler package resources must all be disabled");
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
    if (expected.orderedModels) {
      const models = parseOrderedModels(profile.models);
      if (models.length === 0 || new Set(models).size !== models.length) issues.push(`invalid ${name} ordered models`);
      if (Object.hasOwn(profile, "model") || Object.hasOwn(profile, "fallbackModels")) issues.push(`legacy ${name} model routing fields are forbidden`);
    }
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
      issues.push(`legacy generic subagent runtime still exists: ${legacy}`);
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
      try {
        await verifyOrderedModelsRuntimePatch(packageRoot);
      } catch (error) {
        issues.push(`pi-subagents ordered models patch is unavailable: ${error.message}`);
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

  const piNpmPackagePath = join(repoRoot, "pi", "npm", "package.json");
  const piNpmRequire = createRequire(piNpmPackagePath);
  for (const [name, version] of Object.entries(TASK_SCHEDULER_PACKAGES)) {
    const packagePath = join(repoRoot, "pi", "npm", "node_modules", ...name.split("/"), "package.json");
    try {
      const metadata = JSON.parse(await readFile(packagePath, "utf8"));
      if (metadata.version !== version) {
        issues.push(`unexpected Pi package: ${name}@${metadata.version ?? "unknown"}; expected ${version}`);
        continue;
      }
      try {
        piNpmRequire.resolve(name);
      } catch (error) {
        issues.push(`Pi package entry is not resolvable: ${name}@${version}: ${error.message}`);
      }
    } catch {
      issues.push(`missing Pi package: ${name}@${version}`);
    }
  }

  const goalEngineFactory = options.goalEngineFactory ?? createGoalEngineExtension;
  const goalEngineToolDefinitions = [];
  const goalEnginePi = {
    registerTool(definition) {
      goalEngineToolDefinitions.push(definition);
    },
    on() {},
  };

  let goalEngineFactoryFailed = false;
  try {
    await Promise.resolve(goalEngineFactory(goalEnginePi));
  } catch {
    issues.push("invalid Goal Engine tool ABI: factory");
    goalEngineFactoryFailed = true;
  }

  if (!goalEngineFactoryFailed) {
    const invalidTools = new Set();
    const seenTools = new Set();
    const registeredTools = new Set();

    for (const definition of goalEngineToolDefinitions) {
      const name = typeof definition?.name === "string" ? definition.name : String(definition?.name);
      if (seenTools.has(name)) {
        invalidTools.add(name);
      } else {
        seenTools.add(name);
      }

      if (typeof definition !== "object" || definition === null || typeof definition?.name !== "string") {
        invalidTools.add(name);
        continue;
      }

      if (Object.prototype.hasOwnProperty.call(definition, "handler")) {
        invalidTools.add(name);
      }
      if (typeof definition.execute !== "function") {
        invalidTools.add(name);
      }
      registeredTools.add(name);
    }

    for (const required of GOAL_ENGINE_TOOL_NAMES) {
      if (!registeredTools.has(required)) {
        invalidTools.add(required);
      }
    }

    for (const name of registeredTools) {
      if (!GOAL_ENGINE_TOOL_SET.has(name)) {
        invalidTools.add(name);
      }
    }

    for (const name of invalidTools) {
      issues.push(`invalid Goal Engine tool ABI: ${name}`);
    }
  }

  return issues;
}

const LIMITATIONS = [
  "limitation: an unbound RPC dispatch that cannot be uniquely reconciled enters dispatch_uncertain and is never spawned again automatically",
  "limitation: formatted RPC status text is diagnostic only; task lifecycle uses event, Git, and official artifact facts",
];

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const issues = await inspectConfiguration(repoRoot);
    const lifecycle = await inspectWorktreeLifecycle(repoRoot);
    for (const warning of formatWorktreeLifecycleWarnings(lifecycle)) console.warn(warning);
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
