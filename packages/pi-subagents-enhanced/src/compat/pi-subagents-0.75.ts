/**
 * upstream 兼容入口（文件名为历史命名，当前固定封装 `pi-subagents@0.80.0`）。
 *
 * 0.79.2 与 0.75.0 的公开 exports 集合一致：本文件只消费 root 注册、`./agents` 注册与
 * 本地 transcript 投影，不做深层 `pi-subagents/src/*` import。文件名与公开导出保持不变，
 * 以免破坏 `extensions/`、`scripts/verify-package.ts` 与 TUI renderer 的既有消费链；
 * upstream 版本仍由 `package.json`、`scripts/verify-package.ts` 与 Doctor 精确门禁。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { parseFrontmatter as hostParseFrontmatter } from "@earendil-works/pi-coding-agent";
import upstreamSubagentRuntime from "pi-subagents";
import { registerAgentViaEvents as registerPublicAgentViaEvents } from "pi-subagents/agents";
import type { RuntimeAgentDefinition, RuntimeAgentRegistration } from "pi-subagents/agents";
import * as fs from "node:fs";
import * as path from "node:path";

/** 0.71 root registration is the only upstream runtime surface used here (contract §2.1, index.d.ts:1-2). */
export function upstreamSubagentRuntimeForwarder(pi: ExtensionAPI): void {
  upstreamSubagentRuntime(pi);
}
export { upstreamSubagentRuntimeForwarder as upstreamSubagentRuntime };

export type SessionIdentity = { sessionId: string; sessionFile?: string; cwd?: string };
/** Session identity is projected from the Host session manager, not guessed from cwd (contract §4, rpc.js:298-305). */
export function readSessionIdentity(sessionManager: {
  getSessionId?(): string | null | undefined;
  getSessionFile?(): string | null | undefined;
  getCwd?(): string | null | undefined;
}): SessionIdentity {
  const sessionId = sessionManager.getSessionId?.();
  const sessionFile = sessionManager.getSessionFile?.();
  const cwd = sessionManager.getCwd?.();
  if (typeof sessionId !== "string" || !sessionId.trim()) throw new Error("Host session identity is unavailable");
  return {
    sessionId,
    ...(typeof sessionFile === "string" && sessionFile ? { sessionFile } : {}),
    ...(typeof cwd === "string" && cwd ? { cwd } : {}),
  };
}
export function resolveCurrentSessionId(sessionManager: Parameters<typeof readSessionIdentity>[0]): string {
  return readSessionIdentity(sessionManager).sessionId;
}

/** Public runtime agent registration; admission remains owned by the installed runtime (contract §2.8, agents.d.ts:1-5). */
export function registerAgentViaEvents(input: {
  pi: Pick<ExtensionAPI, "events">;
  name: string;
  definition: RuntimeAgentDefinition;
}): RuntimeAgentRegistration {
  return registerPublicAgentViaEvents(input);
}
export type { RuntimeAgentDefinition, RuntimeAgentRegistration };

export type BuiltinAdmissionAgent = {
  name: string;
  description: string;
  systemPrompt: string;
  models?: string[];
  model?: string;
  thinking?: string | false;
  tools?: string[];
  /** Host 公开 parser 保留的完整原始 frontmatter 解析对象（不含 YAML body/systemPrompt 正文）；仅供 tool list 元数据展示，dispatch 校验仍只认上方已识别字段。 */
  metadata: Record<string, unknown>;
};

/** 原始 frontmatter 元数据的防御性深拷贝：禁止让 list 消费方暴露 admission 缓存的可变引用。 */
function cloneFrontmatterMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(metadata);
}

