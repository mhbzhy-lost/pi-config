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
  createGoalEngineExtension: (pi: ExtensionAPI, options?: { runtimeHost?: unknown }) => unknown;
};

type GoalEngineConfiguration = { runtimeHost?: Record<string, unknown> };
function goalEngineConfiguration(settingsPath: string): GoalEngineConfiguration | null {
  if (!existsSync(settingsPath)) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(settingsPath, "utf8")); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const value = (parsed as Record<string, unknown>).goalEngine;
  if (value === true) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const goal = value as Record<string, unknown>;
  if (goal.enabled !== true || Object.keys(goal).some((key) => key !== "enabled" && key !== "runtimeHost")) return null;
  if (!Object.hasOwn(goal, "runtimeHost")) return {};
  if (!goal.runtimeHost || typeof goal.runtimeHost !== "object" || Array.isArray(goal.runtimeHost)) return null;
  return { runtimeHost: goal.runtimeHost as Record<string, unknown> };
}

export async function createGoalEngineEntry(
  pi: ExtensionAPI,
  {
    settingsPath = goalEngineSettingsPath(),
    load = (): Promise<GoalEngineModule> => import("../../src/goal-engine/extension.ts"),
    runtimeHostFactory,
  }: {
    settingsPath?: string;
    load?: () => Promise<GoalEngineModule>;
    runtimeHostFactory?: (pi: ExtensionAPI, options: object) => unknown;
  } = {},
): Promise<void> {
  const configuration = goalEngineConfiguration(settingsPath);
  if (!configuration) return;
  let runtimeHost: unknown;
  if (configuration.runtimeHost) {
    const production = await import("../../src/goal-engine/production-runtime-host.ts");
    let options: Record<string, unknown>;
    try { options = production.normalizeProductionRuntimeHostOptions(configuration.runtimeHost); } catch { return; }
    runtimeHost = runtimeHostFactory ? runtimeHostFactory(pi, options) : production.createProductionGoalRuntimeHost(pi, options);
  } else if (runtimeHostFactory) {
    runtimeHost = runtimeHostFactory(pi, {});
  }
  const { createGoalEngineExtension } = await load();
  createGoalEngineExtension(pi, runtimeHost ? { runtimeHost } : {});
}

export default function goalEngine(pi: ExtensionAPI): Promise<void> {
  return createGoalEngineEntry(pi);
}
