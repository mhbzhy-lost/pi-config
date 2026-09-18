#!/usr/bin/env node
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFile as execFileCallback } from "node:child_process";
import { access, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { homedir, tmpdir } from "node:os";
import { discoverManagedSkills } from "../src/skill-whitelist/skill.ts";
import { auditManagedWorkspaces } from "../packages/pi-subagents-enhanced/src/workspace/administration.ts";
import { verifyOrderedModelsRuntimePatch } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/ordered-models-runtime-patch.ts";
import { TYPED_SUBAGENT_PARAMETERS } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts";
import { compileCodingDispatchIR } from "../packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts";
import { assertRunAuthorization, createRunAuthorization } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/run-authorization.ts";
import { RootBrokerServer } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts";
import { createManagedWorkspaceService } from "../packages/pi-subagents-enhanced/src/workspace/service.ts";

const execFile = promisify(execFileCallback);

const SUPPORTED_PI_VERSIONS = ["0.82.0", "0.82.1", "0.83.0", "0.84.1", "0.84.2", "0.84.3", "0.84.4", "0.85.1"];
const PI_SUBAGENTS_VERSION = "0.62.0";
const ENHANCED_SUBAGENTS_VERSION = "0.1.0";
const ENHANCED_SUBAGENTS_SOURCE = "../packages/pi-subagents-enhanced";
const TYPEBOX_VERSION = "1.1.38";
const TASK_SCHEDULER_PACKAGES = {
  "@amaster.ai/pi-task-scheduler": "0.1.9",
  "@amaster.ai/pi-shared": "0.1.9",
  croner: "10.0.1",
};
const BASIC_MEMORY_VERSION = "0.22.1";
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
  "packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts",
  "packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-client.ts",
  "packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-protocol.ts",
  "packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-registry.ts",
  "packages/pi-subagents-enhanced/child-extensions/root-session-owner.ts",
];
const LEGACY_SUBAGENT_ENTRIES = [
  "pi/extensions/subagent-runtime.ts",
  "pi/extensions/custom-footer.ts",
  "pi/extensions/lib/pi-subagents-browser-adapter.ts",
  "pi/extensions/lib/subagent-native-conversation.ts",
  "pi/extensions/lib/subagent-session-browser.ts",
  "pi/extensions/lib/subagent-session-viewport.ts",
];
const FORBIDDEN_LOCAL_PI_PEERS = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
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

function hasDisabledTaskSchedulerResources(settings) {
  return hasDisabledPackageResources(settings, "npm:@amaster.ai/pi-task-scheduler@0.1.9");
}

