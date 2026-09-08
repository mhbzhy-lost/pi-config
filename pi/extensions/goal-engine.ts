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

export function goalEngineSettingsPath(dir = agentDir()): string { return join(dir, "settings.json"); }

/** Goal engine switch defaults to off; malformed values fail closed. */
export function isGoalEngineEnabled(settingsPath = goalEngineSettingsPath()): boolean {
  if (!existsSync(settingsPath)) return false;
  let parsed: unknown; try { parsed = JSON.parse(readFileSync(settingsPath, "utf8")); } catch { return false; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const goalEngine = (parsed as Record<string, unknown>).goalEngine;
  if (goalEngine === true) return true;
  return !!goalEngine && typeof goalEngine === "object" && !Array.isArray(goalEngine) && (goalEngine as Record<string, unknown>).enabled === true;
}

type GoalEngineModule = {
  createGoalEngineExtension: (pi: ExtensionAPI, options?: { runtimeHost?: unknown; runtimeTrace?: { enabled: boolean } }) => unknown;
};

type FinalReviewConfiguration = { provider: string; id: string; timeoutMs: number };
type GoalEngineConfiguration = { runtimeHost?: Record<string, unknown>; runtimeTrace?: { enabled: boolean }; finalReview?: FinalReviewConfiguration };
function goalEngineConfiguration(settingsPath: string): GoalEngineConfiguration | null {
  if (!existsSync(settingsPath)) return null;
  let parsed: unknown; try { parsed = JSON.parse(readFileSync(settingsPath, "utf8")); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const value = (parsed as Record<string, unknown>).goalEngine;
  if (value === true) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const goal = value as Record<string, unknown>;
  if (goal.enabled !== true || Object.keys(goal).some((key) => key !== "enabled" && key !== "runtimeHost" && key !== "runtimeTrace")) return null;
  let runtimeHost: Record<string, unknown> | undefined;
  if (Object.hasOwn(goal, "runtimeHost")) {
    if (!goal.runtimeHost || typeof goal.runtimeHost !== "object" || Array.isArray(goal.runtimeHost)) return null;
    runtimeHost = goal.runtimeHost as Record<string, unknown>;
  }
  let runtimeTrace: { enabled: boolean } | undefined;
  if (Object.hasOwn(goal, "runtimeTrace")) {
    if (!goal.runtimeTrace || typeof goal.runtimeTrace !== "object" || Array.isArray(goal.runtimeTrace)) return null;
    const trace = goal.runtimeTrace as Record<string, unknown>;
    if (Object.keys(trace).some((key) => key !== "enabled") || typeof trace.enabled !== "boolean") return null;
    runtimeTrace = { enabled: trace.enabled };
  }
  return { ...(runtimeHost ? { runtimeHost } : {}), ...(runtimeTrace ? { runtimeTrace } : {}) };
}

async function productionFinalReviewFactory(configuration: FinalReviewConfiguration) {
  try {
    const [{ ModelRuntime }, provider] = await Promise.all([import("@earendil-works/pi-coding-agent"), import("../../src/goal-engine/production-final-review-provider.ts")]);
    const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
    const model = modelRuntime.getModel(configuration.provider, configuration.id);
    if (!model || !(await modelRuntime.getAvailable(configuration.provider)).some(candidate => candidate.id === configuration.id)) return undefined;
    return ({ stateRoot }: { stateRoot: string }) => provider.createProductionFinalReviewProvider({ modelRuntime, model, timeoutMs: configuration.timeoutMs, reportStore: provider.createFinalReviewReportStore({ stateRoot }) });
  } catch { return undefined; }
}

export async function createGoalEngineEntry(pi: ExtensionAPI, { settingsPath = goalEngineSettingsPath(), load = (): Promise<GoalEngineModule> => import("../../src/goal-engine/extension.ts"), runtimeHostFactory, finalReviewFactory = productionFinalReviewFactory }: { settingsPath?: string; load?: () => Promise<GoalEngineModule>; runtimeHostFactory?: (pi: ExtensionAPI, options: object) => unknown; finalReviewFactory?: (configuration: FinalReviewConfiguration) => Promise<((input: { stateRoot: string }) => unknown) | undefined>; } = {}): Promise<void> {
  const configuration = goalEngineConfiguration(settingsPath);
  if (!configuration) return;
  let runtimeHost: unknown;
  if (configuration.runtimeHost) {
    const production = await import("../../src/goal-engine/production-runtime-host.ts");
    let options: Record<string, unknown>; try { options = production.normalizeProductionRuntimeHostOptions(configuration.runtimeHost); } catch { return; }
    runtimeHost = runtimeHostFactory ? runtimeHostFactory(pi, options) : production.createProductionGoalRuntimeHost(pi, options);
  } else if (runtimeHostFactory) runtimeHost = runtimeHostFactory(pi, {});
  const finalReviewProviderFactory = configuration.finalReview ? await finalReviewFactory(configuration.finalReview) : undefined;
  const { createGoalEngineExtension } = await load();
  createGoalEngineExtension(pi, { ...(runtimeHost ? { runtimeHost } : {}), ...(configuration.runtimeTrace ? { runtimeTrace: configuration.runtimeTrace } : {}) });
}

export default function goalEngine(pi: ExtensionAPI): Promise<void> { return createGoalEngineEntry(pi); }
