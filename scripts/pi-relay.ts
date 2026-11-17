#!/usr/bin/env node
/**
 * pi-relay 本机薄 CLI：ensure/status/stop/bundle/fetch-ca/devices/approve/deny/revoke。
 * 实现全部在 src/pi-relay/；ensure 的任何失败都降级为中文告警（exit 0），绝不阻断 pi()。
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeFingerprint } from "../src/pi-relay/protocol.ts";
import { loadWebSettings } from "../src/pi-relay/config.ts";
import { approveByCode, denyByCode, readDevices, readLastSeen, readPending, relayDir, revokeById } from "../src/pi-relay/devices.ts";
import { ensureWeb, statusReport, stopAll } from "../src/pi-relay/ensure.ts";
import { buildBundle } from "../src/pi-relay/bundle.ts";
import { runAgent } from "../src/pi-relay/agent.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const settingsPath = process.env.PI_LOCAL_SETTINGS_PATH ?? path.join(root, "pi", "settings.local.json");

function usage(): never {
  console.error("用法：node scripts/pi-relay.ts <ensure|status|stop|bundle|fetch-ca|devices|approve <配对码> [--name 名称]|deny <配对码>|revoke <设备id>>");
  process.exit(1);
}

/** 下载中继 CA 并按注入指纹核对（此步唯一一次放宽证书校验，指纹不符拒存） */
async function fetchCa(): Promise<void> {
  const settings = await loadWebSettings(settingsPath);
  if (!settings.relay) throw new Error("缺少 webRelay 配置：请先注入 url/agentToken/caFingerprint");
  const url = new URL(settings.relay.url);
  const target = `https://${url.hostname}${url.port ? `:${url.port}` : ""}/ca.crt`;
  const pem = await new Promise<string>((resolve, reject) => {
    const req = httpsRequest(target, { rejectUnauthorized: false, timeout: 10_000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`下载 CA 失败：HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("下载 CA 超时"));
    });
    req.on("error", reject);
    req.end();
  });
  const base64 = pem.replace(/-----BEGIN CERTIFICATE-----/g, "").replace(/-----END CERTIFICATE-----/g, "").replace(/\s+/g, "");
  const der = Buffer.from(base64, "base64");
  const fingerprint = normalizeFingerprint(createHash("sha256").update(der).digest("hex"));
  if (!fingerprint || fingerprint !== settings.relay.caFingerprint) {
    throw new Error("CA 指纹与 webRelay.caFingerprint 不一致：拒绝保存（请核对 ECS init 输出，谨防中间人）");
  }
  const file = path.join(relayDir(root), "root-ca.crt");
  await writeFile(file, pem.endsWith("\n") ? pem : `${pem}\n`, { mode: 0o600 });
  console.log(`CA 已校验并保存：${file}`);
}

async function listDevices(): Promise<void> {
  const pending = (await readPending(root)).filter((p) => p.status === "pending");
  const devices = await readDevices(root);
  const lastSeen = await readLastSeen(root);
  if (pending.length > 0) {
    console.log("待批准设备（核对手机屏幕配对码后 approve）：");
    for (const p of pending) {
      console.log(`  配对码 ${p.code}  id=${p.id}  来源=${p.ip}  时间=${new Date(p.ts).toLocaleString()}  UA=${p.ua}`);
    }
  } else {
    console.log("无待批准设备。");
  }
  if (devices.length > 0) {
    console.log("可信设备：");
    for (const d of devices) {
      console.log(`  id=${d.id}  名称=${d.name}  批准于=${d.approvedAt}  最近活跃=${lastSeen[d.id] ?? "未知"}  UA=${d.ua}`);
    }
  } else {
    console.log("无可信设备。");
  }
}

const [command, ...rest] = process.argv.slice(2);

try {
  switch (command) {
    case "ensure": {
      try {
        const result = await ensureWeb(root, settingsPath);
        for (const message of result.messages) console.log(message);
      } catch (error) {
        console.error(`pi-relay 未启用：${error instanceof Error ? error.message : String(error)}`);
      }
      process.exit(0);
      break;
    }
    case "status":
      console.log(await statusReport(root, settingsPath));
      break;
    case "stop":
      await stopAll(root);
      console.log("已停止本机 pi-web 与 pi-relay agent。");
      break;
    case "bundle":
      console.log(`部署包已生成：${await buildBundle(root)}`);
      break;
    case "fetch-ca":
      await fetchCa();
      break;
    case "devices":
      await listDevices();
      break;
    case "approve": {
      const code = rest[0];
      if (!code) usage();
      const nameIdx = rest.indexOf("--name");
      const name = nameIdx >= 0 ? rest[nameIdx + 1] : undefined;
      const device = await approveByCode(root, code, name);
      console.log(`已批准设备：id=${device.id} 名称=${device.name}（配对页将自动获得凭据并跳转）`);
      break;
    }
    case "deny": {
      const code = rest[0];
      if (!code) usage();
      await denyByCode(root, code);
      console.log(`已拒绝配对码 ${code} 对应的设备。`);
      break;
    }
    case "revoke": {
      const id = rest[0];
      if (!id) usage();
      const device = await revokeById(root, id);
      console.log(`已吊销设备：id=${device.id} 名称=${device.name}（存量连接即时切断，再次访问需重新配对）`);
      break;
    }
    case "_agent":
      await runAgent(root, settingsPath);
      break;
    default:
      usage();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}