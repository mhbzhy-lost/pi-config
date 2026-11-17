#!/usr/bin/env node
/**
 * pi-relay ECS 侧薄 CLI：init/start/renew-cert。
 * init 生成自签 CA/叶证书与 agentToken（唯一凭据事实源），打印注入材料供用户粘贴进本机 settings.local.json。
 */
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { caFingerprint, ensureCa, issueLeaf } from "../src/pi-relay/certs.ts";
import { MAX_AGENTS } from "../src/pi-relay/protocol.ts";
import { loadServerConfig, saveServerConfig, serverConfigPath, type AgentEntry, type RelayServerConfig } from "../src/pi-relay/server-config.ts";
import { startRelayServer } from "../src/pi-relay/server.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function flag(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function flagAll(name: string): string[] {
  const result: string[] = [];
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === name && process.argv[i + 1]) result.push(process.argv[i + 1]!);
  }
  return result;
}

function detectedIps(): string[] {
  const result: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === "IPv4" && !net.internal) result.push(net.address);
    }
  }
  return result;
}

async function init(): Promise<void> {
  const rotate = process.argv.includes("--rotate-tokens");
  const addAgent = process.argv.includes("--add-agent");
  const label = flag("--label");
  if (label !== undefined && (label.length === 0 || label.length > 40 || /[\u0000-\u001f\u007f]/.test(label))) {
    throw new Error("--label 必须是 1-40 字符且不含控制字符");
  }
  let existing: RelayServerConfig | null = null;
  try {
    existing = await loadServerConfig(root);
  } catch {
    // 首次 init
  }
  if (addAgent && !existing) throw new Error("--add-agent 需要已有配置：请先运行一次普通 init");
  if (addAgent && rotate) throw new Error("--add-agent 与 --rotate-tokens 不能同时使用");
  const listen = flag("--listen") ?? existing?.listen ?? "0.0.0.0";
  const port = Number(flag("--port") ?? existing?.port ?? 443);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port 必须是 1-65535 整数");
  const explicitIps = flagAll("--ip");
  const sanIps = [...new Set([...(explicitIps.length > 0 ? explicitIps : existing?.sanIps ?? detectedIps()), "127.0.0.1"])];

  let agents: AgentEntry[];
  if (!existing) {
    agents = [{ id: randomBytes(4).toString("hex"), token: randomBytes(32).toString("base64url"), ...(label !== undefined ? { label } : {}) }];
  } else if (addAgent) {
    if (existing.agents.length >= MAX_AGENTS) throw new Error(`agent 数量已达上限 ${MAX_AGENTS}`);
    agents = [...existing.agents, { id: randomBytes(4).toString("hex"), token: randomBytes(32).toString("base64url"), ...(label !== undefined ? { label } : {}) }];
  } else if (rotate) {
    agents = existing.agents.map((a) => ({ ...a, token: randomBytes(32).toString("base64url") }));
  } else {
    agents = existing.agents;
  }

  await ensureCa(root);
  await issueLeaf(root, sanIps);
  await saveServerConfig(root, { listen, port, agents, sanIps });
  const fingerprint = await caFingerprint(root);
  const publicIp = sanIps.find((ip) => ip !== "127.0.0.1") ?? "127.0.0.1";
  const url = `wss://${publicIp}${port === 443 ? "" : `:${port}`}`;

  // 打印范围：首次/rotate → 全部 agent；add-agent → 仅新增；普通重跑 → 全部（幂等保留）
  const printed = addAgent ? agents.slice(-1) : agents;
  console.log(addAgent ? "已新增 agent。请把以下材料注入新 Mac 的 pi/settings.local.json（gitignored）：" : "初始化完成。请把以下材料注入本机 pi/settings.local.json（gitignored）：");
  for (const agent of printed) {
    if (printed.length > 1) console.log(`--- agent ${agent.id}${agent.label ? `（${agent.label}）` : ""} ---`);
    console.log(JSON.stringify({ webExposure: "public", webRelay: { url, agentToken: agent.token, caFingerprint: `SHA256:${fingerprint}` } }, null, 2));
  }
  console.log("");
  console.log("随后在对应 Mac 运行：node scripts/pi-relay.ts fetch-ca && node scripts/pi-relay.ts ensure");
  if (rotate) console.log("注意：--rotate-tokens 轮换了全部 agent token，每台 Mac 都需更新注入值；重启中继后旧 token 的 agent 会收 4001 退出。");
  if (addAgent || rotate) console.log("配置在 start 时加载一次：请重启中继进程使变更生效。");
  console.log(`手机信任 CA：浏览器访问 https://${publicIp}${port === 443 ? "" : `:${port}`}/ca.crt 下载并核对指纹后安装；`);
  console.log("iOS 需在 设置→通用→关于本机→证书信任设置 开启完全信任；鸿蒙把 .crt 改后缀 .cer 后从 加密和凭据 安装 CA 证书。信任该根 CA 后本机被攻破可对手机做任意域名 MITM，不用时请删除描述文件。");
  console.log(`启动中继：node scripts/pi-relay-server.ts start（守护方式见 src/pi-relay/README.md）`);
}

async function renewCert(): Promise<void> {
  const config = await loadServerConfig(root);
  const explicitIps = flagAll("--ip");
  const sanIps = [...new Set([...(explicitIps.length > 0 ? explicitIps : config.sanIps ?? detectedIps()), "127.0.0.1"])];
  await ensureCa(root);
  await issueLeaf(root, sanIps);
  if (explicitIps.length > 0) await saveServerConfig(root, { ...config, sanIps });
  console.log("叶证书已用既有 CA 续签（398 天），重启中继进程生效；手机无需重新信任。");
}

const command = process.argv[2];
try {
  if (command === "init") {
    await init();
  } else if (command === "start") {
    const { close } = await startRelayServer(root);
    const shutdown = (): void => {
      void close().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } else if (command === "renew-cert") {
    await renewCert();
  } else {
    console.error("用法：node scripts/pi-relay-server.ts <init [--listen 地址] [--port 端口] [--ip 公网IP]… [--add-agent [--label 名称]] [--rotate-tokens] | start | renew-cert [--ip 公网IP]…>");
    console.error(`配置文件：${serverConfigPath(root)}`);
    process.exit(1);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}