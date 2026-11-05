import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { bindPhysicalHostPeers } from "../src/host-runtime/index.ts";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const scriptPath = fileURLToPath(import.meta.url);
const packageRoot = resolve(import.meta.dirname, "..");

export async function setupRuntimeDependencies({ root = packageRoot, env = process.env, run = execFile } = {}) {
  await run("npm", ["--no-audit", "--no-fund", "install", "--prefix", root, "--ignore-scripts", "--omit=peer", "--save-exact", "--registry=https://registry.npmjs.org/", "pi-subagents@0.84.0"], { env });
  if (process.platform === "darwin" || process.platform === "linux") {
    // 仅放行锁依赖的原生构建，并用当前 Node 验证 ABI；失败不得报告准备成功。
    await run("npm", ["rebuild", "fs-ext", "--prefix", root, "--ignore-scripts=false", "--registry=https://registry.npmjs.org/"], { env });
    await run(process.execPath, ["--input-type=commonjs", "--eval", "if (typeof require('fs-ext').flock !== 'function') throw new Error('fs-ext.flock 不可用')"], { cwd: root, env });
  }
  if (env.PI_HOST_ROOT) await bindPhysicalHostPeers({ enhancedPackageRoot: root, hostRoot: env.PI_HOST_ROOT });
  const upstreamRoot = resolve(root, "node_modules/pi-subagents");
  return { packageRoot: root, upstreamRoot };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const result = await setupRuntimeDependencies();
  process.stdout.write(`Prepared pi-subagents 0.84.0 in ${result.upstreamRoot}\n`);
}
