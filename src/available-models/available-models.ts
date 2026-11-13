import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAvailableModelsResult, listAvailableModels } from "./index.ts";
import { createAvailableModelsRenderer } from "./renderer.ts";

const parameters = Type.Object({}, { required: [] });

export default function availableModels(pi: ExtensionAPI) {
  pi.registerToolRenderer(createAvailableModelsRenderer());
  pi.registerTool(defineTool({
    name: "list_available_models",
    label: "list_available_models",
    description: "列出当前 Host registry 中可用的 chat models；仅返回 provider/model 名称，不读取或暴露凭据。此目录不等同于 subagent policy 或当前 enabled scope。",
    promptSnippet: "列出当前 registry 可用的 chat models。",
    promptGuidelines: [
      "使用 list_available_models 了解当前 Host registry 中可用的 chat model 目录；结果不代表 subagent policy 或当前 enabled scope。",
      "list_available_models 只读取当前 registry snapshot，不刷新模型、不联网，也不读取 settings、models 或 auth 文件。",
    ],
    parameters,
    outputSchema: Type.Array(Type.String()),
    exposure: "deferred",
    defaultActive: false,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const models = listAvailableModels(ctx.modelRegistry);
      return createAvailableModelsResult(models);
    },
  }));
}
