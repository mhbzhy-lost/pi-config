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

export class ModelSelectionError extends Error {
  code = "MODEL_NOT_AVAILABLE";

  constructor(requestedModel: string, agentName: string) {
    super(`Requested model is not available: ${requestedModel}; agent=${agentName}`);
    this.name = "ModelSelectionError";
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
    throw new ModelSelectionError(requested, agentName);
  }

  if (agentModels !== undefined) {
    const availableModelIds = new Set(allowedModels.map(fullModelId));
    const matched = agentModels.find((model) => (
      !blocked.has(candidateProvider(model)?.toLowerCase() ?? "")
      && candidateModelId(model) === requested && availableModelIds.has(model)
    ));
    if (matched) return { model: matched, source: "agent-candidates" };
    throw new ModelSelectionError(requested, agentName);
  }

  const matched = [...allowedModels]
    .sort((left, right) => {
      const leftId = fullModelId(left);
      const rightId = fullModelId(right);
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    })
    .find((model) => model.id === requested);
  if (!matched) throw new ModelSelectionError(requested, agentName);

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
