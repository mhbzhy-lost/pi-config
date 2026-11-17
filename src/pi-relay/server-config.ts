/**
 * ECS 侧 server-config.json 读写校验（0600）。
 * 仅中继进程消费；本机配置见 config.ts，两者互不混用。
 * 多主机格式：agents 数组（每项 id/token/label?）；旧单 agentToken 格式加载时
 * 归一化为 agents:[{id:"host-1",token}]（v1 Cookie 兼容依赖该固定 id），下次 save 落新格式。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { LEGACY_AGENT_ID, MAX_AGENTS } from "./protocol.ts";

export type AgentEntry = { id: string; token: string; label?: string };

export type RelayServerConfig = {
  listen: string;
  port: number;
  agents: AgentEntry[];
  /** 叶证书 SAN IP 列表（init 写入，renew-cert 复用） */
  sanIps?: string[];
};

export function serverConfigPath(root: string): string {
  return path.join(root, "var", "pi-relay", "server-config.json");
}

function validAgentId(id: unknown): id is string {
  return typeof id === "string" && (/^[0-9a-f]{8}$/.test(id) || id === LEGACY_AGENT_ID);
}

function validToken(token: unknown): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(token);
}

function validLabel(label: unknown): label is string {
  return typeof label === "string" && label.length > 0 && label.length <= 40 && !/[\u0000-\u001f\u007f]/.test(label);
}

export function validateServerConfig(raw: unknown): RelayServerConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("server-config.json 必须是 JSON 对象");
  const obj = raw as Record<string, unknown>;
  const { listen, port } = obj;
  if (typeof listen !== "string" || listen.length === 0 || /[\s\0]/.test(listen)) throw new Error("server-config.json listen 不合法");
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("server-config.json port 必须是 1-65535 整数");

  let agents: AgentEntry[];
  if (Array.isArray(obj.agents)) {
    if (obj.agents.length < 1 || obj.agents.length > MAX_AGENTS) throw new Error(`server-config.json agents 必须是 1-${MAX_AGENTS} 项数组`);
    const ids = new Set<string>();
    const tokens = new Set<string>();
    agents = obj.agents.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("server-config.json agents 每项必须是对象");
      const { id, token, label } = entry as Record<string, unknown>;
      if (!validAgentId(id)) throw new Error("server-config.json agent id 必须是 8 位 hex 或 host-1");
      if (!validToken(token)) throw new Error("server-config.json agent token 不合法");
      if (ids.has(id)) throw new Error("server-config.json agent id 重复");
      if (tokens.has(token)) throw new Error("server-config.json agent token 重复");
      if (label !== undefined && !validLabel(label)) throw new Error("server-config.json agent label 必须是 ≤40 字符且不含控制字符");
      ids.add(id);
      tokens.add(token);
      const agentEntry: AgentEntry = { id, token };
      if (label !== undefined && validLabel(label)) agentEntry.label = label;
      return agentEntry;
    });
  } else if (validToken(obj.agentToken)) {
    // 旧单 agent 格式迁移（内存归一化，save 时落新格式）
    agents = [{ id: LEGACY_AGENT_ID, token: obj.agentToken }];
  } else {
    throw new Error("server-config.json 缺少 agents 数组或旧版 agentToken");
  }

  const sanIps = obj.sanIps;
  if (sanIps !== undefined && (!Array.isArray(sanIps) || sanIps.some((ip) => typeof ip !== "string" || !/^[0-9A-Fa-f:.]+$/.test(ip)))) {
    throw new Error("server-config.json sanIps 必须是 IP 字符串数组");
  }
  return { listen, port, agents, ...(sanIps !== undefined ? { sanIps: sanIps as string[] } : {}) };
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