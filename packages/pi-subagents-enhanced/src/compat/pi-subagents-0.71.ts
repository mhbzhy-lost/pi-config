import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
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

type BuiltinAdmissionAgent = {
  name: string;
  description: string;
  systemPrompt: string;
  models?: string[];
  model?: string;
  thinking?: string | false;
};

function parseBuiltinAgent(filePath: string): BuiltinAdmissionAgent {
  const source = fs.readFileSync(filePath, "utf8");
  const match = source.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error(`Invalid agent profile: ${filePath}`);
  const frontmatter = match[1];
  const body = match[2].trim();
  const name = frontmatter.match(/^name:\s*(\S+)\s*$/m)?.[1];
  const description = frontmatter.match(/^description:\s*(.*)$/m)?.[1]?.trim();
  const thinking = frontmatter.match(/^thinking:\s*(.*)$/m)?.[1]?.trim();
  const models = [...frontmatter.matchAll(/^  -\s+(.+)$/gm)].map((entry) => entry[1].trim());
  if (!name || !description || !body) throw new Error(`Invalid agent profile: ${filePath}`);
  return {
    name,
    description,
    systemPrompt: body,
    ...(models.length ? { models } : {}),
    ...(thinking ? { thinking } : {}),
  };
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
      return { agents: agents.map((agent) => ({ ...agent, models: agent.models ? [...agent.models] : undefined })), admission: "repository-configured" as const };
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
