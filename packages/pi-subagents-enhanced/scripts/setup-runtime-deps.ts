import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { bindPhysicalHostPeers } from "../src/host-runtime/index.ts";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const scriptPath = fileURLToPath(import.meta.url);
const packageRoot = resolve(import.meta.dirname, "..");

export async function setupRuntimeDependencies({ root = packageRoot, env = process.env, run = execFile } = {}) {
  await run("npm", ["--no-audit", "--no-fund", "install", "--prefix", root, "--ignore-scripts", "--omit=peer", "--save-exact", "pi-subagents@0.75.0"], { env });
  if (env.PI_HOST_ROOT) await bindPhysicalHostPeers({ enhancedPackageRoot: root, hostRoot: env.PI_HOST_ROOT });
  const upstreamRoot = resolve(root, "node_modules/pi-subagents");
  return { packageRoot: root, upstreamRoot };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const result = await setupRuntimeDependencies();
  process.stdout.write(`Prepared pi-subagents 0.75.0 in ${result.upstreamRoot}\n`);
}
