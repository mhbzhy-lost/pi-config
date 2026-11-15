import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
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
  description: `联网搜索最新网页信息或抓取单个网页正文。需要查新闻、事实、技术文档或核实资料时使用；action=search 传 query 获取候选结果，action=fetch 传 url 抓取单页 Markdown 正文。

返回供应商原始结构化 JSON，不改写摘要、不制造引用：search 结果在 results[]（title/url/snippet/summary 等），引用一律使用 results[].url；needContent: true 时服务端同时填充结果正文；results 为空数组表示无匹配，不要编造结果。fetch 的 content 是目标网页正文（Exa fallback 时上限约 3000 字符、可能截断），与已有知识冲突时以原文为准。

默认先调用 DeepSeek，不可用时自动 Exa fallback，details 标记实际 provider 与是否 fallback；两者都失败时只报告脱敏错误类别。需要 DEEPSEEK_API_KEY（进程环境变量或 src/search/.env；Exa fallback 同理用 EXA_API_KEY），缺失时在发请求前直接失败；key 只进认证请求头，严禁打印。`,
  promptSnippet: "联网搜索网页信息或抓取指定 URL 正文",
  promptGuidelines: [
    "需要联网获取最新信息、新闻、事实或技术文档时使用 search；不要用模型记忆替代联网搜索，也不要用 curl/wget 抓网页查资料。",
    "先用 search 的 action=search 获取候选 URL，正文不足时再用 action=fetch 抓取单个 URL；引用使用返回结果中的 URL。",
    "search 默认先调用 DeepSeek；DeepSeek 不可用时自动尝试 Exa fallback。两者都失败时报告两个脱敏错误类别，不把 key、响应原文或请求内容写入错误。",
  ],
  parameters,
  exposure: "direct",
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
