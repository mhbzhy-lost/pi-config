import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAvailableModelsResult, listAvailableModels } from "../../src/available-models/index.ts";

const parameters = Type.Object({}, { required: [] });

export default function availableModels(pi: ExtensionAPI) {
  pi.registerTool(defineTool({
    name: "list_available_models",
    label: "list_available_models",
    description: "列出当前 Host registry 中可用的 chat models；仅返回 provider/model 名称，不读取或暴露凭据。此目录不等同于 subagent policy 或当前 enabled scope。",
    promptSnippet: "列出当前 registry 可用的 chat models。",
    promptGuidelines: [
      "需要了解当前 Host registry 中可用的 chat model 目录时使用；结果不代表 subagent policy 或当前 enabled scope。",
      "工具只读取当前 registry snapshot，不刷新模型、不联网，也不读取 settings、models 或 auth 文件。",
    ],
    parameters,
    outputSchema: Type.Array(Type.String()),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const models = listAvailableModels(ctx.modelRegistry);
      return createAvailableModelsResult(models);
    },
  }));
}