/** 通过 Host 的公开 YAML 解析器读取准入元数据，避免把其他 YAML 列表误认成 models。 */
export function parseFrontmatter(source: string): BuiltinAdmissionAgent {
  let parsed: { frontmatter: Record<string, unknown>; body: string };
  try { parsed = hostParseFrontmatter<Record<string, unknown>>(source); } catch { throw new Error("Invalid agent profile"); }
  const frontmatter = parsed.frontmatter;
  const body = parsed.body.trim();
  const textField = (key: string): string | undefined => {
    if (!Object.hasOwn(frontmatter, key)) return undefined;
    const value = frontmatter[key];
    if (typeof value !== "string" || !value.trim()) throw new Error("Invalid agent profile");
    return value.trim();
  };
  const name = textField("name");
  const description = textField("description");
  if (!name || !description || !body) throw new Error("Invalid agent profile");
  const parseStringArray = (key: "models" | "tools"): string[] | undefined => {
    if (!Object.hasOwn(frontmatter, key)) return undefined;
    const value = frontmatter[key];
    if (key === "tools" && typeof value === "string") {
      const items = value.split(",").map((item) => item.trim());
      if (items.length === 0 || items.some((item) => !item)) throw new Error("Invalid agent profile");
      return items;
    }
    if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) {
      throw new Error("Invalid agent profile");
    }
    return key === "tools"
      ? value.flatMap((item) => (item as string).split(",").map((part) => part.trim())).filter(Boolean)
      : value.map((item) => (item as string).trim());
  };
  const models = parseStringArray("models");
  const tools = parseStringArray("tools");
  const rawModel = textField("model");
  let thinking: string | false | undefined;
  if (Object.hasOwn(frontmatter, "thinking")) {
    const value = frontmatter.thinking;
    if (value !== false && (typeof value !== "string" || !value.trim())) throw new Error("Invalid agent profile");
    thinking = value === false ? false : value.trim();
  }
  return {
    name,
    description,
    systemPrompt: body,
    ...(models ? { models } : {}),
    ...(rawModel ? { model: rawModel } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(tools ? { tools } : {}),
    // 完整原始 frontmatter（返回前深拷贝）：保留未识别字段与 false/数组/number 等原类型，供 list 元数据展示。
    metadata: cloneFrontmatterMetadata(frontmatter),
  };
}

function parseBuiltinAgent(filePath: string): BuiltinAdmissionAgent {
  try { return parseFrontmatter(fs.readFileSync(filePath, "utf8")); }
  catch { throw new Error(`Invalid agent profile: ${filePath}`); }
}

/**
 * Build the repository admission projection from the Host-declared profiles.
 * Admission intentionally does not observe runtime registration or scan the
 * dispatch cwd: custom/project agents are dispatched by upstream directly.
 */
export function registerBuiltinAgentsViaEvents(input: {
  pi: Pick<ExtensionAPI, "events">;
  agentDir: string;
}): { discoverAgents(cwd: string, scope: string, preferredProvider?: string, requestedName?: string): { agents: BuiltinAdmissionAgent[]; admission: "repository-configured" }; dispose(): void } {
  void input.pi;
  const agents = (["delegate", "executor", "reviewer"] as const).map((name) => parseBuiltinAgent(path.join(input.agentDir, "agents", `${name}.md`)));
  return {
    discoverAgents(_cwd, _scope, _preferredProvider, requestedName) {
      if (requestedName && !agents.some((agent) => agent.name === requestedName)) {
        const error = new Error("AGENT_ADMISSION_UNAVAILABLE");
        (error as Error & { code?: string }).code = "AGENT_ADMISSION_UNAVAILABLE";
        throw error;
      }
      if (process.env.T11B1_DEBUG === "1") console.error(`[admission-debug] discover requested=${String(requestedName)} agents=${agents.map((a) => a.name).join(",")}`);
      return {
        agents: agents.map((agent) => ({
          ...agent,
          ...(agent.models ? { models: [...agent.models] } : {}),
          ...(agent.tools ? { tools: [...agent.tools] } : {}),
          // metadata 每次调用深拷贝返回，不暴露 admission 缓存引用。
          metadata: cloneFrontmatterMetadata(agent.metadata),
        })),
        admission: "repository-configured" as const,
      };
    },
    dispose() { agents.splice(0); },
  };
}

export type FleetTranscriptEvent =
  | { kind: "assistant"; text: string; model?: string; timestamp?: number }
  | { kind: "user"; text: string; timestamp?: number }
  | { kind: "tool"; toolCallId?: string; name: string; args?: string; argsPayload?: string; output?: string; outputTruncated?: boolean; status: "running" | "complete" | "error"; error?: string; startedAt?: number; endedAt?: number; timestamp?: number }
  | { kind: "notice"; text: string; tone: "muted" | "warning" | "error"; timestamp?: number };
