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

/** 仅解码自有配置；不读取 Pi settings 或旧 Goal 的业务状态。 */
export function decodeGoalRuntimeConfig(value: unknown): GoalRuntimeConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Goal Runtime 配置必须是对象");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(DEFAULT_GOAL_RUNTIME_CONFIG);
  if (Object.keys(record).some(key => !keys.includes(key))) throw new Error("Goal Runtime 配置含未知字段");
  const config = { ...DEFAULT_GOAL_RUNTIME_CONFIG, ...record };
  if (typeof config.enabled !== "boolean") throw new Error("Goal Runtime enabled 必须是布尔值");
  for (const key of ["maxConcurrentTasks", "maxNoProgressTurns"] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`Goal Runtime ${key} 必须是正整数`);
  }
  return config;
}

export async function readGoalRuntimeConfig(agentDir: string): Promise<GoalRuntimeConfig> {
  if (typeof agentDir !== "string" || !agentDir.trim() || !isAbsolute(agentDir)) {
    throw new Error("Goal Runtime 缺少可信的绝对 agentDir");
  }
  let text: string;
  try { text = await readFile(join(agentDir, "goal-runtime.json"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_GOAL_RUNTIME_CONFIG };
    throw error;
  }
  return decodeGoalRuntimeConfig(JSON.parse(text));
}
