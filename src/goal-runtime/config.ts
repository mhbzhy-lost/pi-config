import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export type GoalRuntimeConfig = {
  enabled: boolean;
  maxConcurrentTasks: number;
  maxNoProgressTurns: number;
};

export const DEFAULT_GOAL_RUNTIME_CONFIG: Readonly<GoalRuntimeConfig> = Object.freeze({
  enabled: false, maxConcurrentTasks: 2, maxNoProgressTurns: 3,
});

/**
 * 从 settings.json 顶层 `goalEngine` 块解码 Goal Runtime 配置。
 *
 * goalEngine 是 Pi settings 的命名空间：本模块只校验自有键（enabled、
 * maxConcurrentTasks、maxNoProgressTurns），对块内其它键不拒绝（settings 的
 * 键集由 Pi 官方 schema 拥有，不由本模块裁决）。自有键缺省取默认值；
 * 显式提供时按严格类型校验（布尔/正整数），非法值抛错由调用方 fail-closed。
 */
export function decodeGoalRuntimeConfig(value: unknown): GoalRuntimeConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Goal Engine 配置必须是对象");
  }
  const record = value as Record<string, unknown>;
  const config = { ...DEFAULT_GOAL_RUNTIME_CONFIG };
  if (record.enabled !== undefined) {
    if (typeof record.enabled !== "boolean") throw new Error("Goal Engine enabled 必须是布尔值");
    config.enabled = record.enabled;
  }
  for (const key of ["maxConcurrentTasks", "maxNoProgressTurns"] as const) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`Goal Engine ${key} 必须是正整数`);
    config[key] = value;
  }
  return config;
}

/**
 * 读取 agentDir 下 settings.json 的 goalEngine 块构造运行配置。
 * 文件缺失（ENOENT）或无 goalEngine 块时返回默认值（fail-closed 关闭）；
 * 文件存在但 JSON 非法、goalEngine 非对象或自有键非法时抛错，由调用方决定不注册。
 */
export async function readGoalRuntimeConfig(agentDir: string): Promise<GoalRuntimeConfig> {
  if (typeof agentDir !== "string" || !agentDir.trim() || !isAbsolute(agentDir)) {
    throw new Error("Goal Runtime 缺少可信的绝对 agentDir");
  }
  let text: string;
  try { text = await readFile(join(agentDir, "settings.json"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_GOAL_RUNTIME_CONFIG };
    throw error;
  }
  const settings: unknown = JSON.parse(text);
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("settings.json 顶层必须是对象");
  }
  const goalEngine = (settings as Record<string, unknown>).goalEngine;
  if (goalEngine === undefined) return { ...DEFAULT_GOAL_RUNTIME_CONFIG };
  return decodeGoalRuntimeConfig(goalEngine);
}
