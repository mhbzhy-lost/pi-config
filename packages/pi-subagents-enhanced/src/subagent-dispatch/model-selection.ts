export type AvailableModel = {
  provider: string;
  id: string;
};

export type ModelSelectionWarning = {
  code: "MODEL_MATCH_USED_GLOBAL_CATALOG";
  agent: string;
  requestedModel: string;
  resolvedModel: string;
};

export type ModelSelection = {
  model?: string;
  source: "default" | "qualified" | "agent-candidates" | "global-catalog";
  warnings?: ModelSelectionWarning[];
};

export type ModelSelectionInput = {
  requestedModel?: string;
  agentName: string;
  agentModels?: string[];
  availableModels: AvailableModel[];
  blockedProviders?: readonly string[];
};

export type ModelCandidateProfile = {
  agentName?: string;
  /** Ordered profile declaration. `agentModels` is accepted for compatibility. */
  models?: readonly string[];
  agentModels?: readonly string[];
  model?: string;
  fallbackModels?: readonly string[];
  availableModels: readonly AvailableModel[];
  blockedProviders?: readonly string[];
};

export type ModelSelectionErrorDetails = {
  code: "MODEL_NOT_AVAILABLE";
  requestedModel: string;
  requestedKind: "qualified" | "bare";
  agent: string;
  declaredCandidates: readonly string[];
  availableCandidates: readonly string[];
  suggestion?: string;
};

export class ModelSelectionError extends Error {
  code = "MODEL_NOT_AVAILABLE";
  details: ModelSelectionErrorDetails;

  constructor(requestedModel: string, agentName: string, candidates: {
    declaredCandidates?: readonly string[];
    availableCandidates?: readonly string[];
    suggestion?: string;
  } = {}) {
    const declared = [...(candidates.declaredCandidates ?? [])];
    const available = [...(candidates.availableCandidates ?? [])].sort();
    const parts = [`Requested model is not available: ${requestedModel}; agent=${agentName}.`];
    if (requestedModel === "<profile>") parts.push("The declared candidate chain is empty.");
    if (declared.length > 0) parts.push(`Available declared IDs: ${JSON.stringify(declared)}.`);
    if (available.length > 0) parts.push(`Available models: ${JSON.stringify(available)}.`);
    if (candidates.suggestion) parts.push(`Did you mean \"${candidates.suggestion}\"?`);
    parts.push(`Bare IDs must exactly match the full id segment after \"provider/\"; no alias or substring matching is performed.`);
    super(parts.join(" "));
    this.name = "ModelSelectionError";
    this.details = Object.freeze({
      code: "MODEL_NOT_AVAILABLE",
      requestedModel,
      requestedKind: requestedModel.includes("/") ? "qualified" : "bare",
      agent: agentName,
      declaredCandidates: Object.freeze(declared),
      availableCandidates: Object.freeze(available),
      ...(candidates.suggestion ? { suggestion: candidates.suggestion } : {}),
    });
  }
}

function fullModelId(model: AvailableModel): string {
  return `${model.provider}/${model.id}`;
}

function candidateModelId(model: string): string {
  const separator = model.indexOf("/");
  return separator === -1 ? model : model.slice(separator + 1);
}

function candidateProvider(model: string): string | undefined {
  const separator = model.indexOf("/");
  return separator === -1 ? undefined : model.slice(0, separator);
}

function blockedProviderSet(blockedProviders: readonly string[] | undefined): Set<string> {
  return new Set((blockedProviders ?? []).map((provider) => provider.trim().toLowerCase()).filter(Boolean));
}

/**
 * Resolve the profile's ordered model declaration before a run is launched.
 * Runtime retries must not mutate this chain or consult a second catalog.
 */
export function resolveModelCandidates(profile: ModelCandidateProfile): string[] {
  const agentName = profile.agentName ?? "unknown";
  const declared = profile.models ?? profile.agentModels
    ?? (profile.model === undefined ? profile.fallbackModels : [profile.model, ...(profile.fallbackModels ?? [])]);
  const candidates = [...(declared ?? [])];
  if (candidates.length === 0) {
    throw new ModelSelectionError("<profile>", agentName, { declaredCandidates: candidates });
  }
  const blocked = blockedProviderSet(profile.blockedProviders);
  const available = new Set(profile.availableModels
    .filter((model) => !blocked.has(model.provider.trim().toLowerCase()))
    .map(fullModelId));
  const unavailable = candidates.filter((candidate) => !available.has(candidate));
  if (unavailable.length === candidates.length) {
    throw new ModelSelectionError(candidates.join(", "), agentName, {
      declaredCandidates: candidates,
      availableCandidates: [...available],
    });
  }
  return candidates.filter((candidate) => available.has(candidate));
}

function suggestBareModelId(requested: string, declaredFullIds: readonly string[], availableFullIds: ReadonlySet<string>): string | undefined {
  if (requested.includes("/")) return undefined;
  const needle = requested.toLowerCase();
  const hits = new Set<string>();
  for (const full of declaredFullIds) {
    if (!availableFullIds.has(full)) continue;
    const id = candidateModelId(full).toLowerCase();
    if (id === needle || !id.endsWith(needle)) continue;
    const boundary = id.slice(0, id.length - needle.length).slice(-1);
    if (boundary === "-" || boundary === ".") hits.add(candidateModelId(full));
  }
  return hits.size === 1 ? [...hits][0] : undefined;
}

export function resolveModelSelection({
  requestedModel,
  agentName,
  agentModels,
  availableModels,
  blockedProviders,
}: ModelSelectionInput): ModelSelection {
  const requested = requestedModel?.trim();
  if (!requested) return { source: "default" };
  const blocked = blockedProviderSet(blockedProviders);
  const allowedModels = availableModels.filter((model) => !blocked.has(model.provider.trim().toLowerCase()));

  if (requested.includes("/")) {
    const matched = allowedModels.find((model) => fullModelId(model) === requested);
    if (matched) return { model: fullModelId(matched), source: "qualified" };
    throw new ModelSelectionError(requested, agentName, {
      availableCandidates: allowedModels.map(fullModelId),
    });
  }

  if (agentModels !== undefined) {
    const availableModelIds = new Set(allowedModels.map(fullModelId));
    const matched = agentModels.find((model) => (
      !blocked.has(candidateProvider(model)?.toLowerCase() ?? "")
      && candidateModelId(model) === requested && availableModelIds.has(model)
    ));
    if (matched) return { model: matched, source: "agent-candidates" };
    const declaredCandidates = agentModels.filter((model) => !blocked.has(candidateProvider(model)?.toLowerCase() ?? ""));
    throw new ModelSelectionError(requested, agentName, {
      declaredCandidates,
      availableCandidates: allowedModels.map(fullModelId),
      suggestion: suggestBareModelId(requested, declaredCandidates, availableModelIds),
    });
  }

  const matched = [...allowedModels]
    .sort((left, right) => {
      const leftId = fullModelId(left);
      const rightId = fullModelId(right);
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    })
    .find((model) => model.id === requested);
  if (!matched) throw new ModelSelectionError(requested, agentName, {
    availableCandidates: allowedModels.map(fullModelId),
  });

  const resolvedModel = fullModelId(matched);
  return {
    model: resolvedModel,
    source: "global-catalog",
    warnings: [{
      code: "MODEL_MATCH_USED_GLOBAL_CATALOG",
      agent: agentName,
      requestedModel: requested,
      resolvedModel,
    }],
  };
}
