import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export type AvailableModelsRegistry = Pick<ModelRegistry, "getAvailable">;

/** 读取 registry 当前可用 chat model 快照，仅投影公开名称。 */
export function listAvailableModels(registry: AvailableModelsRegistry): string[] {
  const names = registry.getAvailable().map((model) => `${model.provider}/${model.id}`);
  return [...new Set(names)].sort();
}

export function createAvailableModelsResult(models: string[]) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(models) }],
    structuredContent: models,
    details: undefined,
  };
}
