/**
 * ECS 侧 server-config.json 读写校验（0600）。
 * 仅中继进程消费；本机配置见 config.ts，两者互不混用。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type RelayServerConfig = {
  listen: string;
  port: number;
  agentToken: string;
  /** 叶证书 SAN IP 列表（init 写入，renew-cert 复用） */
  sanIps?: string[];
};

export function serverConfigPath(root: string): string {
  return path.join(root, "var", "pi-relay", "server-config.json");
}

export function validateServerConfig(raw: unknown): RelayServerConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("server-config.json 必须是 JSON 对象");
  const obj = raw as Record<string, unknown>;
  const { listen, port, agentToken } = obj;
  if (typeof listen !== "string" || listen.length === 0 || /[\s\0]/.test(listen)) throw new Error("server-config.json listen 不合法");
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("server-config.json port 必须是 1-65535 整数");
  if (typeof agentToken !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(agentToken)) throw new Error("server-config.json agentToken 不合法");
  const sanIps = obj.sanIps;
  if (sanIps !== undefined && (!Array.isArray(sanIps) || sanIps.some((ip) => typeof ip !== "string" || !/^[0-9A-Fa-f:.]+$/.test(ip)))) {
    throw new Error("server-config.json sanIps 必须是 IP 字符串数组");
  }
  return { listen, port, agentToken, ...(sanIps !== undefined ? { sanIps: sanIps as string[] } : {}) };
}

export async function loadServerConfig(root: string): Promise<RelayServerConfig> {
  let raw: string;
  try {
    raw = await readFile(serverConfigPath(root), "utf8");
  } catch {
    throw new Error("未找到 server-config.json：请先在本机运行 node scripts/pi-relay-server.ts init");
  }
  return validateServerConfig(JSON.parse(raw) as unknown);
}

export async function saveServerConfig(root: string, config: RelayServerConfig): Promise<void> {
  const file = serverConfigPath(root);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}