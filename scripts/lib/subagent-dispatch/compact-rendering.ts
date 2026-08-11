import { PRESENTATION_GLYPH, type SubagentPresentationStatus } from "./presentation-status.ts";

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

export function formatCompactSubagentToolResult(result: unknown, args: unknown) {
  const text = textContent(result);
  if (record(args)?.action !== "status") return text;
  if (record(result)?.isError === true) return "Status: error";
  const state = text.match(/^State:\s*(.+?)\s*$/im)?.[1];
  if (state) return `Status: ${state}`;
  const active = text.match(/^Active async runs:\s*(\d+)\s*$/im)?.[1];
  if (active) return `Status: ${active} active`;
  if (/^No active async runs\.\s*$/im.test(text)) return "Status: idle";
  return "Status: unknown";
}
