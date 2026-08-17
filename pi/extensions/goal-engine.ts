import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function agentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (configured === "~") return homedir();
  if (configured?.startsWith("~/")) return join(homedir(), configured.slice(2));
  return configured || join(homedir(), ".pi", "agent");
}

export function goalEngineSettingsPath(dir = agentDir()): string {
  return join(dir, "settings.json");
}

/**
 * Goal engine switch, default OFF. Absent, malformed, or invalid values fail closed.
 * Enables via `"goalEngine": true` or `"goalEngine": { "enabled": true }` in settings.json.
 */
export function isGoalEngineEnabled(settingsPath = goalEngineSettingsPath()): boolean {
  if (!existsSync(settingsPath)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const goalEngine = (parsed as Record<string, unknown>).goalEngine;
  if (goalEngine === true) return true;
  if (!goalEngine || typeof goalEngine !== "object" || Array.isArray(goalEngine)) return false;
  return (goalEngine as Record<string, unknown>).enabled === true;
}

type GoalEngineModule = {
  createGoalEngineExtension: (pi: ExtensionAPI) => unknown;
};

export async function createGoalEngineEntry(
  pi: ExtensionAPI,
  {
    settingsPath = goalEngineSettingsPath(),
    load = (): Promise<GoalEngineModule> => import("../../scripts/lib/goal-engine/extension.mjs"),
  }: {
    settingsPath?: string;
    load?: () => Promise<GoalEngineModule>;
  } = {},
): Promise<void> {
  if (!isGoalEngineEnabled(settingsPath)) return;
  const { createGoalEngineExtension } = await load();
  // The lazily loaded factory owns the frozen Root Goal exact-eight ABI, including goal_finalize.
  createGoalEngineExtension(pi);
}

export default function goalEngine(pi: ExtensionAPI): Promise<void> {
  return createGoalEngineEntry(pi);
}
