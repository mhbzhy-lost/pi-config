/**
 * 本机 webExposure / webRelay 配置的唯一深度校验事实源。
 * scripts/pi-local-settings.ts 与 ensure/agent 共用，保持「未知/非法字段即 fail」语义。
 */
import { readFile } from "node:fs/promises";
import { normalizeFingerprint } from "./protocol.ts";

export type WebExposure = "off" | "lan" | "public";

export type WebRelayConfig = {
  /** 中继控制连接地址，必须 wss:// */
  url: string;
  /** ECS init 生成的 agent 鉴权 token */
  agentToken: string;
  /** CA SHA256 指纹（归一化后大写冒号分隔） */
  caFingerprint: string;
};

export type WebSettings = { exposure: WebExposure; relay: WebRelayConfig | null };

function fail(message: string): never {
  throw new Error(`pi/settings.local.json ${message}`);
}

/** 校验 webExposure / webRelay 两键；其余键不在本模块职责内。 */
export function validateWebSettings(settings: { webExposure?: unknown; webRelay?: unknown }): WebSettings {
  const rawExposure = settings.webExposure;
  let exposure: WebExposure = "off";
  if (rawExposure !== undefined) {
    if (rawExposure !== "off" && rawExposure !== "lan" && rawExposure !== "public") {
      fail(`webExposure 必须是 "off"、"lan" 或 "public"，当前：${JSON.stringify(rawExposure)}`);
    }
    exposure = rawExposure;
  }

  const rawRelay = settings.webRelay;
  if (rawRelay === undefined) return { exposure, relay: null };
  if (!rawRelay || typeof rawRelay !== "object" || Array.isArray(rawRelay)) fail("webRelay 必须是 JSON 对象");
  const obj = rawRelay as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key !== "url" && key !== "agentToken" && key !== "caFingerprint") fail(`webRelay 包含不支持的字段 ${key}`);
  }

  const url = obj.url;
  if (typeof url !== "string" || !url.startsWith("wss://")) fail("webRelay.url 必须是 wss:// 地址");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    fail(`webRelay.url 无法解析：${url}`);
  }
  const host = parsed.hostname;
  if (!host || host.startsWith("-") || /[\s\0\r\n]/.test(host) || !/^[A-Za-z0-9.[\]:_-]+$/.test(host)) {
    fail(`webRelay.url 主机名不合法：${host}`);
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") fail("webRelay.url 不应包含路径");
  if (parsed.search || parsed.hash) fail("webRelay.url 不应包含 query 或 fragment");
  if (parsed.port !== "") {
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`webRelay.url 端口不合法：${parsed.port}`);
  }

  const agentToken = obj.agentToken;
  if (typeof agentToken !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(agentToken)) {
    fail("webRelay.agentToken 必须是 16-128 位 [A-Za-z0-9_-] 字符串（ECS init 输出）");
  }

  const rawFp = obj.caFingerprint;
  if (typeof rawFp !== "string") fail("webRelay.caFingerprint 必须是字符串（SHA256:AA:BB:… 格式）");
  const caFingerprint = normalizeFingerprint(rawFp);
  if (!caFingerprint) fail("webRelay.caFingerprint 不是合法的 SHA256 指纹（64 位 hex，可冒号分隔）");

  return { exposure, relay: { url, agentToken, caFingerprint } };
}

/**
 * 读取本机 local settings 中的 web 配置；文件不存在视为 off（默认不启用外部控制）。
 * 只校验 web 两键，其余键由 pi-local-settings 负责。
 */
export async function loadWebSettings(settingsPath: string): Promise<WebSettings> {
  let raw: string;
  try {
    raw = await readFile(settingsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exposure: "off", relay: null };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("不是合法 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("必须是 JSON 对象");
  return validateWebSettings(parsed as { webExposure?: unknown; webRelay?: unknown });
}