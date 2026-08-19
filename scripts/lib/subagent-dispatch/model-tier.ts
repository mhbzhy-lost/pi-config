import { CodingDispatchContractError } from "./errors.ts";

export const MODEL_TIERS = Object.freeze(["luna", "terra"] as const);
export type ModelTier = typeof MODEL_TIERS[number];
export const DEFAULT_MODEL_TIER: ModelTier = "luna";

export const EXECUTOR_MODEL_BY_TIER = Object.freeze({
  luna: "openai-codex/gpt-5.6-luna",
  terra: "openai-codex/gpt-5.6-terra",
} satisfies Record<ModelTier, string>);

export function normalizeModelTier(value: unknown, location = "modelTier"): ModelTier {
  const raw = value === undefined ? DEFAULT_MODEL_TIER : value;
  if (typeof raw !== "string") {
    throw new CodingDispatchContractError("INVALID_CONTRACT", `${location} must be a string; keypath=${location}`, location, location);
  }
  const normalized = raw.trim();
  if ((MODEL_TIERS as readonly string[]).includes(normalized)) return normalized as ModelTier;
  throw new CodingDispatchContractError("INVALID_CONTRACT", `${location} is not supported: ${normalized}; keypath=${location}`, location, location);
}

export function executorModelForTier(tier: ModelTier): string {
  return EXECUTOR_MODEL_BY_TIER[tier];
}
