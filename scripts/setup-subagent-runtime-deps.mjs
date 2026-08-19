import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { applyOrderedModelsRuntimePatch } from "./lib/subagent-dispatch/ordered-models-runtime-patch.mjs";

const execFile = promisify(execFileCallback);
const scriptPath = fileURLToPath(import.meta.url);

export function buildSubagentRuntimeInstallCommand(piNpmDir) {
  return {
    command: "npm",
    args: [
      "install", "--prefix", piNpmDir, "--save-exact",
      "pi-subagents@0.45.2", "typebox@1.1.38",
    ],
  };
}

export function buildTaskSchedulerInstallCommand(piNpmDir) {
  return {
    command: "npm",
    args: [
      "install", "--prefix", piNpmDir, "--save-exact",
      "@amaster.ai/pi-task-scheduler@0.1.9", "@amaster.ai/pi-shared@0.1.9", "croner@10.0.1",
    ],
  };
}

export async function installSubagentRuntimeDependencies({
  piNpmDir = resolve(import.meta.dirname, "../pi/npm"),
  env = process.env,
  run = execFile,
  patchSubagentRuntime = applyOrderedModelsRuntimePatch,
} = {}) {
  await run("npm", ["uninstall", "--prefix", piNpmDir, "@juicesharp/rpiv-todo"], { env });
  const subagentInstall = buildSubagentRuntimeInstallCommand(piNpmDir);
  await run(subagentInstall.command, subagentInstall.args, { env });
  await patchSubagentRuntime(resolve(piNpmDir, "node_modules/pi-subagents"));
  const schedulerInstall = buildTaskSchedulerInstallCommand(piNpmDir);
  await run(schedulerInstall.command, schedulerInstall.args, { env });
  return { piNpmDir };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const { piNpmDir } = await installSubagentRuntimeDependencies();
  process.stdout.write(`Subagent runtime dependencies installed in ${piNpmDir}\n`);
}
