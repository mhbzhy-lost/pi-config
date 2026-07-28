const NOTIFICATION_STATUS = /^(?:Background tasks?|Detached foreground task) (completed|failed|paused)\b/;
const STATUS_GLYPH = Object.freeze({
  completed: "✓",
  failed: "✗",
  paused: "Ⅱ",
});

function record(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function textContent(value) {
  const input = record(value);
  if (!Array.isArray(input?.content)) return "";
  return input.content
    .filter((part) => record(part)?.type === "text")
    .map((part) => String(record(part)?.text ?? ""))
    .join("\n");
}

function notificationTitles(message, firstLine) {
  const details = record(record(message)?.details);
  const structured = Array.isArray(details?.titles)
    ? details.titles.filter((title) => typeof title === "string" && title.trim()).map((title) => title.trim())
    : [];
  if (structured.length > 0) return structured;

  const titled = [...firstLine.matchAll(/\[([^\]\r\n]+)\]/g)]
    .map((match) => match[1]?.trim())
    .filter(Boolean);
  if (titled.length > 0) return titled;

  return [...firstLine.matchAll(/\*\*([^*\r\n]+)\*\*/g)]
    .map((match) => match[1]?.trim())
    .filter(Boolean);
}

export function formatCompactSubagentNotification(message) {
  const content = typeof record(message)?.content === "string" ? message.content : "";
  const firstLine = content.split(/\r?\n/, 1)[0] ?? "";
  const status = firstLine.match(NOTIFICATION_STATUS)?.[1] ?? "unknown";
  const glyph = STATUS_GLYPH[status] ?? "?";
  const titles = notificationTitles(message, firstLine);
  const labels = titles.length > 0 ? titles : ["subagent"];
  return labels.map((title) => `${glyph} ${title} · ${status}`).join("\n");
}

export function formatCompactSubagentToolResult(result, args) {
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
