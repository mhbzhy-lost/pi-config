import { PRESENTATION_GLYPH, type SubagentPresentationStatus } from "../subagent-dispatch/presentation-status.ts";
import { getTitleRegistry } from "../subagent-dispatch/title-registry.ts";

const NOTIFICATION_STATUS = /^(?:Background tasks?|Detached foreground task) (completed|failed|paused|stopped)\b/;

function record(value: unknown): Record<string, unknown> | undefined {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function textContent(value: unknown) {
  const input = record(value);
  if (!Array.isArray(input?.content)) return "";
  return input.content
    .filter((part) => record(part)?.type === "text")
    .map((part) => String(record(part)?.text ?? ""))
    .join("\n");
}

function notificationTitles(message: unknown, firstLine: string) {
  const details = record(record(message)?.details);
  const structured = Array.isArray(details?.titles)
    ? details.titles.filter((title): title is string => typeof title === "string" && title.trim()).map((title) => title.trim())
    : [];
  if (structured.length > 0) return structured;
  const titled = [...firstLine.matchAll(/\[([^\]\r\n]+)\]/g)].map((match) => match[1]?.trim()).filter(Boolean) as string[];
  if (titled.length > 0) return titled;
  return [...firstLine.matchAll(/\*\*([^*\r\n]+)\*\*/g)].map((match) => match[1]?.trim()).filter(Boolean) as string[];
}

function presentations(message: unknown): SubagentPresentationStatus[] {
  const values = record(record(message)?.details)?.presentations;
  return Array.isArray(values) ? values.filter((value): value is SubagentPresentationStatus => typeof value === "string" && value in PRESENTATION_GLYPH) : [];
}

export function formatCompactSubagentNotification(message: unknown) {
  const content = typeof record(message)?.content === "string" ? record(message)!.content as string : "";
  const firstLine = content.split(/\r?\n/, 1)[0] ?? "";
  const rawStatus = firstLine.match(NOTIFICATION_STATUS)?.[1] ?? "unknown";
  const titles = notificationTitles(message, firstLine);
  const labels = titles.length > 0 ? titles : ["subagent"];
  const states = presentations(message);
  return labels.map((title, index) => {
    const state = states[index];
    return state ? `${PRESENTATION_GLYPH[state]} ${title} · ${state}` : `${rawStatus === "completed" ? "✓" : rawStatus === "paused" ? "Ⅱ" : rawStatus === "stopped" ? "■" : rawStatus === "failed" ? "◇" : "?"} ${title} · ${rawStatus === "failed" ? "reported" : rawStatus}`;
  }).join("\n");
}

export function formatCompactSubagentSpawnSummary(result: unknown): string | undefined {
  const value = record(result);
  const details = record(value?.details);
  const agent = typeof details?.agent === "string" ? details.agent.trim() : "";
  const title = typeof details?.title === "string" ? details.title.trim() : "";
  if (!agent || !title) return undefined;
  return `* subagent ${value?.isError === true ? "failed" : "started"} ${agent}: ${title}`;
}

export function formatCompactSubagentSteerResult(result: unknown, args: unknown): string {
  const input = record(args);
  const details = record(record(result)?.details);
  const runId = typeof input?.id === "string" && input.id.trim()
    ? input.id.trim()
    : typeof details?.runId === "string" && details.runId.trim() ? details.runId.trim() : "";
  const title = runId ? getTitleRegistry().titleFor(runId) : undefined;
  const agent = typeof details?.agent === "string" && details.agent.trim() ? details.agent.trim() : undefined;
  const target = title ?? agent ?? (runId ? `run: ${runId}` : "subagent");
  const message = typeof input?.message === "string" ? input.message : "";
  return `→ ${target}：${message}`;
}

export function formatCompactSupervisorRequest(message: unknown): string {
  const value = record(message);
  const details = record(value?.details);
  const content = typeof value?.content === "string" ? value.content : "";
  const agent = typeof value?.agent === "string" && value.agent.trim()
    ? value.agent.trim()
    : typeof details?.agent === "string" && details.agent.trim()
    ? details.agent.trim()
    : typeof details?.targetAgent === "string" && details.targetAgent.trim()
      ? details.targetAgent.trim()
      : "subagent";
  const body = content
    .split(/\r?\n/)
    .filter((line) => !/^(?:Subagent (?:progress update|needs attention|needs a supervisor decision)\.?|Supervisor (?:progress update|request|needs decision)\.?|Agent|Run|Child index|Child intercom target|Intercom target|Supervisor request|Request id):?\s*/i.test(line.trim()))
    .join("\n")
    .trim();
  return `← ${agent}:\n${body}`;
}

export function formatCompactSubagentToolResult(result: unknown, args: unknown) {
  const text = textContent(result);
  if (record(args)?.action === "steer") return formatCompactSubagentSteerResult(result, args);
  if (record(args)?.action !== "status") {
    if (/^Validation failed for tool "subagent":\s*$/m.test(text.split(/\r?\n/, 1)[0] ?? "")) {
      return text.split(/^Received arguments:\s*$/m, 1)[0].trimEnd();
    }
    return text;
  }
  const details = record(record(result)?.details);
  const requestedId = typeof record(args)?.id === "string" ? record(args).id.trim() : "";
  const reportedId = text.match(/^Run:\s*(\S+)\s*$/im)?.[1] ?? "";
  const runId = typeof details?.runId === "string" && details.runId.trim()
    ? details.runId.trim()
    : requestedId || reportedId;
  const title = runId ? getTitleRegistry().titleFor(runId) : undefined;
  const suffix = title ? ` · ${title}` : runId ? ` · run: ${runId}` : "";
  if (record(result)?.isError === true) return `Status: error${suffix}`;
  const state = text.match(/^State:\s*(.+?)\s*$/im)?.[1];
  if (state) return `Status: ${state}${suffix}`;
  const active = text.match(/^Active async runs:\s*(\d+)\s*$/im)?.[1];
  if (active) return `Status: ${active} active`;
  if (/^No active async runs\.\s*$/im.test(text)) return "Status: idle";
  return "Status: unknown";
}
