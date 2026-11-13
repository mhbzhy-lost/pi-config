import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { guidance } from "./docs.ts";
import { requestSearch } from "./providers.ts";

const MAX_QUERY_CHARS = 128;
const MAX_FETCH_URL_CHARS = 8192;
const DEFAULT_COUNT = 10;

const parameters = Type.Object({
  action: Type.Union([Type.Literal("search"), Type.Literal("fetch")], { description: "联网搜索或抓取单个网页" }),
  query: Type.Optional(Type.String({ description: "搜索关键词；action=search 时必填，支持 site:/lang:/after: 等检索算子" })),
  url: Type.Optional(Type.String({ description: "网页 URL；action=fetch 时必填，仅支持 http/https" })),
  count: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "搜索结果数量，默认 10" })),
  needContent: Type.Optional(Type.Boolean({ description: "搜索时是否让服务端同时填充结果正文" })),
}, { additionalProperties: false });

function validateQuery(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("query 不能为空");
  if ([...value].length > MAX_QUERY_CHARS) throw new Error(`query 最多 ${MAX_QUERY_CHARS} 个 Unicode 字符`);
  return value;
}

function validateUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_FETCH_URL_CHARS) throw new Error("url 格式无效或过长");
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || /\s/.test(value)) throw new Error();
  } catch { throw new Error("url 必须是没有 userinfo 的 http/https URL"); }
  return value;
}

export const searchTool = defineTool({
  name: "search",
  label: "search",
  description: `使用 DeepSeek 官方 Search/Fetch API 搜索最新网页信息或抓取单个 URL。返回服务端原始结构化 JSON，不替代引用、不改写摘要；action=search 传 query，action=fetch 传 url。

以下是该工具的完整使用说明；实际调用请使用本工具的 action/参数：

${guidance}`,
  promptSnippet: "搜索网页或抓取指定 URL（按需加载）",
  promptGuidelines: [
    "需要联网获取最新信息、新闻、事实或技术文档时使用 search；不要用模型记忆替代联网搜索。完整规则见工具描述中的 DeepSeek 文档。",
    "先用 action=search 获取候选 URL，正文不足时再用 action=fetch 抓取单个 URL；引用使用返回结果中的 URL。",
    "默认先调用 DeepSeek；DeepSeek 不可用时自动尝试 Exa fallback。两者都失败时报告两个脱敏错误类别，不把 key、响应原文或请求内容写入错误。",
  ],
  parameters,
  exposure: "deferred",
  defaultActive: false,
  async execute(_toolCallId, input) {
    const action = input.action;
    const payload = action === "search"
      ? { query: validateQuery(input.query), count: input.count ?? DEFAULT_COUNT, ...(input.needContent === true ? { need_content: true } : {}) }
      : { url: validateUrl(input.url) };
    const result = await requestSearch(action, payload);
    return {
      content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
      structuredContent: result.data as any,
      details: { provider: result.provider, fallback: result.fallback, action },
    };
  },
});
