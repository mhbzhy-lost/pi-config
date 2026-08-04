import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const execFile = promisify(execFileCallback);
const scriptPath = fileURLToPath(import.meta.url);

export function buildPlanRuntimeInstallCommand(piNpmDir) {
  return {
    command: "npm",
    args: [
      "install", "--prefix", piNpmDir, "--save-exact",
      "pi-subagents@0.37.2", "typebox@1.1.38",
    ],
  };
}

export async function installPlanRuntimeDependencies({
  piNpmDir = resolve(import.meta.dirname, "../pi/npm"),
  env = process.env,
  run = execFile,
} = {}) {
  await run("npm", ["uninstall", "--prefix", piNpmDir, "@juicesharp/rpiv-todo"], { env });
  const { command, args } = buildPlanRuntimeInstallCommand(piNpmDir);
  await run(command, args, { env });
  return { piNpmDir };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const { piNpmDir } = await installPlanRuntimeDependencies();
  process.stdout.write(`Plan runtime dependencies installed in ${piNpmDir}\n`);
}
