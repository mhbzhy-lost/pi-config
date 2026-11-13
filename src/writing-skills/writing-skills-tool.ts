import { readFile } from "node:fs/promises";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { guidance } from "./docs.ts";

const topicPaths = {
  guide: "./docs/guide.md",
  bestPractices: "./docs/anthropic-best-practices.md",
  persuasion: "./docs/persuasion-principles.md",
  testing: "./docs/testing-skills-with-subagents.md",
  graphviz: "./docs/graphviz-conventions.dot",
  example: "./docs/CLAUDE_MD_TESTING.md",
} as const;

const parameters = Type.Object({
  action: Type.Literal("read", { description: "读取内化的写作指导文档" }),
  topic: Type.Union([
    Type.Literal("guide"),
    Type.Literal("bestPractices"),
    Type.Literal("persuasion"),
    Type.Literal("testing"),
    Type.Literal("graphviz"),
    Type.Literal("example"),
  ], { description: "固定文档主题；不接受任意文件路径" }),
}, { additionalProperties: false });

export const writingSkillsTool = defineTool({
  name: "writing_skills",
  label: "writing_skills",
  description: `提供编写、维护和审阅高质量操作说明的内化指导。不修改任意文件；需要详细参考资料时使用 action=read 读取固定主题。可用主题：guide（总指南）、bestPractices（Anthropic 最佳实践）、persuasion（说服原则）、testing（使用子代理测试 Skill）、graphviz（Graphviz 约定）、example（CLAUDE.md 测试示例）。\n\n${guidance}`,
  promptSnippet: "按主题读取写作指导：guide、bestPractices、persuasion、testing、graphviz、example",
  promptGuidelines: [
    "使用 writing_skills 前先明确目标、触发条件、输入输出、权限边界、停止条件和验证方法，再组织正文。",
    "writing_skills 只提供指导，不会自动新增测试、调用真实 provider 或派发子代理；这些行为仍需具体授权。",
    "使用 writing_skills 时引用资料必须使用真实路径和当前实现，不把推测或第三方说明升级成项目事实。",
  ],
  parameters,
  exposure: "deferred",
  defaultActive: false,
  async execute(_toolCallId, input) {
    const path = topicPaths[input.topic as keyof typeof topicPaths];
    const content = await readFile(new URL(path, import.meta.url), "utf8");
    return {
      content: [{ type: "text", text: content }],
      details: { topic: input.topic, source: path },
    };
  },
});
