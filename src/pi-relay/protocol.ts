/**
 * pi-relay 共享协议：控制消息类型、close code、心跳/限额/配对/头部缓冲常量。
 * 本文件同时被本机 agent 与 ECS 中继消费（进部署 bundle），不得依赖仓内其他 feature。
 */
import { createHash, timingSafeEqual } from "node:crypto";

/** agent 上报的局域网直连信息（仅 192.168.0.0/16，默认路由网卡优选后） */
export type LanInfo = { host: string; port: number; token: string };

/** pi-web /api/sessions 的会话条目形状（agent 透传，中继最小校验后拍平合并） */
export type SessionBrief = { name: string; windows: number; created: string; attached: boolean };

/** 中继 → agent 下行控制消息 */
export type DownMessage =
  | { type: "open"; channel: string }
  | { type: "auth"; req: string; id: string; secretHash: string }
  | { type: "pair-request"; id: string; code: string; ua: string; ip: string; secretHash: string }
  | { type: "pair-check"; req: string; id: string }
  | { type: "list-sessions"; req: string };

/** agent → 中继上行控制消息（device-revoked 由 agent 检测吊销后推送） */
export type UpMessage =
  | { type: "hello"; lan: LanInfo | null; hostname?: string }
  | { type: "auth-result"; req: string; allow: boolean; name?: string }
  | { type: "pair-check-result"; req: string; status: "approved" | "denied" | "pending" }
  | { type: "sessions-result"; req: string; sessions: SessionBrief[] }
  | { type: "device-revoked"; id: string };

export type ControlMessage = DownMessage | UpMessage;

// ---- close codes ----
/** agentToken 与中继不一致：先完成 upgrade 再 close，agent 收到后停止重试 */
export const CLOSE_AGENT_TOKEN_INVALID = 4001;
/** 数据通道 channel id 未命中 pending 表 */
export const CLOSE_CHANNEL_INVALID = 4002;

// ---- 心跳与重连 ----
export const HEARTBEAT_PING_MS = 5_000;
export const HEARTBEAT_TIMEOUT_MS = 15_000;
export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 15_000;

// ---- 通道限额 ----
export const MAX_DATA_CHANNELS = 32;
export const MAX_PENDING_CHANNELS = 16;
/** 多 agent 全局通道上限（防总量失控，单 agent 限额另计） */
export const MAX_GLOBAL_DATA_CHANNELS = 64;
export const MAX_GLOBAL_PENDING_CHANNELS = 64;
export const CHANNEL_TTL_MS = 10_000;
export const CHANNEL_IDLE_MS = 120_000;
export const MAX_WS_MESSAGE_BYTES = 4 * 1024 * 1024;
export const AUTH_TIMEOUT_MS = 5_000;

// ---- 头部缓冲防护（预鉴权阶段） ----
export const HEADER_MAX_BYTES = 16 * 1024;
export const HEADER_TIMEOUT_MS = 10_000;
export const PREAUTH_MAX_PER_IP = 16;

// ---- 配对 ----
export const PAIR_TTL_MS = 10 * 60_000;
export const PAIR_MAX_GLOBAL = 8;
export const PAIR_MAX_PER_IP_PER_MIN = 5;
export const AUTH_FAIL_MAX_PER_IP_PER_MIN = 10;

// ---- 多主机 ----
/** server-config agents 上限（也是 Cookie 映射上限） */
export const MAX_AGENTS = 16;
/** 旧单 agentToken 配置迁移后的固定 id（v1 Cookie 兼容映射依赖它） */
export const LEGACY_AGENT_ID = "host-1";

// ---- 背压 ----
export const BACKPRESSURE_HIGH_BYTES = 1024 * 1024;
export const BACKPRESSURE_CHECK_MS = 20;

// ---- 设备凭据 ----
export const DEVICE_COOKIE_NAME = "pi_relay_device";
export const DEVICE_COOKIE_MAX_AGE = 31_536_000; // 1 年
export const DEVICE_ID_BYTES = 8; // 16 hex
export const DEVICE_SECRET_BYTES = 32; // base64url

/** SHA256 hex 摘要（secret/token 比对统一先摘要，规避不等长 throw） */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** 常量时间比对两个 hex 摘要（先各自摘要，长度必然一致） */
export function safeEqualHex(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db);
}

/**
 * CA 指纹归一化：接受 `SHA256:AA:BB:…` / `AA:BB:…` / 连续 hex，
 * 统一为大写冒号分隔；非法输入返回 null（fail closed）。
 */
export function normalizeFingerprint(raw: string): string | null {
  let hex = raw.trim().toUpperCase();
  if (hex.startsWith("SHA256:")) hex = hex.slice(7);
  hex = hex.replaceAll(":", "").replace(/\s+/g, "");
  if (!/^[0-9A-F]{64}$/.test(hex)) return null;
  return (hex.match(/../g) ?? []).join(":");
}

/** IPv4-mapped IPv6 归一化（::ffff:1.2.3.4 → 1.2.3.4），用于来源 IP 比对 */
export function normalizeIp(addr: string): string {
  const lower = addr.toLowerCase();
  if (lower.startsWith("::ffff:")) return lower.slice(7);
  return lower;
}

/** 是否 192.168.0.0/16 IPv4（同局域网 redirect 的收窄语义） */
export function is192168(addr: string): boolean {
  return /^192\.168\.\d{1,3}\.\d{1,3}$/.test(addr);
}