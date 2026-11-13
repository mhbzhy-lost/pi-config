export type StandardReceipt = {
  toolTitle: string;
  id?: unknown;
  preview?: unknown;
  outcome: unknown;
  exitCode?: unknown;
  elapsedMs?: unknown;
  failureReason?: unknown;
};

export type FormattedReceipt = { text: string; failed: boolean };

const SUCCESS_OUTCOMES = new Set(["succeeded", "success", "completed", "complete"]);

function shortId(value: unknown): string {
  return typeof value === "string" && value ? value.slice(0, 8) : "";
}

function flatPreview(value: unknown, truncate: (text: string, width: number, ellipsis?: string) => string): string {
  if (typeof value !== "string") return "";
  const flat = value.replace(/\s+/g, " ").trim();
  return flat ? truncate(flat, 64, "…") : "";
}

function elapsed(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "";
  if (value < 1_000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${Number((value / 1_000).toFixed(1))}s`;
  const seconds = Math.round(value / 1_000);
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

export function formatStandardReceipt(
  receipt: StandardReceipt,
  truncate: (text: string, width: number, ellipsis?: string) => string,
): FormattedReceipt {
  const outcome = typeof receipt.outcome === "string" && receipt.outcome.trim()
    ? receipt.outcome.trim()
    : "unknown";
  const failed = !SUCCESS_OUTCOMES.has(outcome);
  const segments = [
    [receipt.toolTitle, shortId(receipt.id)].filter(Boolean).join(" "),
    flatPreview(receipt.preview, truncate),
    outcome,
  ].filter(Boolean);
  if (typeof receipt.exitCode === "number") segments.push(`exit ${receipt.exitCode}`);
  const duration = elapsed(receipt.elapsedMs);
  if (duration) segments.push(duration);
  const lines = [`${failed ? "✗" : "✓"} ${segments.join(" · ")}`];
  if (failed && typeof receipt.failureReason === "string" && receipt.failureReason.trim()) {
    lines.push(`error: ${truncate(receipt.failureReason.trim().split(/\r?\n/)[0]!, 64, "…")}`);
  }
  return { text: lines.join("\n"), failed };
}
