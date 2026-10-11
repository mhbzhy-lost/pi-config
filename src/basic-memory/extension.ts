import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";

const MAX_OUTPUT_BYTES = 50 * 1024;

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/,
  /(?:api[_-]?key|apikey)\s*[=:]\s*\S{8,}/i,
  /(?:^|\s)sk-[A-Za-z0-9_\-]{16,}/,
  /(?:password|passwd)\s*[=:]\s*\S{6,}/i,
  /Bearer\s+[A-Za-z0-9._\-]{20,}/,
  /(?:token|secret)\s*[=:]\s*\S{12,}/i,
  /ghp_[A-Za-z0-9]{36,}/,
  /gho_[A-Za-z0-9]{36,}/,
  /glpat-[A-Za-z0-9\-_]{20,}/,
];

export function containsLikelySecret(text: string) {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

type ProjectParams = { project?: string };
type QueryParams = ProjectParams & { query: string };
type ReadParams = ProjectParams & { identifier: string };
type WriteParams = ProjectParams & { title: string; folder: string; content: string };

const COMMANDS = {
  memory_search: (p: QueryParams) => ["tool", "search-notes", p.query, "--local", ...(p.project ? ["--project", p.project] : [])],
  memory_read: (p: ReadParams) => ["tool", "read-note", p.identifier, "--local", ...(p.project ? ["--project", p.project] : [])],
  memory_context: (p: QueryParams) => ["tool", "build-context", p.query, "--local", ...(p.project ? ["--project", p.project] : [])],
  memory_recent: (p: ProjectParams) => ["tool", "recent-activity", "--local", ...(p.project ? ["--project", p.project] : [])],
  memory_write: (p: WriteParams) => ["tool", "write-note", "--title", p.title, "--folder", p.folder, "--content", p.content, "--local", ...(p.project ? ["--project", p.project] : [])],
};

function truncate(output: string) {
  if (Buffer.byteLength(output, "utf8") <= MAX_OUTPUT_BYTES) return output;
  const buf = Buffer.from(output, "utf8").subarray(0, MAX_OUTPUT_BYTES);
  // 安全解码，替换被截断的多字节尾部。
  const truncated = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  return `${truncated}\n\n[truncated: output exceeded ${MAX_OUTPUT_BYTES} bytes]`;
}

export function createBasicMemoryExtension(pi: ExtensionAPI) {
  function registerMemoryTool<TParams extends TSchema>(
    def: Omit<ToolDefinition<TParams, Record<string, never>>, "execute">,
    commandBuilder: (params: Static<TParams>) => string[],
    validate?: (params: Static<TParams>) => void,
  ) {
    pi.registerTool(defineTool({
      ...def,
      async execute(_toolCallId, params, signal) {
        validate?.(params);
        const args = commandBuilder(params);
        const result = await pi.exec("basic-memory", args, { timeout: 30000, signal });
        if (result.code !== 0) {
          throw new Error(result.stderr || `basic-memory exited with code ${result.code}`);
        }
        return {
          content: [{ type: "text", text: truncate(result.stdout) }],
          details: {},
        };
      },
    }));
  }

  registerMemoryTool({
    name: "memory_search",
    label: "搜索持久笔记",
    description: "搜索本地持久存储笔记（不得写入凭据或秘密）",
    promptSnippet: "搜索本地持久笔记。",
    promptGuidelines: ["需要按主题查找已有持久笔记时使用 memory_search。"],
    parameters: Type.Object({ query: Type.String(), project: Type.Optional(Type.String()) }),
  }, COMMANDS.memory_search);
  registerMemoryTool({
    name: "memory_read",
    label: "读取持久笔记",
    description: "读取本地持久存储中指定笔记（不得写入凭据或秘密）",
    promptSnippet: "读取指定的本地持久笔记。",
    promptGuidelines: ["已知笔记标识、需要查看完整正文时使用 memory_read。"],
    parameters: Type.Object({ identifier: Type.String(), project: Type.Optional(Type.String()) }),
  }, COMMANDS.memory_read);
  registerMemoryTool({
    name: "memory_context",
    label: "构建笔记上下文",
    description: "构建本地持久存储上下文（不得写入凭据或秘密）",
    promptSnippet: "按主题构建相关持久笔记上下文。",
    promptGuidelines: ["需要围绕主题汇集相关笔记上下文时使用 memory_context。"],
    parameters: Type.Object({ query: Type.String(), project: Type.Optional(Type.String()) }),
  }, COMMANDS.memory_context);
  registerMemoryTool({
    name: "memory_recent",
    label: "查看笔记近期活动",
    description: "获取本地持久存储最近活动（不得写入凭据或秘密）",
    promptSnippet: "查看本地持久笔记的近期活动。",
    promptGuidelines: ["需要了解最近的笔记变动时使用 memory_recent。"],
    parameters: Type.Object({ project: Type.Optional(Type.String()) }, { required: [] }),
  }, COMMANDS.memory_recent);
  registerMemoryTool({
    name: "memory_write",
    label: "写入持久笔记",
    description: "写入本地持久存储笔记（不得写入凭据或秘密）",
    promptSnippet: "保存可复用结论为本地持久笔记。",
    promptGuidelines: ["需要长期复用的结论可用 memory_write 保存；不得写入凭据或秘密。"],
    parameters: Type.Object({ title: Type.String(), folder: Type.String(), content: Type.String(), project: Type.Optional(Type.String()) }),
  }, COMMANDS.memory_write, (params) => {
    if (containsLikelySecret(params.content)) {
      throw new Error("禁止将凭据或秘密 (secret) 写入持久存储");
    }
  });
}

export default createBasicMemoryExtension;
