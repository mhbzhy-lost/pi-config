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

export function containsLikelySecret(text) {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

const COMMANDS = {
  memory_search: (p) => ["tool", "search-notes", p.query, "--local", ...(p.project ? ["--project", p.project] : [])],
  memory_read: (p) => ["tool", "read-note", p.identifier, "--local", ...(p.project ? ["--project", p.project] : [])],
  memory_context: (p) => ["tool", "build-context", p.query, "--local", ...(p.project ? ["--project", p.project] : [])],
  memory_recent: (p) => ["tool", "recent-activity", "--local", ...(p.project ? ["--project", p.project] : [])],
  memory_write: (p) => ["tool", "write-note", "--title", p.title, "--folder", p.folder, "--content", p.content, "--local", ...(p.project ? ["--project", p.project] : [])],
};

function truncate(output) {
  if (Buffer.byteLength(output, "utf8") <= MAX_OUTPUT_BYTES) return output;
  const truncated = output.slice(0, MAX_OUTPUT_BYTES);
  return `${truncated}\n\n[truncated: output exceeded ${MAX_OUTPUT_BYTES} bytes]`;
}

export function createBasicMemoryExtension(pi) {
  const TOOL_DEFS = [
    {
      name: "memory_search",
      description: "搜索本地持久存储笔记（不得写入凭据或秘密）",
      parameters: { type: "object", properties: { query: { type: "string" }, project: { type: "string" } }, required: ["query"] },
    },
    {
      name: "memory_read",
      description: "读取本地持久存储中指定笔记（不得写入凭据或秘密）",
      parameters: { type: "object", properties: { identifier: { type: "string" }, project: { type: "string" } }, required: ["identifier"] },
    },
    {
      name: "memory_context",
      description: "构建本地持久存储上下文（不得写入凭据或秘密）",
      parameters: { type: "object", properties: { query: { type: "string" }, project: { type: "string" } }, required: ["query"] },
    },
    {
      name: "memory_recent",
      description: "获取本地持久存储最近活动（不得写入凭据或秘密）",
      parameters: { type: "object", properties: { project: { type: "string" } }, required: [] },
    },
    {
      name: "memory_write",
      description: "写入本地持久存储笔记（不得写入凭据或秘密）",
      parameters: { type: "object", properties: { title: { type: "string" }, folder: { type: "string" }, content: { type: "string" }, project: { type: "string" } }, required: ["title", "folder", "content"] },
    },
  ];

  for (const def of TOOL_DEFS) {
    const commandBuilder = COMMANDS[def.name];
    pi.registerTool({
      ...def,
      async handler(params) {
        if (def.name === "memory_write" && containsLikelySecret(params.content)) {
          throw new Error("禁止将凭据或秘密 (secret) 写入持久存储");
        }
        const args = commandBuilder(params);
        const result = await pi.exec("basic-memory", args, { timeout: 30000 });
        if (result.code !== 0) {
          throw new Error(result.stderr || `basic-memory exited with code ${result.code}`);
        }
        return truncate(result.stdout);
      },
    });
  }
}

export default createBasicMemoryExtension;
