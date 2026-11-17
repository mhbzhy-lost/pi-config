/**
 * 部署 bundle：自包含 tarball（中继代码 + ws 依赖 + 最小 package.json），不含任何凭据。
 * 上传与远端执行经 aliyun-hangzhou-server skill 受控包装器或用户手工 scp/ssh（仅部署面）。
 */
import { execFile } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { relayDir } from "./devices.ts";

const execFileAsync = promisify(execFile);

const RELAY_SOURCES = ["protocol.ts", "server.ts", "server-config.ts", "certs.ts"];

export async function buildBundle(root: string): Promise<string> {
  const dir = relayDir(root);
  const stage = path.join(dir, "bundle-stage");
  await rm(stage, { recursive: true, force: true });
  await mkdir(path.join(stage, "src", "pi-relay"), { recursive: true });
  await mkdir(path.join(stage, "scripts"), { recursive: true });
  for (const file of RELAY_SOURCES) {
    await cp(path.join(root, "src", "pi-relay", file), path.join(stage, "src", "pi-relay", file));
  }
  await cp(path.join(root, "scripts", "pi-relay-server.ts"), path.join(stage, "scripts", "pi-relay-server.ts"));
  // ws 无运行时依赖（dependencies={}），整目录拷贝即可
  await cp(path.join(root, "node_modules", "ws"), path.join(stage, "node_modules", "ws"), { recursive: true });
  await writeFile(path.join(stage, "package.json"), `${JSON.stringify({ name: "pi-relay-server", private: true, type: "module" }, null, 2)}\n`);
  const out = path.join(dir, "relay-bundle.tar.gz");
  await execFileAsync("tar", ["czf", out, "-C", stage, "."]);
  await rm(stage, { recursive: true, force: true });
  return out;
}