export async function inspectSubagentRuntime({ requests = [], discovery, cwd = process.cwd() }: { requests?: any[]; discovery?: any; cwd?: string } = {}) {
  const issues = [];
  const { Compile } = await import(pathToFileURL(createRequire(new URL("../pi/npm/package.json", import.meta.url)).resolve("typebox/compile")).href);
  const validator = Compile(TYPED_SUBAGENT_PARAMETERS);
  const available = Array.isArray(discovery?.agents) && discovery.agents.every((agent) => typeof agent?.name === "string");
  if (requests.length && !available) issues.push("PROFILE_DISCOVERY_UNAVAILABLE");
  for (const request of requests) {
    try {
      if (!validator.Check(request)) throw new Error("invalid subagent call structure");
      if (request.version === "dispatch-ir.v1") compileCodingDispatchIR(request, { cwd });
      if (typeof request.agent !== "string") throw new Error("dispatch request must identify a profile");
      if (available && !discovery.agents.some((agent) => agent.name === request.agent)) issues.push(`PROFILE_NOT_DISCOVERED: ${request.agent}`);
    } catch (error) {
      issues.push(`SUBAGENT_CALL_INVALID: ${error.message}`);
    }
  }
  // 只探测 standalone 矩阵；profile 和不可信 frontmatter 不参与授权输入。
  for (const kind of ["coding", "generic"] as const) {
    try {
      const authorization = createRunAuthorization({ kind, binding: { runId: "doctor", asyncDir: resolve(cwd), sessionId: "doctor", pid: process.pid, agentProfile: "doctor-profile" }, goal: null });
      assertRunAuthorization(authorization);
      const expected = kind === "coding" ? ["root.subscribe"] : [];
      if (JSON.stringify(authorization.capabilities) !== JSON.stringify(expected)) throw new Error("noncanonical capabilities");
    } catch (error) {
      issues.push(`RUN_AUTHORIZATION_INVALID: ${error.message}`);
    }
  }
  return issues;
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

export async function inspectWorktreeLifecycle(repoRoot, { stateRoot = process.env.PI_CODING_WORKSPACE_DIR ?? join(repoRoot, "var", "workspaces") } = {}) {
  return auditManagedWorkspaces({ stateRoot, originRoot: repoRoot });
}

export function inspectCoordinatorDoctor(report: any) {
  const issues: string[] = [];
  if (!report || report.schemaVersion !== "managed-workspace-administration.v1") return ["coordinator audit schema is unknown"];
  const coordinator = report.coordinator ?? {};
  if (coordinator.status === "observed" && coordinator.protocol !== "repository-workspace-coordinator.v1") issues.push("coordinator protocol is unknown");
  if (coordinator.status === "stale") issues.push("coordinator singleton identity is stale");
  for (const debt of report.debts ?? []) {
    if (debt.kind === "state-root-split-brain") issues.push("coordinator state-root split-brain detected");
    else if (debt.kind === "queue-schema") issues.push("integration queue schema is unknown");
    else if (["proof", "delivery", "cleanup"].includes(debt.kind)) issues.push(`${debt.kind} debt remains unresolved`);
    else if (debt.status === "migration-debt") issues.push(`${debt.kind} migration debt requires manual review`);
    else if (debt.kind === "coordinator-metadata") issues.push("coordinator metadata schema is unknown");
  }
  return [...new Set(issues)];
}

export function formatWorktreeLifecycleWarnings(report) {
  if (!report || typeof report !== "object") return [];
  const inventory = report.inventory ?? report;
  const escapeSingleLine = (value) => String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) => {
    const escapes = { "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r" };
    return escapes[character] ?? `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
  const warnings = [];
  for (const entry of Array.isArray(inventory.workspaces) ? inventory.workspaces : []) {
    const receipt = entry?.receipt;
    if (!receipt || typeof receipt !== "object") continue;
    const workspaceId = typeof receipt.workspaceId === "string" ? receipt.workspaceId : "unknown";
    const path = typeof receipt.path === "string" ? escapeSingleLine(receipt.path) : "";
    const stateCode = {
      active: "MANAGED_WORKSPACE_ACTIVE",
      preserved: "MANAGED_WORKSPACE_PRESERVED",
      "cleanup-debt": "MANAGED_WORKSPACE_CLEANUP_DEBT",
    }[receipt.state];
    if (stateCode) warnings.push(`[warning] ${stateCode} ${workspaceId} ${path}`.trimEnd());
    if (entry.identity === false) warnings.push(`[warning] MANAGED_WORKSPACE_IDENTITY_MISMATCH ${workspaceId} ${path}`.trimEnd());
  }
  for (const entry of Array.isArray(inventory.orphanRegistrations) ? inventory.orphanRegistrations : []) {
    const path = typeof entry?.path === "string" ? escapeSingleLine(entry.path) : "";
    warnings.push(`[warning] MANAGED_WORKSPACE_ORPHAN_REGISTRATION ${path}`.trimEnd());
  }
  for (const entry of Array.isArray(inventory.legacy) ? inventory.legacy : []) {
    if (entry?.status !== "untrusted-legacy") continue;
    const path = typeof entry.path === "string" ? escapeSingleLine(entry.path) : "";
    warnings.push(`[warning] MANAGED_WORKSPACE_UNTRUSTED_LEGACY ${path}`.trimEnd());
  }
  return warnings;
}

export async function inspectConfiguration(repoRoot, options = {}) {
  const issues = [];
  if (options.coordinatorAudit) issues.push(...inspectCoordinatorDoctor(options.coordinatorAudit));
  issues.push(...await inspectSubagentRuntime({ cwd: repoRoot, requests: options.subagentRequests, discovery: options.subagentDiscovery }));
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
      issues.push(`${globalSkillsLabel}/${name} is missing (run: node scripts/sync-skills.ts)`);
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
    const sources = (settings?.packages ?? []).map(packageSource);
    if (sources.filter((source) => source === ENHANCED_SUBAGENTS_SOURCE).length !== 1) issues.push("pi-subagents-enhanced local package source must be uniquely configured");
    if (sources.some((source) => /^npm:pi-subagents(?:@|$)/.test(source ?? ""))) issues.push("standalone pi-subagents package source is forbidden");
    if (!hasDisabledTaskSchedulerResources(settings)) {
      issues.push("task scheduler package resources must all be disabled");
    }
  } catch {
    issues.push("pi-subagents-enhanced local package source must be uniquely configured");
    issues.push("task scheduler package resources must all be disabled");
  }

  for (const legacy of LEGACY_SUBAGENT_ENTRIES) {
    try {
      await access(join(repoRoot, legacy));
      issues.push(`duplicate auto-discovered subagent entry still exists: ${legacy}`);
    } catch {}
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

  const enhancedPackageRoot = join(repoRoot, "packages", "pi-subagents-enhanced");
  const enhancedPackagePath = join(enhancedPackageRoot, "package.json");
  try {
    const metadata = JSON.parse(await readFile(enhancedPackagePath, "utf8"));
    if (metadata.name !== "pi-subagents-enhanced" || metadata.version !== ENHANCED_SUBAGENTS_VERSION) {
      issues.push(`unexpected enhanced package identity: ${metadata.name ?? "unknown"}@${metadata.version ?? "unknown"}; expected pi-subagents-enhanced@${ENHANCED_SUBAGENTS_VERSION}`);
    }
    const expectedEntries = ["./extensions/subagent-runtime.ts", "./extensions/custom-footer.ts"];
    if (JSON.stringify(metadata.pi?.extensions) !== JSON.stringify(expectedEntries)) {
      issues.push("pi-subagents-enhanced extension entries are invalid");
    } else {
      for (const entry of expectedEntries) await access(resolve(enhancedPackageRoot, entry), constants.R_OK);
    }
  } catch (error) {
    issues.push(`pi-subagents-enhanced manifest or extension entry is unavailable: ${error.message}`);
  }
  for (const peer of FORBIDDEN_LOCAL_PI_PEERS) {
    try {
      await lstat(join(enhancedPackageRoot, "node_modules", ...peer.split("/")));
      issues.push(`pi-subagents-enhanced contains a package-local Pi core peer: ${peer}`);
    } catch (error) {
      if (error?.code !== "ENOENT") issues.push(`unable to inspect pi-subagents-enhanced peer ownership: ${peer}: ${error.message}`);
    }
  }

  const packageRoot = join(enhancedPackageRoot, "node_modules", "pi-subagents");
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

  const typeboxRoot = join(packageRoot, "node_modules", "typebox");
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
  try {
    const piNpmMetadata = JSON.parse(await readFile(piNpmPackagePath, "utf8"));
    for (const dependency of ["pi-subagents", "typebox"]) {
      if (Object.hasOwn(piNpmMetadata.dependencies ?? {}, dependency)) issues.push(`pi/npm must not directly depend on ${dependency}`);
    }
  } catch (error) {
    issues.push(`pi/npm package metadata is unavailable: ${error.message}`);
  }
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
    const lifecycle = await inspectWorktreeLifecycle(repoRoot);
    const issues = await inspectConfiguration(repoRoot, { coordinatorAudit: lifecycle });
    for (const warning of formatWorktreeLifecycleWarnings(lifecycle)) console.warn(warning);
    if (issues.length === 0) {
      console.log("[ok] Pi Skill allowlist extension is ready");
      console.log("[ok] Root subagent broker: ready");
      console.log("[info] Subagent profile discovery: not requested (requires Host discovery)");
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
