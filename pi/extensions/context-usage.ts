import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createContextUsageToolResult,
  ContextUsageOutputSchema,
} from "../../src/context-usage/snapshot.ts";

export default function contextUsageExtension(pi: ExtensionAPI) {
  pi.registerTool(defineTool({
    name: "context_usage",
    label: "context_usage",
    description:
      "读取当前上下文窗口使用量估计。",
    promptSnippet: "读取当前上下文窗口估计量及剩余量。",
    promptGuidelines: ["需要判断当前上下文余量时使用 context_usage；结果是估计值，unknown 不代表余量充足。"],
    parameters: Type.Object({}, { additionalProperties: false }),
    outputSchema: ContextUsageOutputSchema,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      return createContextUsageToolResult(ctx.getContextUsage?.());
    },
  }));

}