export interface FleetTranscript {
  path: string;
  events: FleetTranscriptEvent[];
  truncated: boolean;
  warning?: string;
}
export interface FleetTranscriptReadOptions {
  trustedRoots: string[];
  trustedFiles?: string[];
  trustedFileRoot?: string;
  maxRecords?: number;
  maxBytes?: number;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}
function safeText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
function transcriptEvent(record: Record<string, unknown>): FleetTranscriptEvent | undefined {
  const role = safeText(record.role);
  const text = safeText(record.text) ?? safeText(record.content);
  const timestamp = typeof record.timestamp === "number" ? record.timestamp : undefined;
  if ((role === "assistant" || role === "user") && text) return { kind: role, text, ...(timestamp === undefined ? {} : { timestamp }) };
  if (role === "tool" || record.type === "toolResult") {
    const name = safeText(record.name) ?? safeText(record.toolName) ?? "tool";
    const output = safeText(record.output) ?? safeText(record.result);
    const status = record.isError === true ? "error" : record.status === "running" ? "running" : "complete";
    return { kind: "tool", name, status, ...(output ? { output } : {}), ...(timestamp === undefined ? {} : { timestamp }) };
  }
  if (text) return { kind: "notice", text, tone: "muted", ...(timestamp === undefined ? {} : { timestamp }) };
  return undefined;
}

/** Display-only transcript facade. It never reads or writes process/artifact authority (contract §2.7, §3). */
export function readFleetTranscript(filePath: string, options: FleetTranscriptReadOptions): FleetTranscript {
  let resolved: string;
  try {
    resolved = fs.realpathSync(filePath);
    const roots = options.trustedRoots.flatMap((root) => { try { return [fs.realpathSync(root)]; } catch { return []; } });
    if (!roots.some((root) => inside(root, resolved))) return { path: filePath, events: [], truncated: false, warning: "Transcript is outside trusted roots." };
    const stat = fs.statSync(resolved);
    const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
    if (!stat.isFile() || stat.size > maxBytes) return { path: filePath, events: [], truncated: false, warning: "Transcript is unavailable or too large." };
  } catch { return { path: filePath, events: [], truncated: false, warning: "Transcript is unavailable." }; }
  const maxRecords = Math.max(1, options.maxRecords ?? 10_000);
  const lines = fs.readFileSync(resolved, "utf8").split(/\r?\n/).filter(Boolean);
  const selected = lines.slice(-maxRecords);
  const events: FleetTranscriptEvent[] = [];
  let malformed = 0;
  for (const line of selected) {
    try { const event = transcriptEvent(JSON.parse(line)); if (event) events.push(event); else malformed++; } catch { malformed++; }
  }
  const omitted = lines.length > selected.length;
  return { path: filePath, events, truncated: omitted, ...(malformed ? { warning: `Skipped ${malformed} malformed transcript record${malformed === 1 ? "" : "s"}.` } : {}) };
}

function plainTheme(theme: ExtensionContext["ui"]["theme"]): any { return theme; }
export function renderFleetTranscript(transcript: FleetTranscript, width: number, theme: ExtensionContext["ui"]["theme"], _markdownTheme: MarkdownTheme, options: { expandedTools?: boolean } = {}): string[] {
  if (width <= 0) return [];
  const lines: string[] = [];
  if (transcript.truncated) lines.push(theme.fg("dim", "↑ Earlier activity omitted").slice(0, width));
  if (transcript.warning) lines.push(theme.fg("warning", `! ${transcript.warning}`).slice(0, width));
  for (const event of transcript.events) {
    if (event.kind === "assistant") lines.push(`${theme.fg("accent", "◆")} Assistant: ${event.text}`.slice(0, width));
    else if (event.kind === "user") lines.push(`${theme.fg("warning", "◇")} Supervisor: ${event.text}`.slice(0, width));
    else if (event.kind === "notice") lines.push(`${theme.fg(event.tone, "│")} ${event.text}`.slice(0, width));
    else {
      const mark = event.status === "error" ? "✗" : event.status === "running" ? "●" : "✓";
      lines.push(`${mark} ${event.name}${event.args ? ` ${event.args}` : ""}`.slice(0, width));
      if (options.expandedTools && (event.output || event.error)) lines.push(`  ${event.output ?? event.error}`.slice(0, width));
    }
  }
  return lines;
}
void plainTheme;
