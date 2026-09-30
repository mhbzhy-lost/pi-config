import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const scriptPath = fileURLToPath(import.meta.url);
const packageRoot = resolve(import.meta.dirname, "..");

export async function setupRuntimeDependencies({ root = packageRoot, env = process.env, run = execFile } = {}) {
  await run("npm", ["--no-audit", "--no-fund", "install", "--prefix", root, "--ignore-scripts", "--omit=peer", "--save-exact", "pi-subagents@0.71.0"], { env });
  const upstreamRoot = resolve(root, "node_modules/pi-subagents");
  return { packageRoot: root, upstreamRoot };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const result = await setupRuntimeDependencies();
  process.stdout.write(`Prepared pi-subagents 0.71.0 in ${result.upstreamRoot}\n`);
}
