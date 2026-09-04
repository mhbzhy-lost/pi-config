import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const execFile = promisify(execFileCallback);
const scriptPath = fileURLToPath(import.meta.url);
const PI_SUBAGENTS_VERSION = "0.62.0";
const defaultEnhancedPackageRoot = resolve(import.meta.dirname, "../packages/pi-subagents-enhanced");
const defaultPiNpmDir = resolve(import.meta.dirname, "../pi/npm");

async function installedSubagentVersion(enhancedPackageRoot) {
  try {
    const metadata = JSON.parse(await readFile(join(enhancedPackageRoot, "node_modules/pi-subagents/package.json"), "utf8"));
    return typeof metadata?.version === "string" && metadata.version.trim() ? metadata.version.trim() : undefined;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function assertSafeSubagentRuntimeUpgrade({ enhancedPackageRoot = defaultEnhancedPackageRoot, env = process.env } = {}) {
  const installedVersion = await installedSubagentVersion(enhancedPackageRoot);
  if (!installedVersion || installedVersion === PI_SUBAGENTS_VERSION || env.PI_ROOT_SUBAGENT_BROKER_ENABLED !== "1") return;
  const error = new Error(`Cannot upgrade pi-subagents from ${installedVersion} to ${PI_SUBAGENTS_VERSION} inside an active Pi session. Run initialization outside that session, then use a fresh Host.`);
  error.code = "SUBAGENT_RUNTIME_LIVE_UPGRADE";
  throw error;
}

export function buildTaskSchedulerInstallCommand(piNpmDir) {
  return {
    command: "npm",
    args: [
      "install", "--prefix", piNpmDir, "--omit=peer", "--save-exact",
      "@amaster.ai/pi-task-scheduler@0.1.9", "@amaster.ai/pi-shared@0.1.9", "croner@10.0.1",
    ],
  };
}

export async function installSubagentRuntimeDependencies({
  enhancedPackageRoot = defaultEnhancedPackageRoot,
  piNpmDir = defaultPiNpmDir,
  env = process.env,
  run = execFile,
} = {}) {
  await assertSafeSubagentRuntimeUpgrade({ enhancedPackageRoot, env });
  await run("npm", ["uninstall", "--prefix", piNpmDir, "@juicesharp/rpiv-todo", "pi-subagents", "typebox"], { env });
  await run("npm", ["install", "--prefix", enhancedPackageRoot, "--ignore-scripts", "--omit=peer"], { env });
  await run("npm", ["--prefix", enhancedPackageRoot, "run", "setup:runtime"], { env });
  await run("npm", ["--prefix", enhancedPackageRoot, "run", "verify:package"], { env });
  const schedulerInstall = buildTaskSchedulerInstallCommand(piNpmDir);
  await run(schedulerInstall.command, schedulerInstall.args, { env });
  return { piNpmDir, enhancedPackageRoot };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  if (process.argv.includes("--check-upgrade")) {
    await assertSafeSubagentRuntimeUpgrade();
  } else {
    const { piNpmDir, enhancedPackageRoot } = await installSubagentRuntimeDependencies();
    process.stdout.write(`Enhanced subagent runtime prepared in ${enhancedPackageRoot}; scheduler dependencies installed in ${piNpmDir}\n`);
  }
}
