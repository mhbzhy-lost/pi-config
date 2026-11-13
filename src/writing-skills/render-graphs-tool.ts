import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { renderGraphs } from "./runtime/render-graphs.ts";

const parameters = Type.Object({
  markdownFile: Type.String({ description: "包含 ```dot 代码块的 Markdown 文件路径" }),
  combine: Type.Optional(Type.Boolean({ description: "是否将全部图合并为一个 SVG" })),
}, { additionalProperties: false });

export const renderGraphsTool = defineTool({
  name: "render_graphs",
  label: "render_graphs",
  description: "从指定 Markdown 文件提取 Graphviz dot 代码块，调用系统 Graphviz 生成 SVG 文件。该工具会在 Markdown 同目录下创建 diagrams 子目录并写入产物。",
  promptSnippet: "将 Markdown 中的 Graphviz 图渲染为 SVG",
  promptGuidelines: [
    "使用 render_graphs 前确认输入 Markdown 路径和写入 diagrams 目录的副作用符合任务范围。",
    "render_graphs 只报告实际生成的文件，不把 Graphviz 渲染成功等同于图示语义正确。",
  ],
  parameters,
  exposure: "deferred",
  defaultActive: false,
  async execute(_toolCallId, input) {
    const result = renderGraphs(input.markdownFile, input.combine === true);
    return {
      content: [{ type: "text", text: result.files.length
        ? `已生成 ${result.files.length} 个文件：\n${result.files.join("\n")}`
        : `未找到 dot 代码块；输出目录：${result.outputDir}` }],
      details: result,
    };
  },
});
