import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createContextUsageToolResult,
  ContextUsageOutputSchema,
} from "./snapshot.ts";
import { createContextUsageRenderer } from "./renderer.ts";

export default function contextUsageExtension(pi: ExtensionAPI) {
  pi.registerToolRenderer(createContextUsageRenderer());
  pi.registerTool(defineTool({
    name: "context_usage",
    label: "context_usage",
    description:
      "读取当前上下文窗口使用量、剩余量和估计状态；结果是估计值，不代表 provider 的精确计费或 token 统计。",
    promptSnippet: "读取当前上下文窗口估计量及剩余量。",
    promptGuidelines: ["使用 context_usage 判断当前上下文余量；结果是估计值，unknown 不代表余量充足。"],
    parameters: Type.Object({}, { additionalProperties: false }),
    outputSchema: ContextUsageOutputSchema,
    exposure: "deferred",
    defaultActive: false,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      return createContextUsageToolResult(ctx.getContextUsage?.());
    },
  }));

}
