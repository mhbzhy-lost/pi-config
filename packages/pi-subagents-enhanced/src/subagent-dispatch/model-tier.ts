import { CodingDispatchContractError } from "./errors.ts";

export const MODEL_TIERS = Object.freeze(["luna", "terra"] as const);
export type ModelTier = typeof MODEL_TIERS[number];

export const EXECUTOR_MODEL_BY_TIER = Object.freeze({
  luna: "codex-pool/gpt-5.6-luna",
  terra: "codex-pool/gpt-5.6-terra",
} satisfies Record<ModelTier, string>);

export function normalizeOptionalModelTier(value: unknown, location = "modelTier"): ModelTier | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new CodingDispatchContractError("INVALID_CONTRACT", `${location} must be a string; keypath=${location}`, location, location);
  }
  const normalized = value.trim();
  if ((MODEL_TIERS as readonly string[]).includes(normalized)) return normalized as ModelTier;
  throw new CodingDispatchContractError("INVALID_CONTRACT", `${location} is not supported: ${normalized}; keypath=${location}`, location, location);
}

export function executorModelForTier(tier: ModelTier): string {
  return EXECUTOR_MODEL_BY_TIER[tier];
}
