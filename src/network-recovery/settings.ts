// 断网兜底的配置读取。`networkRecovery` 段由用户在本机 settings.json 中可选声明：
// 未声明时按默认值启用（兜底默认生效），声明 `enabled: false` 才关闭。
// `delayMs` 非法（非数字、非有限值、小于最小间隔）时回退默认值，不抛错、不中断兜底。

/** 默认重试间隔：半小时。 */
export const DEFAULT_DELAY_MS = 30 * 60 * 1000;

/** 允许的最小间隔，避免误配成极短间隔导致高频唤醒。 */
export const MIN_DELAY_MS = 1000;

export type NetworkRecoveryConfig = {
  enabled: boolean;
  delayMs: number;
};

type NetworkRecoverySection = {
  enabled?: unknown;
  delayMs?: unknown;
};

/**
 * 从 Host settings 快照解析本 feature 的配置。
 * 快照缺失、形状异常或字段非法时都退化为默认值，保证兜底链路始终可用。
 */
export function resolveNetworkRecoveryConfig(settings: unknown): NetworkRecoveryConfig {
  const section = readSection(settings);
  const enabled = section?.enabled !== false;
  const delay = Number(section?.delayMs);
  const delayMs = Number.isFinite(delay) && delay >= MIN_DELAY_MS ? delay : DEFAULT_DELAY_MS;
  return { enabled, delayMs };
}

function readSection(settings: unknown): NetworkRecoverySection | undefined {
  if (typeof settings !== "object" || settings === null) return undefined;
  const section = (settings as { networkRecovery?: unknown }).networkRecovery;
  if (typeof section !== "object" || section === null) return undefined;
  return section as NetworkRecoverySection;
}
